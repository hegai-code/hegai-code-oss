/**
 * Transcript replication: keeping the hub's offline copy of every listed
 * session equal to the file on this machine.
 *
 * The hub sends a catalog of what it holds (`session_sync_catalog`); for each
 * session whose file has moved since, the agent parses the transcript and
 * sends `session_sync_begin` → `session_sync_chunk`… → `session_sync_commit`,
 * appending when the hub's tail still matches and replacing otherwise; the hub
 * answers `session_sync_ack`. One session at a time, newest first.
 *
 * It lived inside `AgentClient` until 10.11.2026. It is its own class so that
 * it can be driven in a test without a socket: all it needs from the client is
 * the four things in `ReplicatorHost`.
 */
import { randomUUID } from 'node:crypto';
import type { AgentToCentral, CentralToAgent, HistoryMessage, SessionReplicaState, SessionSummary } from '@cc-remote/shared';
import { ConfineError } from './confine.js';
import { CODEX_TRANSCRIPT_MAX_BYTES, codexRolloutSize, readCodexTranscript } from './codex.js';
import {
  CLAUDE_TRANSCRIPT_MAX_BYTES,
  TranscriptTooLargeError,
  claudeTranscriptSize,
  loadHistory,
  replicaStamp,
  trimToolPayloads,
} from './history.js';
import { syncsCwd } from './policy.js';

// Most one replica chunk may carry. The hub closes the agent socket on a frame
// over 32 MiB (WS_MAX_MESSAGE_BYTES in server-rs/src/ws_api.rs), which drops
// every live run on the machine — and the pass would resend the same chunk
// after the reconnect, forever. A count alone bounded this only while a
// transcript was small enough to hold under 25 MB.
const REPLICA_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const REPLICA_CHUNK_MAX_MESSAGES = 100;
/** A single message larger than this travels with its tool payloads cut. */
const REPLICA_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;
const REPLICA_OVERSIZE_TOOL_CHARS = 64 * 1024;
// Floor on the gap between replication passes. A live Codex run rewrites its
// rollout continuously, so `dirty` is re-armed faster than a pass can finish,
// and a pass re-reads AND re-parses every touched transcript from scratch.
// Without a floor the loop simply never yields: on dev-mac-mini-001
// (23.09.2026) it pinned a core for minutes, the event loop stopped turning,
// and the agent never noticed the hub had restarted — the machine read as
// offline while its process was alive. Pacing costs at most this much staleness
// in the hub's offline copy, which nothing waits on.
const REPLICA_PASS_MIN_MS = 1500;
/** Pause between two sessions of one replica pass — see `drain`. */
const REPLICA_YIELD_MS = 20;
/** How long a sync waits for the hub's `session_sync_ack`. */
const SYNC_ACK_TIMEOUT_MS = 5 * 60_000;

type SessionSyncAck = Extract<CentralToAgent, { type: 'session_sync_ack' }>;

interface SyncWaiter {
  resolve: (ack: SessionSyncAck) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** The replica's sync cursor for a listed session: its file's mtime, which
 *  only grows. `lastModified` is for sorting and can settle backwards onto the
 *  last real message (`claude-activity.ts`). */
export function replicaCursor(s: SessionSummary): number {
  return s.fileMtime ?? s.lastModified;
}

/** What the replicator needs from the client that owns the socket. */
export interface ReplicatorHost {
  /** Send one frame; false when the socket is not open. */
  send(msg: AgentToCentral): boolean;
  /** The agent socket is open. */
  connected(): boolean;
  /** The uplink buffer is past its backpressure mark. */
  uplinkBackedUp(): boolean;
  /** The sessions this machine lists, newest first. */
  inventory(): readonly SessionSummary[];
}

/** How a transcript is sized and read. The defaults are the real readers; a
 *  test passes its own, because the real ones need files under `~/.claude`. */
export interface TranscriptReaders {
  codexSize(sessionId: string, cwd?: string): Promise<number>;
  codexMessages(sessionId: string, cwd?: string): Promise<HistoryMessage[]>;
  claudeSize(sessionId: string): Promise<number>;
  claudeMessages(sessionId: string, cwd: string): Promise<HistoryMessage[]>;
}

const REAL_READERS: TranscriptReaders = {
  codexSize: (sessionId, cwd) => codexRolloutSize(sessionId, cwd),
  codexMessages: async (sessionId, cwd) => (await readCodexTranscript(sessionId, cwd))?.messages ?? [],
  claudeSize: (sessionId) => claudeTranscriptSize(sessionId),
  claudeMessages: (sessionId, cwd) => loadHistory(sessionId, cwd),
};

export interface ReplicatorTimings {
  passMinMs: number;
  yieldMs: number;
  ackTimeoutMs: number;
}

const REAL_TIMINGS: ReplicatorTimings = {
  passMinMs: REPLICA_PASS_MIN_MS,
  yieldMs: REPLICA_YIELD_MS,
  ackTimeoutMs: SYNC_ACK_TIMEOUT_MS,
};

function replicaKey(source: 'claude' | 'codex', sessionId: string): string {
  return `${source}:${sessionId}`;
}

export class TranscriptReplicator {
  /** An inventory arrived (or a conflict asked for another pass) since the
   *  running pass took its snapshot. */
  private dirty = false;
  /** The hub's catalog for this connection has arrived. */
  private ready = false;
  private running = false;
  private states = new Map<string, SessionReplicaState>();
  private readonly waiters = new Map<string, SyncWaiter>();
  /** sessionIds whose transcript exceeded its read cap — logged once each. */
  private readonly oversize = new Set<string>();

