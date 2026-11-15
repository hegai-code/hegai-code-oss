import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { parseTaskNotification, type HistoryMessage, type RenderBlock, type TaskNotice } from '@cc-remote/shared';
import { readJsonlLines } from './file-range.js';
import { callForOutput, ImageGenLedger, isBackgroundBash, parseGenRef, parseImageGenCalls, parseImageOutputs } from './image-gen.js';
import { confinePrefix } from './confine.js';
import {
  INCREMENTAL_MAX_ENTRY_BYTES,
  INCREMENTAL_MIN_BYTES,
  advanceJsonl,
  cursorStillExtends,
  keepBounded,
  newCursor,
  serializedBy,
  type JsonlCursor,
} from './jsonl-incremental.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const STREAM_HISTORY_THRESHOLD = 4 * 1024 * 1024;
/** Largest transcript FILE parsed whole and kept (`readClaudeTranscript`) —
 *  and so the largest one replicated to the hub. The file is mostly what the
 *  parse drops: inline pictures (a marker each, see `inlineDataMarker`) and,
 *  since CLI 2.1.3xx, `api-request-blob` records — 213 MB parsed to ~1 MB
 *  (24.10.2026). What the parse may hold is bounded separately
 *  (`CLAUDE_PARSE_MAX_BYTES`); this cap bounds only the one-off CPU of the
 *  first read (~8 s per 200 MB here). Above either, the history RPC keeps the
 *  bounded window scan (`readClaudeHistory`) and the replica skips the file.
 *  It was 128 MiB on the file alone, and a live session crossed it mid-turn:
 *  the hub's copy froze and every client lost the turns after it. */
export const CLAUDE_TRANSCRIPT_MAX_BYTES = 512 * 1024 * 1024;
/** Largest parse kept: one cache entry. Bigger, and it would be thrown away
 *  and redone on every read — the parse that starved the agent before. */
const CLAUDE_PARSE_MAX_BYTES = INCREMENTAL_MAX_ENTRY_BYTES;

/** The transcript is over a read cap (file or parse); the reader decides what
 *  to fall back to. */
export class TranscriptTooLargeError extends Error {}

/** Sessions whose parse outgrew `CLAUDE_PARSE_MAX_BYTES`, as a cursor at the
 *  file's end at that point: while the file still extends those bytes it can
 *  only have grown, so the next read fails at once instead of parsing hundreds
 *  of MB to fail again. A rewrite (`cursorStillExtends` says no) is parsed
 *  afresh. */
const claudeParseTooLarge = new Map<string, { filePath: string; cursor: JsonlCursor }>();
const PARSE_TOO_LARGE_GUARD_BYTES = 256;

async function findClaudeTranscript(sessionId: string): Promise<{ filePath: string; size: number } | null> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }
  const name = `${sessionId}.jsonl`;
  for (const dir of dirs) {
    const filePath = path.join(PROJECTS_DIR, dir, name);
    try {
      return { filePath, size: (await stat(filePath)).size };
    } catch {
      /* not in this project dir */
    }
  }
  return null;
}

/**
 * Byte size of a Claude session's transcript `.jsonl`, or -1 if not found.
 * Lets the replica sync skip a pathological transcript (we've seen 100+ MB tool
 * dumps) BEFORE `loadHistory` reads it whole into memory and OOMs the agent.
 */
export async function claudeTranscriptSize(sessionId: string): Promise<number> {
  return (await findClaudeTranscript(sessionId))?.size ?? -1;
}

/**
 * Loads and normalizes a session transcript into render-ready blocks. Normal
 * transcripts use the SDK's conversation-chain reconstruction; oversized
 * interactive reads stream the complete JSONL, retaining a bounded message window.
 */

/**
 * A short stand-in for an inline base64 block (a picture `Read` returned, a
 * PDF page) inside a tool result. Stringified, one such block is the whole
 * file as text: a session that looked at 99 full-size images parsed to 58 MB
 * of base64 «results» out of 59 (24.10.2026), the kept parse outgrew every
 * cap and the hub's copy stopped mid-turn — the phone lost half an hour of the
 * conversation. The live stream never sent these bytes either.
 */
function inlineDataMarker(b: Record<string, unknown>): string | null {
  const source = b['source'] as Record<string, unknown> | undefined;
  if (!source || source['type'] !== 'base64' || typeof source['data'] !== 'string') return null;
  const kb = Math.round((source['data'].length * 3) / 4 / 1024);
  return `[${String(b['type'] ?? 'data')} ${String(source['media_type'] ?? '')}, ${kb} KB]`.replace(' ,', ',');
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') return b['text'];
        const inline = inlineDataMarker(b);
        return inline ?? JSON.stringify(c);
      })
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * Harness plumbing the CLI injects into a turn's text: background-task
 * notifications, system reminders, and the slash-command envelope. It is
 * addressed to the model, never to a reader, and on a real session it is the
 * bulk of what a transcript contains — one session here carried 93
 * `<task-notification>` blocks against a handful of actual sentences. Strip the
 * wrappers only; everything worth reading is nested inside them or outside.
 */
const HARNESS_BLOCKS = [
  'task-notification',
  'system-reminder',
  'local-command-stdout',
  'local-command-caveat',
  'command-name',
  'command-message',
  'command-args',
] as const;

const HARNESS_RE = new RegExp(
  HARNESS_BLOCKS.map((tag) => `<${tag}>[\\s\\S]*?</${tag}>`).join('|'),
  'g',
);

/** Drop harness blocks from a turn's text. Empty result => nothing to show. */
export function stripHarnessNoise(text: string): string {
  return text.includes('<') ? text.replace(HARNESS_RE, '').trim() : text;
}

/** `uuid` is the message's own id in the transcript. It is threaded in only so
 *  an image block can carry a ref back to itself — the pair (uuid, content
 *  index) is enough for `session.image` to find the bytes again, and it needs
 *  no new bookkeeping: both halves already exist in the file. */
