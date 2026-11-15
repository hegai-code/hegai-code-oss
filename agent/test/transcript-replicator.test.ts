import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentToCentral, HistoryMessage, SessionReplicaState, SessionSummary } from '@cc-remote/shared';
import { replicaStamp } from '../src/history.js';
import { CLAUDE_TRANSCRIPT_MAX_BYTES } from '../src/history.js';
import {
  TranscriptReplicator,
  replicaCursor,
  type ReplicatorHost,
  type TranscriptReaders,
} from '../src/transcript-replicator.js';

type Frame = Extract<AgentToCentral, { type: 'session_sync_begin' | 'session_sync_chunk' | 'session_sync_commit' }>;

const msg = (n: number): HistoryMessage =>
  ({ uuid: `m${n}`, type: n % 2 ? 'assistant' : 'user', blocks: [{ kind: 'text', text: `message ${n}` }] }) as HistoryMessage;
const transcript = (count: number): HistoryMessage[] => Array.from({ length: count }, (_, i) => msg(i));

const session = (sessionId: string, mtime: number, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ sessionId, title: sessionId, cwd: '/home/dev/proj', lastModified: mtime, ...extra }) as SessionSummary;

const FAST = { passMinMs: 5, yieldMs: 0, ackTimeoutMs: 300 };

/**
 * A hub that keeps what it is sent and acknowledges every commit, the way
 * `server-rs` does: the ack carries the new revision and the committed cursor.
 */
function rig(opts: {
  inventory: SessionSummary[];
  transcripts: Record<string, HistoryMessage[]>;
  sizes?: Record<string, number>;
  /** Answer a commit with this instead of an acceptance (once per entry). */
  refusals?: string[];
  /** The socket closes right after the first chunk leaves. */
  dropAfterChunk?: boolean;
}) {
  const frames: Frame[] = [];
  const reads: string[] = [];
  const state = { connected: true, inventory: opts.inventory, acks: true };
  const refusals = [...(opts.refusals ?? [])];
  const revisions = new Map<string, number>();
  const open = new Map<string, { sessionId: string; source: 'claude' | 'codex' }>();

  const host: ReplicatorHost = {
    connected: () => state.connected,
    uplinkBackedUp: () => false,
    inventory: () => state.inventory,
    send: (m) => {
      if (!state.connected) return false;
      if (m.type !== 'session_sync_begin' && m.type !== 'session_sync_chunk' && m.type !== 'session_sync_commit') {
        return true;
      }
      frames.push(m);
      if (m.type === 'session_sync_chunk' && opts.dropAfterChunk) state.connected = false;
      if (m.type === 'session_sync_begin') open.set(m.syncId, { sessionId: m.sessionId, source: m.source });
      if (m.type === 'session_sync_commit' && state.acks) {
        const meta = open.get(m.syncId)!;
        const refusal = refusals.shift();
        const revision = (revisions.get(meta.sessionId) ?? 0) + 1;
        if (!refusal) revisions.set(meta.sessionId, revision);
        setImmediate(() =>
          replicator.onAck(
            refusal
              ? { type: 'session_sync_ack', syncId: m.syncId, ...meta, ok: false, error: refusal }
              : {
                  type: 'session_sync_ack',
                  syncId: m.syncId,
                  ...meta,
                  ok: true,
                  revision,
                  messageCount: m.messageCount,
                  tailHash: m.tailHash,
                  syncedMtime: m.syncedMtime,
                },
          ),
        );
      }
      return true;
    },
  };
  const readers: TranscriptReaders = {
    claudeSize: async (id) => opts.sizes?.[id] ?? 1000,
    claudeMessages: async (id) => {
      reads.push(id);
      return opts.transcripts[id] ?? [];
    },
    codexSize: async (id) => opts.sizes?.[id] ?? 1000,
    codexMessages: async (id) => {
      reads.push(id);
      return opts.transcripts[id] ?? [];
    },
  };
  const replicator = new TranscriptReplicator(host, readers, FAST);
  return { replicator, frames, reads, state };
}

/** Wait until the replicator has gone quiet: no new frame or read for a while. */
async function settle(r: { frames: unknown[]; reads: unknown[] }, quietMs = 60): Promise<void> {
  let seen = -1;
  for (let i = 0; i < 100; i++) {
    const now = r.frames.length + r.reads.length;
    if (now === seen) return;
    seen = now;
    await new Promise((resolve) => setTimeout(resolve, quietMs));
  }
  throw new Error('the replicator never went quiet');
}

const kinds = (frames: Frame[]) => frames.map((f) => f.type.replace('session_sync_', ''));

test('nothing is sent before the hub says what it holds', async () => {
  const r = rig({ inventory: [session('a', 10)], transcripts: { a: transcript(3) } });
  r.replicator.queue();
  await settle(r);
  assert.equal(r.replicator.catalogReady, false);
  assert.deepEqual(r.frames, []);
  assert.deepEqual(r.reads, []);
});