  constructor(
    private readonly host: ReplicatorHost,
    private readonly readers: TranscriptReaders = REAL_READERS,
    private readonly timings: ReplicatorTimings = REAL_TIMINGS,
  ) {}

  /** Whether the hub's catalog for this connection has arrived. Until it has,
   *  the agent does not know what the hub holds. */
  get catalogReady(): boolean {
    return this.ready;
  }

  /** `session_sync_catalog`: what the hub holds for this machine. */
  setCatalog(sessions: readonly SessionReplicaState[]): void {
    this.states = new Map(sessions.map((state) => [replicaKey(state.source, state.sessionId), state]));
    this.ready = true;
  }

  /** Drop a session from the local picture of the hub's catalog. True when the
   *  hub held it — the caller then asks the hub to forget it. */
  forget(source: 'claude' | 'codex', sessionId: string): boolean {
    return this.states.delete(replicaKey(source, sessionId));
  }

  /** The inventory moved: reconcile, now or after the running pass. */
  queue(): void {
    this.dirty = true;
    if (this.ready && !this.running) void this.drain();
  }

  /** `session_sync_ack`: the hub's verdict on one sync, and its new cursor. */
  onAck(msg: SessionSyncAck): void {
    if (msg.revision !== undefined && msg.messageCount !== undefined && msg.syncedMtime !== undefined) {
      this.states.set(replicaKey(msg.source, msg.sessionId), {
        sessionId: msg.sessionId,
        source: msg.source,
        revision: msg.revision,
        messageCount: msg.messageCount,
        tailHash: msg.tailHash,
        syncedMtime: msg.syncedMtime,
      });
    }
    const waiter = this.waiters.get(msg.syncId);
    if (waiter) {
      this.waiters.delete(msg.syncId);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }

  /** The socket closed: the catalog is the old connection's, and nothing will
   *  answer the syncs in flight. */
  onDisconnect(): void {
    this.ready = false;
    this.states.clear();
    for (const [syncId, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`disconnected during transcript sync ${syncId}`));
    }
    this.waiters.clear();
  }

  /** Reconcile newest sessions first. A second inventory that lands during a
   * long initial upload marks the loop dirty and gets another pass afterward. */
  private async drain(): Promise<void> {
    if (this.running || !this.ready) return;
    this.running = true;
    try {
      do {
        this.dirty = false;
        const passStart = Date.now();
        const inventory = [...this.host.inventory()];
        for (const session of inventory) {
          if (!this.host.connected() || !this.ready) return;
          // The snapshot above may predate a `sync.set remove`: never upload a
          // session the owner has just taken off the list.
          if (!syncsCwd(session.cwd)) continue;
          const source = session.source ?? 'claude';
          const remote = this.states.get(replicaKey(source, session.sessionId));
          if (remote?.syncedMtime === replicaCursor(session)) continue;
          try {
            await this.syncSession(session, remote);
          } catch (err) {
            console.error(
              `[agent] transcript sync ${source}:${session.sessionId} failed:`,
              (err as Error).message,
            );
            if (!this.host.connected()) return;
          }
          // Give the event loop a turn between sessions. A sync pass parses
          // whole transcripts back to back; on a box with thousands of them
          // that starves the RPCs the hub is forwarding (a transcript read for
          // a browser waited seconds, measured 26.09.2026), and the socket's
          // own frames queue behind the parsing. A short pause per session
          // costs a full re-sync of 500 sessions about ten seconds.
          await new Promise((resolve) => setTimeout(resolve, this.timings.yieldMs));
        }
        if (this.dirty && this.ready) {
          const elapsed = Date.now() - passStart;
          if (elapsed < this.timings.passMinMs) {
            await new Promise((resolve) => setTimeout(resolve, this.timings.passMinMs - elapsed));
          }
        }
      } while (this.dirty && this.ready);
    } finally {
      this.running = false;
      if (this.dirty && this.ready) void this.drain();
    }
  }