function parseBlocks(message: unknown, uuid: string): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') {
    const text = stripHarnessNoise(content);
    if (text) blocks.push({ kind: 'text', text });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const [index, raw] of content.entries()) {
    const b = raw as Record<string, unknown>;
    switch (b['type']) {
      case 'text': {
        if (typeof b['text'] !== 'string') break;
        const text = stripHarnessNoise(b['text']);
        if (text) blocks.push({ kind: 'text', text });
        break;
      }
      case 'thinking': {
        // Guard emptiness like text above: an empty thinking block still drew
        // its "размышление" chrome, so the reader got a labelled empty box.
        const text = String(b['thinking'] ?? b['text'] ?? '').trim();
        if (text) blocks.push({ kind: 'thinking', text });
        break;
      }
      case 'tool_use':
        blocks.push({
          kind: 'tool_use',
          id: String(b['id'] ?? ''),
          name: String(b['name'] ?? ''),
          input: b['input'],
        });
        break;
      case 'tool_result': {
        // Same guard: a result with no output rendered as an empty "результат".
        // Errors stay even when empty — the error state itself is the signal.
        const text = asText(b['content']).trim();
        const isError = Boolean(b['is_error']);
        if (text || isError)
          blocks.push({
            kind: 'tool_result',
            toolUseId: String(b['tool_use_id'] ?? ''),
            text,
            isError,
          });
        break;
      }
      case 'image':
        // Marker only — the base64 stays out of the history payload, which is
        // what keeps a reload cheap on a session full of screenshots. The ref
        // is how a client trades the marker for the picture when it is actually
        // about to draw one (`session.image`).
        blocks.push({ kind: 'image', ref: `${uuid}#${index}` });
        break;
    }
  }
  return blocks;
}

/**
 * Shorten one oversized payload, saying how much was left behind. The marker
 * reads inside the code block the clients fold these into, and it is deliberate
 * that it names a size: "truncated" alone leaves you unsure whether you are
 * looking at a whole 40-line result or the first page of a 4 MB one.
 */
function clipPayload(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const dropped = text.length - cap;
  const size = dropped >= 1024 ? `${Math.round(dropped / 1024)} KB` : `${dropped} chars`;
  return `${text.slice(0, cap)}\n… truncated · ${size} more`;
}

/**
 * Trim the long string payloads out of a transcript before it crosses the wire.
 *
 * Measured on this fleet, a session that reads as a page of dialogue ships as
 * ~1.2 MB, of which 96-99% is `tool_result` bodies and `tool_use` inputs
 * (Write contents, Edit hunks, grep dumps). Clients fold all of that behind a
 * disclosure and clip it on screen anyway, so a phone was paying a megabyte to
 * render twenty kilobytes it could read. Structure is untouched — every block
 * still exists, in order, with its name and id — only the bulk is cut.
 */
export function trimToolPayloads(messages: HistoryMessage[], cap: number): HistoryMessage[] {
  const clipInput = (input: unknown): unknown => {
    if (typeof input === 'string') return clipPayload(input, cap);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
    const obj = input as Record<string, unknown>;
    let next: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(obj)) {
      // Top-level strings only. That is where the weight actually is
      // (`content`, `old_string`, `new_string`, `command`, `prompt`), and it
      // leaves structured inputs like TodoWrite's array intact and renderable.
      if (typeof value === 'string' && value.length > cap) {
        next ??= { ...obj };
        next[key] = clipPayload(value, cap);
      }
    }
    return next ?? input;
  };
  return messages.map((message) => {
    let blocks: HistoryMessage['blocks'] | undefined;
    message.blocks.forEach((block, i) => {
      let replaced: HistoryMessage['blocks'][number] | undefined;
      if (block.kind === 'tool_result' && block.text.length > cap) {
        replaced = { ...block, text: clipPayload(block.text, cap) };
      } else if (block.kind === 'tool_use') {
        const input = clipInput(block.input);
        if (input !== block.input) replaced = { ...block, input };
      }
      if (!replaced) return;
      blocks ??= [...message.blocks];
      blocks[i] = replaced;
    });
    return blocks ? { ...message, blocks } : message;
  });
}

/**
 * SDK 0.3.3xx turns a `queued_command` attachment (a message sent while the
 * turn ran) into a `user` record of its own — `isQueuedCommand: true`, uuid =
 * the attachment's `source_uuid`. `addQueuedPrompts` already adds that message
 * from the attachment under the attachment's uuid (the key `loadImage` reads),
 * placed by send time, the same way the streaming parsers do. With both, every
 * mid-turn message showed twice; on 31.10.2026 the phone, matching its live
 * lines against a history holding the copy, drew one message three times. The
 * attachment path owns it: the SDK's copy is set aside, and comes back only if
 * the raw scan never saw its attachment (it failed, or the file moved on).
 */
export function splitSdkQueuedCopies<T>(msgs: T[]): { rest: T[]; copies: T[] } {
  const rest: T[] = [];
  const copies: T[] = [];
  for (const m of msgs) ((m as { isQueuedCommand?: unknown }).isQueuedCommand === true ? copies : rest).push(m);
  return { rest, copies };
}