test('a session the hub has never seen is sent whole, and not again', async () => {
  const messages = transcript(3);
  const r = rig({ inventory: [session('a', 10)], transcripts: { a: messages } });
  r.replicator.setCatalog([]);
  r.replicator.queue();
  await settle(r);

  assert.deepEqual(kinds(r.frames), ['begin', 'chunk', 'commit']);
  const [begin, chunk, commit] = r.frames as [
    Extract<Frame, { type: 'session_sync_begin' }>,
    Extract<Frame, { type: 'session_sync_chunk' }>,
    Extract<Frame, { type: 'session_sync_commit' }>,
  ];
  assert.equal(begin.mode, 'replace');
  assert.equal(begin.baseRevision, 0);
  assert.equal(begin.source, 'claude');
  assert.equal(begin.summary.source, 'claude');
  assert.equal(chunk.start, 0);
  assert.deepEqual(chunk.messages, messages);
  assert.equal(commit.messageCount, 3);
  assert.equal(commit.tailHash, replicaStamp(messages, 3));
  assert.equal(commit.syncedMtime, 10);

  // The ack moved the cursor: the same inventory costs neither a read nor a frame.
  const before = { frames: r.frames.length, reads: r.reads.length };
  r.replicator.queue();
  await settle(r);
  assert.deepEqual({ frames: r.frames.length, reads: r.reads.length }, before);
});

test('a grown transcript whose tail the hub still has is appended from where the hub stopped', async () => {
  const messages = transcript(5);
  const held: SessionReplicaState = {
    sessionId: 'a',
    source: 'claude',
    revision: 4,
    messageCount: 3,
    tailHash: replicaStamp(messages, 3),
    syncedMtime: 10,
  };
  const r = rig({ inventory: [session('a', 20)], transcripts: { a: messages } });
  r.replicator.setCatalog([held]);
  r.replicator.queue();
  await settle(r);

  assert.deepEqual(kinds(r.frames), ['begin', 'chunk', 'commit']);
  const begin = r.frames[0] as Extract<Frame, { type: 'session_sync_begin' }>;
  const chunk = r.frames[1] as Extract<Frame, { type: 'session_sync_chunk' }>;
  assert.equal(begin.mode, 'append');
  assert.equal(begin.baseRevision, 4);
  assert.equal(chunk.start, 3);
  assert.deepEqual(chunk.messages, messages.slice(3));
});

test('a transcript whose history changed under the hub is replaced, not appended', async () => {
  const messages = transcript(5);
  const held: SessionReplicaState = {
    sessionId: 'a',
    source: 'claude',
    revision: 4,
    messageCount: 3,
    tailHash: 'a-tail-this-transcript-does-not-have',
    syncedMtime: 10,
  };
  const r = rig({ inventory: [session('a', 20)], transcripts: { a: messages } });
  r.replicator.setCatalog([held]);
  r.replicator.queue();
  await settle(r);

  const begin = r.frames[0] as Extract<Frame, { type: 'session_sync_begin' }>;
  const chunk = r.frames[1] as Extract<Frame, { type: 'session_sync_chunk' }>;
  assert.equal(begin.mode, 'replace');
  assert.equal(chunk.start, 0);
  assert.equal(chunk.messages.length, 5);
});

test('a file that moved without a new message is re-stamped locally, once', async () => {
  // Codex rewrites its rollout on every turn with records the parser drops.
  const messages = transcript(3);
  const held: SessionReplicaState = {
    sessionId: 'c',
    source: 'codex',
    revision: 2,
    messageCount: 3,
    tailHash: replicaStamp(messages, 3),
    syncedMtime: 10,
  };
  const r = rig({ inventory: [session('c', 20, { source: 'codex' })], transcripts: { c: messages } });
  r.replicator.setCatalog([held]);
  r.replicator.queue();
  await settle(r);
  assert.deepEqual(r.frames, [], 'no round trip for zero new messages');
  assert.equal(r.reads.length, 1);

  // Without the local re-stamp this would re-read and re-parse on every pass.
  r.replicator.queue();
  await settle(r);
  assert.equal(r.reads.length, 1);
});

test('a long transcript travels in chunks that each say where they start', async () => {
  const messages = transcript(250);
  const r = rig({ inventory: [session('a', 10)], transcripts: { a: messages } });
  r.replicator.setCatalog([]);
  r.replicator.queue();
  await settle(r);

  const chunks = r.frames.filter((f): f is Extract<Frame, { type: 'session_sync_chunk' }> => f.type === 'session_sync_chunk');
  assert.deepEqual(
    chunks.map((c) => [c.start, c.messages.length]),
    [
      [0, 100],
      [100, 100],
      [200, 50],
    ],
  );
  assert.deepEqual(chunks.flatMap((c) => c.messages), messages);
  assert.equal(r.frames.at(-1)!.type, 'session_sync_commit');
});

test('the newest session goes first, and a session without a cwd is not a Claude transcript to read', async () => {
  const r = rig({
    inventory: [session('new', 30), session('nocwd', 20, { cwd: undefined }), session('old', 10)],
    transcripts: { new: transcript(1), old: transcript(1), nocwd: transcript(1) },
  });
  r.replicator.setCatalog([]);
  r.replicator.queue();
  await settle(r);
  const begun = r.frames.filter((f) => f.type === 'session_sync_begin').map((f) => (f as { sessionId: string }).sessionId);
  assert.deepEqual(begun, ['new', 'old']);
  assert.deepEqual(r.reads, ['new', 'old']);
});