  private async syncSession(session: SessionSummary, remote?: SessionReplicaState): Promise<void> {
    const source = session.source ?? 'claude';
    if (source === 'claude' && !session.cwd) return;
    // OOM guard: a single pathological transcript (100+ MB tool dumps have been
    // observed) read whole into memory can OOM the agent — on a box with a
    // large corpus this crashlooped and pinned CPU. Both runtimes are therefore
    // sized by stat BEFORE any read and skipped over their cap: the session
    // still appears in inventory, and the live mirror (which tail-caps at
    // INITIAL_TAIL_BYTES) still opens it.
    //
    // A big transcript is not read whole, though: a Codex rollout
    // (`readCodexTranscript`) and a Claude transcript over 4 MB
    // (`loadHistory` → `readClaudeTranscript`) are streamed, parsed once and
    // then only extended, so their cost is the PARSED size — 3.6 MB for a
    // 158 MB rollout — and they get a far looser cap. Holding them to 25 MB
    // froze a live session's hub copy for 18 hours (Codex, 26.09.2026) and
    // again for a 31 MB Claude transcript (14.10.2026): every phone open was
    // answered from that copy, missing the day's answers.
    //
    // A Claude transcript crossing 4 MB switches from the SDK's conversation
    // reconstruction to the streaming parser, which can differ from it on a
    // rewound or compacted chain: the stamp check below then fails once and
    // the session is re-sent whole (`replace`) — a one-off, not a loop.
    let messages: HistoryMessage[];
    if (source === 'codex') {
      let bytes: number;
      try {
        bytes = await this.readers.codexSize(session.sessionId, session.cwd);
        if (bytes > CODEX_TRANSCRIPT_MAX_BYTES) {
          this.warnOversize(source, session.sessionId, bytes, CODEX_TRANSCRIPT_MAX_BYTES);
          return;
        }
        messages = await this.readers.codexMessages(session.sessionId, session.cwd);
      } catch (error) {
        // Confined and ambiguous (or refused): an unattributable transcript is
        // NOT an empty one. Replacing the hub's replica with [] would erase the
        // real session, so this pass syncs nothing.
        if (error instanceof ConfineError) {
          console.warn(`[agent] replica sync skipped for ${session.sessionId}: ${error.message}`);
          return;
        }
        throw error;
      }
    } else {
      const bytes = await this.readers.claudeSize(session.sessionId);
      if (bytes > CLAUDE_TRANSCRIPT_MAX_BYTES) {
        this.warnOversize(source, session.sessionId, bytes, CLAUDE_TRANSCRIPT_MAX_BYTES);
        return;
      }
      try {
        messages = await this.readers.claudeMessages(session.sessionId, session.cwd!);
      } catch (err) {
        // The file fits the cap but its parse does not: skipped like the
        // file-size case above, once in the log, not as a failure every pass.
        if (!(err instanceof TranscriptTooLargeError)) throw err;
        this.warnOversize(source, session.sessionId, bytes, CLAUDE_TRANSCRIPT_MAX_BYTES, true);
        return;
      }
    }

    const canAppend =
      remote !== undefined &&
      remote.revision > 0 &&
      remote.messageCount <= messages.length &&
      (remote.messageCount === 0 ||
        (remote.tailHash !== undefined &&
          replicaStamp(messages, remote.messageCount) === remote.tailHash));
    const mode = canAppend ? 'append' : 'replace';
    const start = canAppend ? remote.messageCount : 0;
    // The file changed but nothing new came out of the parser: Codex appends
    // records it drops (token_count, turn_context) on every turn, so a live run
    // bumps the mtime without adding messages. The begin/commit round trip below
    // would do nothing but re-stamp syncedMtime — do that locally instead, or the
    // skip in `drain` never fires and this transcript gets re-read and
    // re-parsed on every pass for as long as the run lives. That is the
    // `0 new / N total` log that ran for minutes before the 23.09.2026 wedge.
    if (canAppend && start === messages.length) {
      const key = replicaKey(source, session.sessionId);
      const state = this.states.get(key);
      if (state) this.states.set(key, { ...state, syncedMtime: replicaCursor(session) });
      return;
    }
    const baseRevision = remote?.revision ?? 0;
    const syncId = randomUUID();
    const summary: SessionSummary = { ...session, source };
    const ack = this.waitForAck(syncId);

    try {
      await this.sendFrame({
        type: 'session_sync_begin',
        syncId,
        sessionId: session.sessionId,
        source,
        summary,
        mode,
        baseRevision,
      });
      let batch: HistoryMessage[] = [];
      let batchStart = start;
      let batchBytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        await this.sendFrame({ type: 'session_sync_chunk', syncId, start: batchStart, messages: batch });
        batchStart += batch.length;
        batch = [];
        batchBytes = 0;
      };
      for (let pos = start; pos < messages.length; pos++) {
        let message = messages[pos]!;
        let bytes = Buffer.byteLength(JSON.stringify(message));
        if (bytes > REPLICA_MESSAGE_MAX_BYTES) {
          message = trimToolPayloads([message], REPLICA_OVERSIZE_TOOL_CHARS)[0]!;
          bytes = Buffer.byteLength(JSON.stringify(message));
        }
        if (batch.length >= REPLICA_CHUNK_MAX_MESSAGES || (batch.length && batchBytes + bytes > REPLICA_CHUNK_MAX_BYTES)) {
          await flush();
        }
        batch.push(message);
        batchBytes += bytes;
      }
      await flush();
      const tailHash = messages.length ? replicaStamp(messages, messages.length) : undefined;
      await this.sendFrame({
        type: 'session_sync_commit',
        syncId,
        messageCount: messages.length,
        tailHash,
        syncedMtime: replicaCursor(session),
      });
    } catch (err) {
      const waiter = this.waiters.get(syncId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.waiters.delete(syncId);
        waiter.reject(err as Error);
      }
      // Observe the rejection here; otherwise the pre-created ack promise would
      // become an unhandled rejection when the socket closes mid-send.
      await ack.catch(() => undefined);
      throw err;
    }