export async function loadHistory(sessionId: string, cwd: string, limit?: number, toolChars?: number): Promise<HistoryMessage[]> {
  const transcript = await findClaudeTranscript(sessionId);
  if (transcript && transcript.size > CLAUDE_TRANSCRIPT_MAX_BYTES && typeof limit === 'number') {
    // Too big to keep parsed: one bounded pass, holding only the window.
    return readClaudeHistory(transcript.filePath, limit, toolChars);
  }
  if (transcript && transcript.size > STREAM_HISTORY_THRESHOLD && transcript.size <= CLAUDE_TRANSCRIPT_MAX_BYTES) {
    // Parsed once, then only extended (see `readClaudeTranscript`): a 31 MB
    // transcript re-parsed whole on every read missed the hub's 6 s deadline
    // and froze the session's replica (14.10.2026). Trimmed on copies — the
    // kept messages stay whole for the next reader.
    let read: Awaited<ReturnType<typeof readClaudeTranscript>> = null;
    try {
      read = await readClaudeTranscript(sessionId);
    } catch (err) {
      if (!(err instanceof TranscriptTooLargeError)) throw err;
      // The parse would not fit: a window is still answerable by one bounded
      // pass. A whole-history caller (the replica) is told so and skips — the
      // SDK read below would load the whole file, every pass.
      if (typeof limit === 'number') return readClaudeHistory(transcript.filePath, limit, toolChars);
      throw err;
    }
    if (read) {
      const window = limit === undefined ? read.messages : limit > 0 ? read.messages.slice(-limit) : [];
      return toolChars === undefined ? window : trimToolPayloads(window, toolChars);
    }
  }
  // `includeSystemMessages` for the compaction boundary — the one `system`
  // record that IS conversation: without it a reload shows a history that
  // jumps from a long exchange to a short one with nothing in between.
  const { rest: msgs, copies } = splitSdkQueuedCopies(
    await getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true }),
  );
  const ledger = new ImageGenLedger();
  const messages = msgs.flatMap((m): HistoryMessage[] => {
    const parsed = parseRecord(m);
    return [...(parsed ? [parsed] : []), ...ledger.observe(m, recordTs(m))];
  });
  attachTaskNotices(messages, msgs.flatMap(taskNoticesOf));
  // The SDK leaves attachments out; the raw scan below finds the folded ones.
  const seen = await addQueuedPrompts(sessionId, messages);
  for (const copy of copies) {
    if (seen.has((copy as { uuid?: string }).uuid ?? '')) continue;
    const parsed = parseRecord(copy);
    if (parsed && !messages.some((m) => m.uuid === parsed.uuid)) insertBySendTime(messages, parsed);
  }
  const window = typeof limit === 'number' ? messages.slice(-limit) : messages;
  return toolChars === undefined ? window : trimToolPayloads(window, toolChars);
}

/**
 * One sub-agent's own transcript: `<session>/subagents/agent-<id>.jsonl`,
 * found by the parent's `Agent` call id that its `.meta.json` names. Empty
 * when the CLI wrote none (an older CLI, a cleaned-up session).
 */
export async function loadSubagentHistory(
  sessionId: string,
  toolUseId: string | undefined,
  limit: number,
  toolChars?: number,
  /** The task id (`Subagent.id`), which is also the file's own name. The only
   *  key for a helper started by a skill (`context: fork`): its `.meta.json`
   *  names no call, because there was no `Agent` call. */
  agentId?: string,
): Promise<HistoryMessage[]> {
  const parent = await findClaudeTranscript(sessionId);
  if (!parent) return [];
  const dir = path.join(parent.filePath.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  if (agentId && /^[A-Za-z0-9_-]{1,100}$/.test(agentId) && names.includes(`agent-${agentId}.jsonl`)) {
    return (await scanClaudeHistory(path.join(dir, `agent-${agentId}.jsonl`), limit, toolChars)).messages;
  }
  if (!toolUseId) return [];
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as { toolUseId?: unknown };
      if (meta.toolUseId !== toolUseId) continue;
    } catch {
      continue;
    }
    const file = path.join(dir, name.replace(/\.meta\.json$/, '.jsonl'));
    return (await scanClaudeHistory(file, limit, toolChars)).messages;
  }
  return [];
}

/**
 * How a BACKGROUND sub-agent ended is written only into the
 * `<task-notification>` the CLI injects as a user turn — which history strips
 * as harness noise, so a reloaded card never learned it had finished. The
 * notice is kept in compact form (call id, status, report) as a text block on
 * the message that holds the `Agent` call's own result: no new message, no new
 * block kind, and every client already hides the tag when it renders.
 */
export function taskNoticesOf(rec: unknown): TaskNotice[] {
  const r = rec as { type?: unknown; message?: { content?: unknown }; attachment?: { commandMode?: unknown; prompt?: unknown } } | null;
  // One that lands mid-turn is folded in as an attachment, not a user turn.
  const folded = r?.type === 'attachment' && r.attachment?.commandMode === 'task-notification';
  if (r?.type !== 'user' && !folded) return [];
  const content = folded ? r!.attachment!.prompt : r!.message?.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? [String((b as { text?: unknown }).text ?? '')] : []))
        : [];
  const out: TaskNotice[] = [];
  for (const text of texts) {
    for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
      const n = parseTaskNotification(block);
      if (n?.toolUseId) out.push(n);
    }
  }
  return out;
}

/** Hang each notice on its call's result, in transcript order: the FIRST
 *  ending is the ending (a Stop, then the CLI's trailing «completed», reads
 *  stopped — as it does live). A result that already carries one keeps it. */
export function attachTaskNotices(messages: HistoryMessage[], notices: TaskNotice[]): void {
  if (!notices.length) return;
  const byCall = new Map<string, TaskNotice>();
  for (const n of notices) {
    const first = byCall.get(n.toolUseId!);
    if (!first) byCall.set(n.toolUseId!, n);
    else if (!first.summary && n.summary) byCall.set(n.toolUseId!, { ...first, summary: n.summary });
  }
  for (let at = 0; at < messages.length; at++) {
    const m = messages[at]!;
    const carried = new Set(
      m.blocks.flatMap((b) => (b.kind === 'text' ? [parseTaskNotification(b.text)?.toolUseId] : [])).filter(Boolean),
    );
    let blocks: RenderBlock[] | undefined;
    for (const b of m.blocks) {
      if (b.kind !== 'tool_result') continue;
      const n = byCall.get(b.toolUseId);
      if (!n || carried.has(b.toolUseId)) continue;
      byCall.delete(b.toolUseId);
      const result = (n.summary ?? '').replace(/<\/?(task-notification|result)>/g, '');
      blocks ??= [...m.blocks];
      blocks.push({
        kind: 'text',
        text: `<task-notification><tool-use-id>${b.toolUseId}</tool-use-id><status>${n.status ?? 'completed'}</status><result>${result}</result></task-notification>`,
      });
    }
    // The message is replaced, not edited: the incremental reader hands the
    // same objects to several readers, and one that is mid-send must not see
    // its message grow under it.
    if (blocks) {
      const copy = { ...m, blocks };
      if (QUEUED.has(m)) QUEUED.add(copy);
      messages[at] = copy;
    }
  }
}