test('a transcript over its cap is skipped without being read', async () => {
  const r = rig({
    inventory: [session('huge', 10), session('ok', 5)],
    transcripts: { huge: transcript(2), ok: transcript(2) },
    sizes: { huge: CLAUDE_TRANSCRIPT_MAX_BYTES + 1 },
  });
  r.replicator.setCatalog([]);
  r.replicator.queue();
  await settle(r);
  assert.deepEqual(r.reads, ['ok']);
  assert.deepEqual(
    r.frames.filter((f) => f.type === 'session_sync_begin').map((f) => (f as { sessionId: string }).sessionId),
    ['ok'],
  );
});

test('a revision conflict gets one more pass with the cursor the hub answered with', async () => {
  const r = rig({
    inventory: [session('a', 10)],
    transcripts: { a: transcript(2) },
    refusals: ['revision conflict: expected 3'],
  });
  r.replicator.setCatalog([]);
  r.replicator.queue();
  await settle(r);
  // Refused once, then sent again and accepted — without another inventory.
  assert.deepEqual(kinds(r.frames), ['begin', 'chunk', 'commit', 'begin', 'chunk', 'commit']);
  const before = r.frames.length;
  r.replicator.queue();
  await settle(r);
  assert.equal(r.frames.length, before, 'the accepted pass moved the cursor');
});

test('a refusal that is not a conflict does not loop', async () => {
  const r = rig({
    inventory: [session('a', 10)],
    transcripts: { a: transcript(2) },
    refusals: ['workspace is read-only'],
  });
  r.replicator.setCatalog([]);
  r.replicator.queue();
  await settle(r);
  assert.deepEqual(kinds(r.frames), ['begin', 'chunk', 'commit']);
});

test('a disconnect mid-sync fails that sync quietly and forgets the old catalog', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const r = rig({ inventory: [session('a', 10)], transcripts: { a: transcript(2) } });
    r.state.acks = false; // the hub goes away before it answers the commit
    r.replicator.setCatalog([]);
    r.replicator.queue();
    await settle(r);
    assert.deepEqual(kinds(r.frames), ['begin', 'chunk', 'commit']);

    // Something the old connection's catalog held, to see it go.
    r.replicator.setCatalog([{ sessionId: 'z', source: 'claude', revision: 1, messageCount: 0, syncedMtime: 1 }]);
    r.state.connected = false;
    r.replicator.onDisconnect();
    await settle(r);
    assert.equal(r.replicator.catalogReady, false);
    assert.equal(r.replicator.forget('claude', 'z'), false, "the old connection's catalog is gone");

    // Reconnected: nothing moves until the new connection's catalog arrives,
    // and then the session is sent again — the hub never confirmed it.
    r.state.connected = true;
    r.state.acks = true;
    r.replicator.queue();
    await settle(r);
    assert.equal(r.frames.length, 3);
    r.replicator.setCatalog([]);
    r.replicator.queue();
    await settle(r);
    assert.deepEqual(kinds(r.frames).slice(3), ['begin', 'chunk', 'commit']);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a socket that closes between a chunk and its commit ends the pass there', async () => {
  const r = rig({
    inventory: [session('a', 20), session('b', 10)],
    transcripts: { a: transcript(2), b: transcript(2) },
    dropAfterChunk: true,
  });
  r.replicator.setCatalog([]);
  r.replicator.queue();
  await settle(r);
  // No commit for `a`, and `b` is never read: the hub keeps what it had.
  assert.deepEqual(kinds(r.frames), ['begin', 'chunk']);
  assert.deepEqual(r.reads, ['a']);
});

test('a socket that is already closed starts nothing', async () => {
  const r = rig({
    inventory: [session('a', 20), session('b', 10)],
    transcripts: { a: transcript(2), b: transcript(2) },
  });
  r.state.connected = false;
  r.replicator.setCatalog([]);
  r.replicator.queue();
  await settle(r);
  assert.deepEqual(r.frames, []);
  assert.deepEqual(r.reads, [], 'not even a read once the socket is gone');
});

test('forget reports whether the hub held the session, and takes it out of the catalog', () => {
  const r = rig({ inventory: [], transcripts: {} });
  r.replicator.setCatalog([
    { sessionId: 'a', source: 'claude', revision: 1, messageCount: 0, syncedMtime: 1 },
  ]);
  assert.equal(r.replicator.forget('codex', 'a'), false, 'the same id under another runtime is another session');
  assert.equal(r.replicator.forget('claude', 'a'), true);
  assert.equal(r.replicator.forget('claude', 'a'), false);
});

test('the cursor is the file mtime when the list sorts by something else', () => {
  assert.equal(replicaCursor(session('a', 10)), 10);
  assert.equal(replicaCursor(session('a', 10, { fileMtime: 25 })), 25);
});