    const result = await ack;
    if (!result.ok) {
      // The register catalog can race an inventory that re-activates a formerly
      // tombstoned row. The hub returns its current cursor; make one fresh pass
      // with that cursor instead of waiting for another filesystem event.
      if (result.error?.includes('revision conflict')) this.dirty = true;
      throw new Error(result.error ?? 'hub rejected transcript sync');
    }
    console.log(
      `[agent] transcript ${mode}: ${source}:${session.sessionId} (${messages.length - start} new / ${messages.length} total)`,
    );
  }

  private warnOversize(source: string, sessionId: string, bytes: number, cap: number, parsed = false): void {
    if (this.oversize.has(sessionId)) return;
    this.oversize.add(sessionId);
    console.warn(
      parsed
        ? `[agent] skip transcript replica ${source}:${sessionId} — ${Math.round(bytes / 1e6)}MB file parses over the kept-parse cap`
        : `[agent] skip transcript replica ${source}:${sessionId} — ${Math.round(bytes / 1e6)}MB over ${Math.round(cap / 1e6)}MB cap`,
    );
  }

  private waitForAck(syncId: string): Promise<SessionSyncAck> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(syncId);
        reject(new Error('hub did not acknowledge transcript sync'));
      }, this.timings.ackTimeoutMs);
      timer.unref?.();
      this.waiters.set(syncId, { resolve, reject, timer });
    });
  }

  private async sendFrame(message: AgentToCentral): Promise<void> {
    // Keep a large first reconciliation from filling ws' user-space buffer. The
    // hub processes frames serially; a short yield lets TCP drain naturally.
    while (this.host.connected() && this.host.uplinkBackedUp()) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!this.host.send(message)) throw new Error('agent disconnected');
  }
}