/**
 * The replica's stamp for the first `count` messages: the hash of the last
 * one, and — once that prefix carries any — a digest of the task notices.
 *
 * `attachTaskNotices` puts a background helper's ending on the OLD message
 * that holds its `Agent` result, not at the end. The replica syncs by
 * appending when the stamp of what it holds still matches, so a notice
 * landing on an already-replicated message was never sent: every client that
 * opens from the hub's copy (the web, the phone) drew those cards without a
 * mark or a report, while the agent's own read had both (14.10.2026). With
 * the notices in the stamp, such a change fails the match and the session is
 * re-sent whole once. A prefix without notices keeps the bare hash, so the
 * fleet's existing replicas still match and nothing re-syncs on upgrade.
 */
export function replicaStamp(messages: readonly HistoryMessage[], count: number): string {
  const tail = createHash('sha256').update(JSON.stringify(messages[count - 1])).digest('hex');
  const notices = createHash('sha256');
  let any = false;
  for (let i = 0; i < count; i++) {
    for (const b of messages[i]!.blocks) {
      if (b.kind === 'text' && b.text.startsWith('<task-notification>')) {
        notices.update(b.text);
        any = true;
      }
    }
  }
  return any ? `${tail}:${notices.digest('hex').slice(0, 16)}` : tail;
}

/** Large transcripts must be bounded by normalized message count, not bytes:
 * one screenshot/tool result can fill the old 4 MB tail by itself. */
export async function readClaudeHistory(filePath: string, limit: number, toolChars?: number): Promise<HistoryMessage[]> {
  const first = await scanClaudeHistory(filePath, limit, toolChars);
  // Same branch rule as `addQueuedPrompts`. Paid only by a transcript with a
  // mid-turn message in its window; a prompt from an abandoned branch means a
  // second scan that skips it, so it cannot evict an active message.
  if (!first.queued.size) return first.messages;
  const active = await activeBranch(filePath);
  if ([...first.queued].every((uuid) => active.has(uuid))) return first.messages;
  return (await scanClaudeHistory(filePath, limit, toolChars, active)).messages;
}

async function scanClaudeHistory(
  filePath: string,
  limit: number,
  toolChars: number | undefined,
  active?: Set<string>,
): Promise<{ messages: HistoryMessage[]; queued: Set<string> }> {
  const messages: HistoryMessage[] = [];
  const ledger = new ImageGenLedger();
  for await (const line of readJsonlLines(filePath)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record: unknown = JSON.parse(trimmed);
      // Attached at once to the window as it stands: the call's result came
      // first, and nothing is held for messages that already left it.
      const notices = taskNoticesOf(record);
      if (notices.length) attachTaskNotices(messages, notices);
      const message = parseRecord(record);
      if (message) {
        const kept = toolChars === undefined ? message : trimToolPayloads([message], toolChars)[0]!;
        if (isQueuedPrompt(record)) {
          if (active && !active.has(kept.uuid)) continue;
          insertBySendTime(messages, kept);
          QUEUED.add(kept);
        } else messages.push(kept);
        if (messages.length > limit) messages.shift();
      }
      // Pictures `hegai-image` made, right after the result that reported them.
      for (const generated of ledger.observe(record, recordTs(record))) {
        messages.push(generated);
        if (messages.length > limit) messages.shift();
      }
    } catch {
      /* skip malformed / partial records, not filesystem errors */
    }
  }
  const queued = new Set(messages.filter((m) => QUEUED.has(m)).map((m) => m.uuid));
  return { messages, queued };
}

/** Messages that came from a queued prompt, by identity — no wire field. */
const QUEUED = new WeakSet<HistoryMessage>();

interface IncrementalTranscript {
  filePath: string;
  cursor: JsonlCursor;
  /** Every message in FILE order. A queued prompt sits where the CLI absorbed
   *  it; `claudeMessagesOf` moves it to where it was sent. */
  log: HistoryMessage[];
  /** `log` holds a queued prompt (told apart by `QUEUED`, which survives the
   *  copy `attachTaskNotices` makes of a message it changes). */
  hasQueued: boolean;
  /** `hegai-image` calls seen so far: a picture's message is built when the
   *  call's RESULT arrives, so the ledger lives as long as this kept parse. */
  ledger: ImageGenLedger;
  /** uuid → parent of every non-sidechain record, and the newest such uuid:
   *  what `activeBranch` rebuilds from a second scan of the file. */
  parent: Map<string, string | undefined>;
  leaf: string | undefined;
  /** Rough parsed size, for the cache budget. Unlike Codex's parser this one
   *  does not cap tool output, so it is the figure that bounds the cache. */
  approxBytes: number;
}

const incrementalClaude = new Map<string, IncrementalTranscript>();
const incrementalClaudeLocks = new Map<string, Promise<unknown>>();

/** Forget every kept parse — for tests. */
export function resetClaudeParseCache(): void {
  incrementalClaude.clear();
  claudeParseTooLarge.clear();
}

/** About what one `parent` entry costs: the uuid, the parent's uuid, the node. */
const BRANCH_ENTRY_BYTES = 160;

/** One transcript line into the entry: exactly what `scanClaudeHistory` does
 *  per record, plus the branch bookkeeping `activeBranch` does per record. */
function pushClaudeLine(entry: IncrementalTranscript, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return; // a malformed or torn record
  }
  const r = record as { uuid?: unknown; parentUuid?: unknown; logicalParentUuid?: unknown; isSidechain?: unknown } | null;
  if (typeof r?.uuid === 'string' && r.isSidechain !== true) {
    const up = typeof r.parentUuid === 'string' ? r.parentUuid : typeof r.logicalParentUuid === 'string' ? r.logicalParentUuid : undefined;
    if (!entry.parent.has(r.uuid)) entry.approxBytes += BRANCH_ENTRY_BYTES;
    entry.parent.set(r.uuid, up);
    entry.leaf = r.uuid;
  }
  try {
    const notices = taskNoticesOf(record);
    if (notices.length) attachTaskNotices(entry.log, notices);
    const message = parseRecord(record);
    if (message) {
      if (isQueuedPrompt(record)) {
        QUEUED.add(message);
        entry.hasQueued = true;
      }
      entry.log.push(message);
      entry.approxBytes += JSON.stringify(message).length;
    }
    for (const generated of entry.ledger.observe(record, recordTs(record))) {
      entry.log.push(generated);
      entry.approxBytes += JSON.stringify(generated).length;
    }
  } catch {
    /* skip a record that does not parse into a message */
  }
}

/** A fresh array, the same messages `readClaudeHistory(file, Infinity)` returns. */
function claudeMessagesOf(entry: IncrementalTranscript): HistoryMessage[] {
  if (!entry.hasQueued) return entry.log.slice();
  // The same branch rule as `activeBranch`: a queued prompt counts only if it
  // is an ancestor of the newest record. Replaying the log (instead of
  // inserting at read time into a kept result) keeps a dead prompt from ever
  // having influenced where a live one lands.
  const active = new Set<string>();
  // A record over MAX_LINE_BYTES is skipped unparsed, so its uuid never enters
  // `parent` and the walk stops there. Read that gap as "branch unknown" and
  // keep every queued prompt — dropping all of them would lose real messages.
  let gap = false;
  for (let at = entry.leaf; at !== undefined && !active.has(at); at = entry.parent.get(at)) {
    active.add(at);
    if (!entry.parent.has(at)) {
      gap = true;
      break;
    }
  }
  const messages: HistoryMessage[] = [];
  for (const message of entry.log) {
    if (!QUEUED.has(message)) messages.push(message);
    else if (gap || active.has(message.uuid)) insertBySendTime(messages, message);
  }
  return messages;
}

/**
 * The whole parsed transcript of one Claude session, plus the file's size.
 *
 * A big transcript is parsed ONCE and then only its new bytes are read — the
 * same mechanics as `readCodexTranscript`. Streaming and parsing a 31 MB
 * transcript on every read took 3 s idle and 6-18 s on a loaded box: the
 * history RPC missed the hub's 6 s deadline and was answered from a replica
 * that had stopped at the old 25 MB cap, so every client showed the session
 * frozen (14.10.2026). The result is exactly what `readClaudeHistory(file,
 * Infinity)` returns for the same bytes; the replica's append check hashes
 * these messages.
 *
 * Callers get a fresh array and must not mutate the messages in it.
 */
export async function readClaudeTranscript(
  sessionId: string,
): Promise<{ messages: HistoryMessage[]; size: number } | null> {
  return serializedBy(incrementalClaudeLocks, sessionId, () => readClaudeTranscriptLocked(sessionId));
}

async function readClaudeTranscriptLocked(
  sessionId: string,
): Promise<{ messages: HistoryMessage[]; size: number } | null> {
  const found = await findClaudeTranscript(sessionId);
  if (!found) {
    incrementalClaude.delete(sessionId);
    return null;
  }
  const filePath = found.filePath;
  // A transcript that cannot be READ is not an empty one — let it throw (the
  // replica path skips the sync, the history RPC answers with an error)
  // rather than hand back `[]` that reads as "the session lost its messages".
  const handle = await open(filePath, 'r');
  try {
    const st = await handle.stat();
    if (st.size > CLAUDE_TRANSCRIPT_MAX_BYTES) {
      incrementalClaude.delete(sessionId);
      throw new TranscriptTooLargeError(
        `Claude transcript is ${Math.round(st.size / 1e6)} MB, over the ${Math.round(CLAUDE_TRANSCRIPT_MAX_BYTES / 1e6)} MB read limit`,
      );
    }
    const tooLarge = claudeParseTooLarge.get(sessionId);
    if (tooLarge && tooLarge.filePath === filePath && (await cursorStillExtends(tooLarge.cursor, handle, st))) {
      incrementalClaude.delete(sessionId);
      throw new TranscriptTooLargeError(`Claude transcript parses to over ${Math.round(CLAUDE_PARSE_MAX_BYTES / 1e6)} MB`);
    }
    claudeParseTooLarge.delete(sessionId);
    let entry = incrementalClaude.get(sessionId);
    if (entry && (entry.filePath !== filePath || !(await cursorStillExtends(entry.cursor, handle, st)))) {
      incrementalClaude.delete(sessionId);
      entry = undefined;
    }
    const keep = entry !== undefined || st.size >= INCREMENTAL_MIN_BYTES;
    const target: IncrementalTranscript = (entry ??= {
      filePath,
      cursor: newCursor(st),
      log: [],
      hasQueued: false,
      ledger: new ImageGenLedger(),
      parent: new Map(),
      leaf: undefined,
      approxBytes: 0,
    });
    try {
      await advanceJsonl(target.cursor, handle, st.size, (line) => {
        pushClaudeLine(target, line);
        // Checked per line, not after: the point is never to hold the parse.
        if (target.approxBytes > CLAUDE_PARSE_MAX_BYTES) {
          throw new TranscriptTooLargeError(`Claude transcript parses to over ${Math.round(CLAUDE_PARSE_MAX_BYTES / 1e6)} MB`);
        }
      });
    } catch (err) {
      // A parse cut short has an unknown offset; start over next time.
      incrementalClaude.delete(sessionId);
      if (err instanceof TranscriptTooLargeError) {
        const len = Math.min(PARSE_TOO_LARGE_GUARD_BYTES, st.size);
        const guard = Buffer.alloc(len);
        const { bytesRead } = await handle.read(guard, 0, len, st.size - len);
        if (bytesRead === len) {
          claudeParseTooLarge.set(sessionId, { filePath, cursor: { dev: st.dev, ino: st.ino, offset: st.size, guard } });
        }
      }
      throw err;
    }
    if (keep) keepBounded(incrementalClaude, sessionId, target);
    return { messages: claudeMessagesOf(target), size: st.size };
  } finally {
    await handle.close();
  }
}

/**
 * Normalize one raw transcript `.jsonl` record (a parsed line) into a
 * HistoryMessage, or null for non-message records (summary, file-history-
 * snapshot, sidechain meta, blockless turns). Used by the live mirror tail and
 * by `loadHistory` for the SDK's own records, which carry the same fields.
 *
 * Two records get special treatment, because the transcript stores them as
 * something they are not:
 *
 * - `system` / `compact_boundary` is the seam where the runtime replaced the
 *   earlier turns with a summary. Every other `system` record (hook output,
 *   CLI caveats) is dropped, as the live stream drops them; this one is kept
 *   as a `compact_boundary` block so a reload shows the same seam the live
 *   `compact_done` line showed.
 * - a `user` record flagged `isCompactSummary` is that summary. Rendered as
 *   the person's own words it was a multi-kilobyte turn nobody typed; it
 *   becomes a `system` message with a `compact_summary` block that clients
 *   fold.
 */
/**
 * A message the person sent WHILE the turn was running. The CLI does not write
 * it as a `user` record: it queues it and, at the next tool boundary, folds it
 * into the turn as an `attachment` of type `queued_command` (the model sees it
 * as «The user sent a new message while you were working»). `prompt` is the
 * message content as sent — a string, or text and image blocks.
 *
 * Read as noise, these turns were missing from every history read
 * (10.10.2026): the phone kept its live copy of the turn next to a history
 * that lacked it, could not line the two up and drew the question, the
 * reply and a «[картинка]» bubble twice; the picture never loaded because no
 * history block carried its ref; the web simply lost the message on reload.
 *
 * A `task-notification` rides the same queue — that is the CLI talking to
 * itself about a background task, not the person, and stays out.
 */
function isQueuedPrompt(rec: unknown): boolean {
  const r = rec as { type?: unknown; attachment?: { type?: unknown; commandMode?: unknown; origin?: { kind?: unknown } } };
  if (r?.type !== 'attachment' || r.attachment?.type !== 'queued_command') return false;
  const mode = r.attachment.commandMode;
  if (mode !== undefined && mode !== 'prompt') return false;
  return r.attachment.origin?.kind === undefined || r.attachment.origin.kind === 'human';
}

/**
 * Place a queued prompt where the person SENT it, not where the CLI absorbed
 * it. Every client showed the message at send time (the hub's `user_turn`),
 * and the reply text streamed between send and the next tool boundary came
 * after it on screen; in file order it would come before, and history and the
 * live copy would disagree about the turn again. Both stamps come from the
 * agent's clock, so the comparison is consistent.
 */
function insertBySendTime(messages: HistoryMessage[], queued: HistoryMessage): void {
  let at = messages.length;
  if (queued.ts !== undefined) {
    while (at > 0) {
      const ts = messages[at - 1]!.ts;
      if (ts === undefined || ts <= queued.ts) break;
      at--;
    }
  }
  messages.splice(at, 0, queued);
}

/**
 * The SDK's reader returns only `user` / `assistant` / `system` records, so
 * the queued prompts (see `isQueuedPrompt`) are picked from the file itself
 * and placed among them. Sessions without mid-turn messages pay one read with
 * a substring test per line.
 *
 * The SDK follows the active branch after a rewind; so must this. A queued
 * prompt counts only if it is an ancestor of the file's newest record — the
 * CLI always appends to the branch it is on (`parentUuid`, or
 * `logicalParentUuid` across a compaction seam).
 */
/** Returns the `source_uuid` of every queued record the scan read: the SDK's
 *  own copies of those are owned here (`splitSdkQueuedCopies`). */
async function addQueuedPrompts(sessionId: string, messages: HistoryMessage[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const transcript = await findClaudeTranscript(sessionId);
  if (!transcript) return seen;
  try {
    // Parsed on the spot: a history message keeps a picture's ref, not its
    // base64, so holding these until the branch is known costs next to nothing.
    const queued: HistoryMessage[] = [];
    const notices: TaskNotice[] = [];
    for await (const line of readJsonlLines(transcript.filePath)) {
      if (!line.includes('"queued_command"')) continue;
      try {
        const record: unknown = JSON.parse(line.trim());
        const source = (record as { attachment?: { source_uuid?: unknown } } | null)?.attachment?.source_uuid;
        if (typeof source === 'string') seen.add(source);
        notices.push(...taskNoticesOf(record));
        const message = isQueuedPrompt(record) ? parseRecord(record) : null;
        if (message) queued.push(message);
      } catch {
        /* a partial last line */
      }
    }
    attachTaskNotices(messages, notices);
    if (!queued.length) return seen;
    // One uuid → parent pair per record (~100 bytes): bounded by the file
    // the caller already agreed to read whole.
    const active = await activeBranch(transcript.filePath);
    for (const message of queued) {
      if (!active.has(message.uuid) || messages.some((m) => m.uuid === message.uuid)) continue;
      insertBySendTime(messages, message);
    }
  } catch {
    /* the history the SDK returned is still the history — with its own copies */
    seen.clear();
  }
  return seen;
}

/** Every record uuid on the branch ending at the file's newest record. */
async function activeBranch(filePath: string): Promise<Set<string>> {
  const parent = new Map<string, string | undefined>();
  let leaf: string | undefined;
  for await (const line of readJsonlLines(filePath)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let r: { uuid?: unknown; parentUuid?: unknown; logicalParentUuid?: unknown; isSidechain?: unknown };
    try {
      r = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof r?.uuid !== 'string' || r.isSidechain === true) continue;
    const up = typeof r.parentUuid === 'string' ? r.parentUuid : typeof r.logicalParentUuid === 'string' ? r.logicalParentUuid : undefined;
    parent.set(r.uuid, up);
    leaf = r.uuid;
  }
  const branch = new Set<string>();
  for (let at = leaf; at !== undefined && !branch.has(at); at = parent.get(at)) branch.add(at);
  return branch;
}

function recordTs(record: unknown): number | undefined {
  return parseTimestamp((record as { timestamp?: unknown } | null)?.timestamp);
}

/** `[Image: source: <path>]` (one or several), the CLI's note of a pasted picture. */
const IMAGE_SOURCE_MARKER = /^(\[Image: source: [^\]\n]+\]\s*)+$/;

export function parseRecord(rec: unknown): HistoryMessage | null {
  const r = rec as {
    type?: unknown;
    subtype?: unknown;
    uuid?: unknown;
    message?: unknown;
    timestamp?: unknown;
    isCompactSummary?: unknown;
    isMeta?: unknown;
    compactMetadata?: { trigger?: unknown; preTokens?: unknown; postTokens?: unknown };
  };
  if (r?.uuid == null) return null;
  const ts = parseTimestamp(r.timestamp);
  const stamp = ts === undefined ? {} : { ts };
  if (isQueuedPrompt(rec)) {
    const prompt = (rec as { attachment: { prompt?: unknown } }).attachment.prompt;
    const blocks = parseBlocks({ content: prompt }, String(r.uuid)).filter(
      (b) => !(b.kind === 'text' && IMAGE_SOURCE_MARKER.test(b.text.trim())),
    );
    return blocks.length ? { type: 'user', uuid: String(r.uuid), blocks, ...stamp } : null;
  }
  if (r.type === 'system') {
    if (r.subtype !== 'compact_boundary') return null;
    const meta = r.compactMetadata ?? {};
    return {
      type: 'system',
      uuid: String(r.uuid),
      blocks: [
        {
          kind: 'compact_boundary',
          trigger: meta.trigger === 'auto' ? 'auto' : 'manual',
          ...(typeof meta.preTokens === 'number' ? { preTokens: meta.preTokens } : {}),
          ...(typeof meta.postTokens === 'number' ? { postTokens: meta.postTokens } : {}),
        },
      ],
      ...stamp,
    };
  }
  if (r.type !== 'user' && r.type !== 'assistant') return null;
  if (r.message == null) return null;
  // What the CLI writes FOR itself: `isMeta` user records are its own
  // injections — «[Image: source: /tmp/claude-<uid>/…/images/8.png]» beside every
  // pasted picture, a skill's «Base directory for this skill: …» body. Nobody
  // typed them, and rendered as the person's turns they were a column of file
  // paths under every message with a screenshot (27.09.2026). The SDK reader
  // already leaves them out; the streaming reader for big transcripts did not.
  if (r.type === 'user' && r.isMeta === true) return null;
  if (r.type === 'user' && r.isCompactSummary === true) {
    const text = asText((r.message as { content?: unknown }).content).trim();
    if (!text) return null;
    return { type: 'system', uuid: String(r.uuid), blocks: [{ kind: 'compact_summary', text }], ...stamp };
  }
  const parsed = parseBlocks(r.message, String(r.uuid));
  // The same marker without the flag (older CLIs wrote it inline): a text block
  // that is ONLY an image-source path is the CLI's bookkeeping, not prose.
  const blocks =
    r.type === 'user' ? parsed.filter((b) => !(b.kind === 'text' && IMAGE_SOURCE_MARKER.test(b.text.trim()))) : parsed;
  if (blocks.length === 0) return null;
  // Which model wrote the turn. `<synthetic>` is the CLI's own stand-in for
  // messages no model produced (an interrupt notice, an API error) — not a model.
  const model = r.type === 'assistant' ? (r.message as { model?: unknown }).model : undefined;
  const named = typeof model === 'string' && model && !model.startsWith('<') ? { model } : {};
  return { type: r.type, uuid: String(r.uuid), blocks, ...stamp, ...named };
}

/** Transcript records carry an ISO `timestamp`. Return ms since epoch, or
 *  undefined when it's missing or unparseable — the UI shows no time rather
 *  than a wrong one. (zod `optional` means absent, never null.) */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * One attachment's bytes, by the `ref` its history block carried.
 *
 * The ref is `uuid#index`: the message's own id in the transcript and which
 * content block of it. Both halves are already in the file, so this needs no
 * index, cache or new state. Scan the same file as `loadHistory`, so a marker
 * before a huge tool result still resolves when older speech becomes visible.
 *
 * Returns null rather than throwing for every "not found" case — a stale ref
 * after a compaction is ordinary, not an error, and the client draws the
 * placeholder it drew before.
 */
export async function loadImage(
  sessionId: string,
  ref: string,
): Promise<{ mediaType: string; dataB64: string } | null> {
  const generated = parseGenRef(ref);
  if (generated) return loadGeneratedImage(sessionId, generated.toolUseId, generated.n);
  if (ref.startsWith('gen:')) return null;
  const hash = ref.lastIndexOf('#');
  if (hash <= 0) return null;
  const uuid = ref.slice(0, hash);
  const index = Number(ref.slice(hash + 1));
  if (!Number.isInteger(index) || index < 0) return null;

  const transcript = await findClaudeTranscript(sessionId);
  if (!transcript) return null;
  for await (const line of readJsonlLines(transcript.filePath)) {
    const trimmed = line.trim();
    // Cheap reject before the JSON parse: these lines are megabytes of base64
    // each, and parsing every one of them to find a uuid we can see as a
    // substring would be the expensive way to do nothing.
    if (!trimmed || !trimmed.includes(uuid)) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const r = record as { uuid?: unknown; message?: { content?: unknown }; attachment?: { prompt?: unknown } } | null;
    if (!r || String(r.uuid ?? '') !== uuid) continue;
    // A picture sent mid-turn lives in the queued prompt (see `isQueuedPrompt`).
    const content = isQueuedPrompt(r) ? r.attachment?.prompt : r.message?.content;
    if (!Array.isArray(content)) return null;
    const block = content[index] as Record<string, unknown> | undefined;
    if (!block || block['type'] !== 'image') return null;
    const source = block['source'] as Record<string, unknown> | undefined;
    // Only the inline base64 form is answerable here. A `url` source is someone
    // else's bytes on someone else's host, and fetching it would make this
    // agent a proxy for arbitrary URLs on behalf of a browser.
    if (!source || source['type'] !== 'base64') return null;
    const dataB64 = String(source['data'] ?? '');
    const mediaType = String(source['media_type'] ?? 'image/png');
    return dataB64 ? { mediaType, dataB64 } : null;
  }
  return null;
}

/** Largest generated picture the agent will read off disk and hand to the hub.
 *  Base64 grows it by a third and the answer must clear the hub's 32 MiB WS
 *  frame BEFORE the hub shrinks it — an oversize answer closes the agent socket
 *  and every live run on the machine with it. 15 MB → ~20 MiB of base64. */
export const GENERATED_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/** Media type from magic bytes — PNG, JPEG or WebP, nothing else. */
function sniffImageBytes(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * `gen:<toolUseId>#<n>` — the n-th picture a `hegai-image` Bash call made.
 *
 * The path is NEVER taken from the client: it is read out of this session's own
 * transcript (the call's output line n, or — while the result is not written
 * yet — the command's output argument for n = 0) and resolved against the cwd
 * the transcript recorded for the call. Whatever the model printed there, only
 * a regular file ≤ 15 MB, not a symlink, that really starts like a PNG/JPEG/WebP
 * is returned, and only from the call's own working folder (or the temp dir,
 * on an unconfined machine).
 */
async function loadGeneratedImage(
  sessionId: string,
  toolUseId: string,
  n: number,
): Promise<{ mediaType: string; dataB64: string } | null> {
  const transcript = await findClaudeTranscript(sessionId);
  if (!transcript) return null;
  let calls: ReturnType<typeof parseImageGenCalls> = [];
  let cwd: string | undefined;
  let output: string | undefined;
  let useTs: number | undefined;
  let resultTs: number | undefined;
  for await (const line of readJsonlLines(transcript.filePath)) {
    // Cheap reject before the JSON parse — other lines are megabytes of base64.
    if (!line.includes(toolUseId)) continue;
    let record: { type?: unknown; cwd?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
    try {
      record = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (record.isSidechain === true || !Array.isArray(record.message?.content)) continue;
    for (const block of record.message!.content as Array<Record<string, unknown>>) {
      if (record.type === 'assistant' && block['type'] === 'tool_use' && block['id'] === toolUseId && block['name'] === 'Bash') {
        const c = (block['input'] as { command?: unknown } | null)?.command;
        const parsed = typeof c === 'string' && !isBackgroundBash(block['input']) ? parseImageGenCalls(c) : [];
        if (parsed.length) {
          calls = parsed;
          cwd = typeof record.cwd === 'string' ? record.cwd : undefined;
          useTs = recordTs(record);
        }
      } else if (record.type === 'user' && block['type'] === 'tool_result' && block['tool_use_id'] === toolUseId) {
        if (block['is_error'] === true) return null;
        output = asText(block['content']);
        resultTs = recordTs(record);
      }
    }
    if (output !== undefined) break;
  }
  if (!calls.length || cwd === undefined) return null;
  const typed = output !== undefined ? parseImageOutputs(output)[n] : n === 0 ? calls[0]!.out : undefined;
  if (!typed || typed.includes('\0')) return null;
  // Which call printed it decides the folder; unknown (several calls, no exact
  // match) or `cd "$X" && …` → only an absolute path is resolvable.
  const call = callForOutput(calls, typed);
  if ((!call || call.dirUnknown) && !path.isAbsolute(typed)) return null;
  try {
    const wanted = path.resolve(cwd, call?.dir ?? '.', typed);
    // The folder is resolved once; the file itself is opened WITHOUT following a
    // symlink, and every check below reads that one handle — a process swapping
    // the name for a link between check and read gets ELOOP, not a foreign file.
    const dir = await realpath(path.dirname(wanted));
    const roots = [await realpath(cwd)];
    // `hegai-image … /tmp/x.png` is common; a confined machine keeps to its folder.
    if (confinePrefix() === undefined) roots.push(await realpath(os.tmpdir()).catch(() => os.tmpdir()));
    const inside = (root: string): boolean => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    if (!roots.some(inside)) return null;
    const target = path.join(dir, path.basename(wanted));
    const fh = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      // O_NOFOLLOW guards the last component only: a parent folder swapped for
      // a link after the check above would still be followed. So ask the
      // descriptor where it really is (as `openRollout` does in confine.ts).
      if (process.platform === 'linux') {
        const opened = await readlink(`/proc/self/fd/${fh.fd}`);
        if (!roots.some((root) => opened.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) return null;
      } else {
        const [st0, link] = await Promise.all([fh.stat(), lstat(target)]);
        if (link.isSymbolicLink() || st0.ino !== link.ino || st0.dev !== link.dev) return null;
        const real = await realpath(target);
        if (!roots.some((root) => real.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) return null;
      }
      const st = await fh.stat();
      if (!st.isFile() || st.size === 0 || st.size > GENERATED_IMAGE_MAX_BYTES) return null;
      // A leftover from an earlier run under the same name is a wrong picture, and
      // «недоступна» is better than that: the file must have been written during
      // the call (clock skew margin 5 s before it, 120 s after its result).
      if (useTs !== undefined && st.mtimeMs < useTs - 5_000) return null;
      if (resultTs !== undefined && st.mtimeMs > resultTs + 120_000) return null;
      const bytes = Buffer.alloc(st.size);
      let filled = 0;
      while (filled < st.size) {
        const { bytesRead } = await fh.read(bytes, filled, st.size - filled, filled);
        if (bytesRead === 0) return null; // shrank under us: a half picture is no picture
        filled += bytesRead;
      }
      const mediaType = sniffImageBytes(bytes);
      if (!mediaType) return null;
      return { mediaType, dataB64: bytes.toString('base64') };
    } finally {
      await fh.close();
    }
  } catch {
    return null; // not written yet, moved, or unreadable: the client retries or gives up
  }
}
