import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { HistoryMessage, RenderBlock, SessionSummary } from '@cc-remote/shared';
import { readFileHead, readFileTail } from './file-range.js';
import {
  INCREMENTAL_MIN_BYTES,
  MAX_LINE_BYTES,
  advanceJsonl,
  cursorStillExtends,
  keepBounded,
  newCursor,
  serializedBy,
  type JsonlCursor,
} from './jsonl-incremental.js';
import { parseTimestamp, trimToolPayloads } from './history.js';
import { stateDir } from './config.js';
import { ConfineError, assertRolloutPath, codexSessionRoots, confinePrefix, cwdBelongsToUnitHome, cwdUnitKey, openRollout, pickHome, unitHomeKeyOf } from './confine.js';
import { isProbePrompt } from './probe-prompt.js';
import { GO_PROVIDER_ID } from './opencode-go.js';

/**
 * Read-only OpenAI Codex session support.
 *
 * Codex stores append-only rollout transcripts below
 * `~/.codex/sessions/YYYY/MM/DD`. This module owns the complete lifecycle for
 * those files: discovery, exact-id lookup, bounded inventory parsing, history
 * parsing, and mirror helpers. Keeping those operations together prevents the
 * inventory and live mirror from slowly acquiring different lookup/parsing
 * rules.
 */

/** Resolved per call, not at import: a module-level const would freeze
 *  `CODEX_HOME` as it looked when this file first loaded, which is both a lie
 *  on a machine that sets it later and untestable. */
function codexSessionsDirs(): string[] {
  // With CC_REMOTE_CONFINE_RUNS each matter keeps its rollouts in its own
  // CODEX_HOME (~/.codex-units/*); the agent reads all of them.
  return codexSessionRoots(process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'));
}
const CODEX_HEAD_BYTES = 512 * 1024;
const TOOL_RESULT_CAP = 8000;
const DISCOVERY_POOL_SIZE = 12;
const STAT_POOL_SIZE = 64;

interface RolloutFile {
  filePath: string;
  mtimeMs: number;
  size: number;
}

interface ParsedCodexDocument {
  messages: HistoryMessage[];
  meta?: Record<string, unknown>;
  title?: string;
}

function projectLabel(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const cleaned = cwd.replace(/[\\/]+$/, '');
  return cleaned.split(/[\\/]/).pop() || undefined;
}

/** The uuid embedded at the end of a rollout filename, or null. */
export function codexUuidFromFilename(filePath: string): string | null {
  const match = /rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/.exec(path.basename(filePath));
  return match?.[1] ?? null;
}

/** Recursively list rollout files, newest first, with one stat per file. */
export async function listRollouts(): Promise<RolloutFile[]> {
  const out: RolloutFile[] = [];
  for (const root of codexSessionsDirs()) out.push(...(await listRolloutsIn(root)));
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Directory levels below a sessions root: YYYY/MM/DD. */
const SESSIONS_MAX_DEPTH = 3;

/**
 * Walk a UNIT home's sessions dir by hand. The sandbox owns that tree, so
 * nothing in it is trusted: the root must be a plain directory (a symlink there
 * would make every refresh traverse an arbitrary host tree), every directory is
 * lstat'ed before it is entered, symlinks are never followed, and the depth is
 * the real layout's. Returns paths relative to `root`.
 */
async function walkUnitSessions(root: string): Promise<string[]> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return [];
  const out: string[] = [];
  const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (depth >= SESSIONS_MAX_DEPTH) continue;
        const child = path.join(dir, entry.name);
        const info = await lstat(child).catch(() => null);
        if (info?.isDirectory() && !info.isSymbolicLink()) await visit(child, childRel, depth + 1);
      } else {
        out.push(childRel);
      }
    }
  };
  await visit(root, '', 0);
  return out;
}

async function listRolloutsIn(root: string): Promise<RolloutFile[]> {
  let entries: string[];
  try {
    // Unconfined and the machine's own ~/.codex: exactly the old recursive read.
    entries = confinePrefix() !== undefined && unitHomeKeyOf(root) !== undefined
      ? await walkUnitSessions(root)
      : await readdir(root, { recursive: true });
  } catch {
    return [];
  }

  const out: RolloutFile[] = [];
  // A long-lived workstation can have tens of thousands of rollouts. Stat them
  // in bounded batches so discovery cannot exhaust file descriptors or create a
  // giant Promise fan-out before the bounded head-parser pool even starts.
  for (let i = 0; i < entries.length; i += STAT_POOL_SIZE) {
    const batch = await Promise.all(
      entries.slice(i, i + STAT_POOL_SIZE).map(async (relativePath): Promise<RolloutFile | null> => {
      const base = path.basename(relativePath);
      if (!base.startsWith('rollout-') || !base.endsWith('.jsonl')) return null;
      const filePath = path.join(root, relativePath);
      try {
        // lstat, not stat: in a confined run the rollout dir is writable by the
        // sandboxed process, and a symlink there must not lend another unit's
        // transcript to this unit's session id.
        const fileStat =
          confinePrefix() !== undefined && unitHomeKeyOf(filePath) !== undefined
            ? await lstat(filePath)
            : await stat(filePath);
        if (fileStat.isFile()) {
          return { filePath, mtimeMs: fileStat.mtimeMs, size: fileStat.size };
        }
      } catch {
        /* vanished between readdir and stat */
      }
      return null;
      }),
    );
    for (const file of batch) if (file) out.push(file);
  }
  return out;
}

/** Injected/wrapper user text that must be dropped from the transcript. */
export function isInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<user_instructions>') ||
    trimmed.startsWith('<permissions instructions>') ||
    trimmed.startsWith('<collaboration_mode>') ||
    // Newer CLIs prepend this; without it the wrapper text became the session
    // TITLE, so the list read "<recommended_plugins> Here is a list of…".
    trimmed.startsWith('<recommended_plugins>') ||
    // Codex Desktop (ChatGPT app) puts the app's open page in front of the
    // first prompt as a `role:user` message, so the list read
    // `{"page_id":null}` for every thread started there (08.10.2026).
    trimmed.startsWith('<external_codex_apps_') ||
    trimmed.startsWith('# AGENTS.md')
  );
}

/** Codex Desktop tags each message it writes with what produced it:
 *  `user.text` / `user.image` for what the person sent, `additional_content.*`
 *  for context the app adds (open page, client time, instructions). A
 *  `role:user` message carrying only the latter is the app talking, not the
 *  person — the structural twin of the text prefixes above, for wrappers
 *  that have not been seen yet. Messages without the tag (the CLI) pass. */
function isAppAuthoredUserMessage(payload: Record<string, unknown>): boolean {
  const meta = payload['internal_chat_message_metadata_passthrough'];
  if (!meta || typeof meta !== 'object') return false;
  const kinds = (meta as Record<string, unknown>)['content_item_kinds'];
  return (
    Array.isArray(kinds) &&
    kinds.length > 0 &&
    kinds.every((kind) => typeof kind === 'string' && !kind.startsWith('user.'))
  );
}

/** Stable 128-bit content id; avoids 32-bit collisions in very long rollouts. */
function lineId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function flattenOutput(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value)) {
    const joined = value
      .map((part) => {
        const item = part as Record<string, unknown>;
        return typeof item['text'] === 'string'
          ? item['text']
          : typeof item['output'] === 'string'
            ? item['output']
            : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    text = joined || JSON.stringify(value);
  } else if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    text =
      typeof item['text'] === 'string'
        ? item['text']
        : typeof item['output'] === 'string'
          ? item['output']
          : JSON.stringify(value);
  } else {
    text = value == null ? '' : JSON.stringify(value);
  }
  return text.slice(0, TOOL_RESULT_CAP);
}

const IMAGE_OPEN = /^<image\b[^>]*>$/i;
const IMAGE_CLOSE = /^<\/image>$/i;

/** Codex writes a local-image turn three times: an opening pseudo-tag as
 * `input_text`, the actual `input_image`, then `</image>` as more text. The
 * pseudo-tags are transport wrappers, not words the person typed. Strip them
 * only when the same message really carries an image so a legitimate prompt
 * containing `<image>` remains untouched. */
function messageContent(
  content: unknown,
  wanted: 'input_text' | 'output_text',
  messageId?: string,
): { text: string; images: RenderBlock[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };

  const hasImage = content.some((raw) => {
    const part = raw as Record<string, unknown>;
    return part['type'] === 'input_image' || part['type'] === 'image';
  });
  const text: string[] = [];
  const images: RenderBlock[] = [];
  content.forEach((raw, index) => {
    const part = raw as Record<string, unknown>;
    if ((part['type'] === wanted || part['type'] === 'text') && typeof part['text'] === 'string') {
      const value = part['text'];
      if (hasImage && (IMAGE_OPEN.test(value.trim()) || IMAGE_CLOSE.test(value.trim()))) return;
      text.push(value);
      return;
    }
    if (part['type'] === 'input_image' || part['type'] === 'image') {
      images.push({ kind: 'image', ...(messageId ? { ref: `${messageId}#${index}` } : {}) });
    }
  });
  return { text: text.join('\n'), images };
}

/** Normalize one Codex rollout record into a render-ready history message,
 *  stamped with the rollout line's timestamp when it has one. */
export function parseCodexRecord(record: unknown, rawLine: string): HistoryMessage | null {
  const msg = parseCodexPayload(record, rawLine);
  if (!msg) return null;
  const ts = parseTimestamp((record as { timestamp?: unknown })?.timestamp);
  return ts === undefined ? msg : { ...msg, ts };
}

function parseCodexPayload(record: unknown, rawLine: string): HistoryMessage | null {
  const rollout = record as {
    type?: string;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  if (rollout?.type !== 'response_item' || !rollout.payload) return null;

  const payload = rollout.payload;
  const uuid = `codex-${lineId(rawLine)}`;
  const payloadType = payload['type'];

  switch (payloadType) {
    case 'message': {
      const role = payload['role'];
      if (role === 'developer') return null;
      if (role === 'user') {
        if (isAppAuthoredUserMessage(payload)) return null;
        const { text, images } = messageContent(
          payload['content'],
          'input_text',
          typeof payload['id'] === 'string' && payload['id'] ? payload['id'] : undefined,
        );
        if (text && isInjectedUserText(text)) return null;
        const blocks: RenderBlock[] = [];
        if (text.trim()) blocks.push({ kind: 'text', text });
        blocks.push(...images);
        return blocks.length ? { type: 'user', uuid, blocks } : null;
      }
      const { text } = messageContent(payload['content'], 'output_text');
      return text.trim()
        ? { type: 'assistant', uuid, blocks: [{ kind: 'text', text }] }
        : null;
    }

    case 'reasoning': {
      const summary = Array.isArray(payload['summary'])
        ? (payload['summary'] as Array<Record<string, unknown>>)
        : [];
      const text = summary
        .map((item) => (typeof item['text'] === 'string' ? item['text'] : ''))
        .filter(Boolean)
        .join('\n');
      return text.trim()
        ? { type: 'assistant', uuid, blocks: [{ kind: 'thinking', text }] }
        : null;
    }

    case 'function_call':
    case 'custom_tool_call':
      return {
        type: 'assistant',
        uuid,
        blocks: [
          {
            kind: 'tool_use',
            id: String(payload['call_id'] ?? ''),
            name: String(payload['name'] ?? 'tool'),
            input: safeJson(payload['arguments'] ?? payload['input']),
          },
        ],
      };

    case 'function_call_output':
    case 'custom_tool_call_output':
      return {
        type: 'user',
        uuid,
        blocks: [
          {
            kind: 'tool_result',
            toolUseId: String(payload['call_id'] ?? ''),
            text: flattenOutput(payload['output'] ?? payload['content'] ?? payload['result']),
            isError: false,
          },
        ],
      };

    case 'web_search_call':
    case 'tool_search_call':
      return {
        type: 'assistant',
        uuid,
        blocks: [
          {
            kind: 'tool_use',
            id: String(payload['call_id'] ?? payload['id'] ?? ''),
            name: String(payloadType),
            input: payload['action'] ?? payload,
          },
        ],
      };

    case 'tool_search_output':
      return {
        type: 'user',
        uuid,
        blocks: [
          {
            kind: 'tool_result',
            toolUseId: String(payload['call_id'] ?? ''),
            text: flattenOutput(payload['output'] ?? payload['content'] ?? payload['result']),
            isError: false,
          },
        ],
      };

    // A picture the model made with its built-in `image_gen` tool. One line
    // carries the whole PNG as base64 (1-3 MB) — it NEVER enters the history;
    // the block only holds a `gen:` ref that `loadCodexImage` resolves.
    case 'image_generation_call': {
      // Records the compaction request wrote (`metadata.compaction_output`) are
      // the compactor's own scratch: measured on real rollouts they are
      // throwaway pictures ("No image requested", "A blank white image"), and
      // the real ones are never replayed as response_items (the replay lives
      // inside the `compacted` record). Drawing them would show junk.
      if (rollout.metadata?.['compaction_output'] === true) return null;
      const id = typeof payload['id'] === 'string' ? payload['id'] : '';
      if (!id || payload['status'] !== 'completed') return null;
      const result = payload['result'];
      // An empty result with a fileId is the attachment-store shape; there is
      // nothing to resolve from the rollout, so no card rather than a dead one.
      if (typeof result !== 'string' || !result) return null;
      return {
        type: 'assistant',
        uuid,
        blocks: [{ kind: 'image', ref: `gen:${id}`, generated: true, ...imagePromptField(payload['revised_prompt']) }],
      };
    }

    default:
      return null;
  }
}

const JUNK_IMAGE_PROMPTS = new Set(['no image requested']);

/** `{prompt}` for a generated image block, or nothing when the text is empty or
 *  the generator's placeholder. Clipped to the wire limit (4000). */
function imagePromptField(value: unknown): { prompt?: string } {
  if (typeof value !== 'string') return {};
  const text = value.trim();
  if (!text || JUNK_IMAGE_PROMPTS.has(text.toLowerCase())) return {};
  return { prompt: text.slice(0, 4000) };
}

/** Parse each JSONL record once, collecting metadata, title, and messages. */
class CodexDocumentParser {
  readonly document: ParsedCodexDocument = { messages: [] };
  private legacyTitle: string | undefined;

  constructor(private limit?: number, private toolChars?: number) {}

  push(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const record = JSON.parse(trimmed) as {
        type?: unknown;
        payload?: unknown;
      };
      const payload =
        record.payload && typeof record.payload === 'object'
          ? (record.payload as Record<string, unknown>)
          : undefined;

      if (!this.document.meta && record.type === 'session_meta' && payload) {
        this.document.meta = payload;
      }
      if (
        !this.legacyTitle &&
        record.type === 'event_msg' &&
        payload?.['type'] === 'user_message' &&
        typeof payload['message'] === 'string' &&
        !isInjectedUserText(payload['message'])
      ) {
        this.legacyTitle = payload['message'].trim();
      }

      if (record.type === 'compacted' && payload) {
        const compactedMessage = typeof payload['message'] === 'string' ? payload['message'].trim() : '';
        const previous = this.document.messages[this.document.messages.length - 1];
        const previousText =
          previous?.type === 'assistant' && previous.blocks.length === 1 && previous.blocks[0]?.kind === 'text'
            ? previous.blocks[0].text.trim()
            : '';
        // Context compaction asks a model to write an INTERNAL handoff, then
        // records that handoff as an ordinary final-answer response_item before
        // the `compacted` marker. Showing it repeats the person's questions and
        // the plan in a large English diagnostic block. Exact suffix matching
        // plus the known compaction envelope avoids hiding a real answer that
        // merely happens to mention handoffs.
        if (
          previousText &&
          previousText.startsWith('## Handoff summary') &&
          compactedMessage.startsWith('Another language model started to solve this problem') &&
          compactedMessage.endsWith(previousText)
        ) {
          this.document.messages.pop();
        }
        const ts = parseTimestamp((record as { timestamp?: unknown }).timestamp);
        this.document.messages.push({
          type: 'system',
          uuid: `codex-${lineId(trimmed)}`,
          blocks: [{ kind: 'compact_boundary', trigger: 'auto' }],
          ...(ts === undefined ? {} : { ts }),
        });
        return;
      }

      const message = parseCodexRecord(record, trimmed);
      if (!message) return;
      this.document.messages.push(this.toolChars === undefined ? message : trimToolPayloads([message], this.toolChars)[0]!);
      if (!this.document.title && message.type === 'user') {
        const textBlock = message.blocks.find(
          (block): block is Extract<RenderBlock, { kind: 'text' }> => block.kind === 'text',
        );
        if (textBlock?.text.trim()) this.document.title = textBlock.text.trim();
      }
    } catch {
      /* skip malformed / truncated records */
    } finally {
      // Keep only the requested message window, never the raw rollout. One
      // extra record lets a following compaction marker retract its handoff.
      if (this.limit !== undefined && this.document.messages.length > this.limit + 1) {
        this.document.messages.splice(0, this.document.messages.length - this.limit - 1);
      }
    }
  }

  finish(): ParsedCodexDocument {
    this.document.title ??= this.legacyTitle;
    if (this.limit !== undefined) this.document.messages = this.document.messages.slice(-this.limit);
    return this.document;
  }
}

function parseCodexDocument(text: string): ParsedCodexDocument {
  const parser = new CodexDocumentParser();
  for (const line of text.split(/\r?\n/)) parser.push(line);
  return parser.finish();
}

/** Parse newline-delimited rollout text into render messages. */
export function parseCodexLines(text: string): HistoryMessage[] {
  return parseCodexDocument(text).messages;
}

/**
 * A rollout nobody asked for: a `codex exec` one-shot, or a thread the model
 * spawned for itself. Both write a full rollout beside real sessions, and on
 * this fleet they were a third of every Codex row — unreadable titles, and a
 * transcript the agent then replicates to the hub for nothing.
 *
 * `session_meta.payload` carries three shapes worth refusing:
 *   source: "exec"                                  → `codex exec`
 *   thread_source: "subagent"                       → spawned thread (newer CLI)
 *   source: {subagent:{thread_spawn:{parent…}}}     → spawned thread (all CLIs)
 *
 * cc-remote's own runs go through `codex app-server`, never `exec`, so nothing
 * the product starts is caught here.
 */
export function isEphemeralRollout(meta: Record<string, unknown>): boolean {
  const source = meta['source'];
  return (
    source === 'exec' ||
    meta['thread_source'] === 'subagent' ||
    (typeof source === 'object' && source !== null && 'subagent' in source)
  );
}

/** Parse a bounded rollout head into its inventory summary. */
export function parseCodexRolloutHead(
  text: string,
  mtimeMs: number,
  fallbackNow = Date.now(),
  includeEphemeral = false,
): SessionSummary | null {
  const document = parseCodexDocument(text);
  const meta = document.meta;
  if (!meta) return null;
  if (!includeEphemeral && isEphemeralRollout(meta)) return null;

  const sessionId =
    typeof meta['session_id'] === 'string'
      ? meta['session_id']
      : typeof meta['id'] === 'string'
        ? meta['id']
        : undefined;
  if (!sessionId) return null;

  const cwd = typeof meta['cwd'] === 'string' ? meta['cwd'] : undefined;
  const timestamp = typeof meta['timestamp'] === 'string' ? Date.parse(meta['timestamp']) : NaN;
  const createdAt = Number.isFinite(timestamp) ? timestamp : undefined;
  return {
    sessionId,
    title: document.title?.slice(0, 120) ?? projectLabel(cwd) ?? 'Codex session',
    source: 'codex',
    cwd,
    project: projectLabel(cwd),
    lastModified: mtimeMs || createdAt || fallbackNow,
    createdAt,
    ...(meta['model_provider'] === GO_PROVIDER_ID ? { provider: 'opencode' } : {}),
    ...(isProbePrompt(document.title) ? { automated: true } : {}),
  };
}

/**
 * Records that move a rollout's mtime without anything happening in the
 * thread. Codex Desktop (the ChatGPT app) appends `thread_settings_applied`
 * to a thread every time the app is opened, so a thread idle for days jumped
 * to the top of the list as «just now» (08.10.2026, buildbox-pc).
 */
function isIdleRecord(record: unknown): boolean {
  const r = record as { type?: unknown; payload?: { type?: unknown } } | null;
  return r?.type === 'event_msg' && r.payload?.type === 'thread_settings_applied';
}

/**
 * When the thread last really moved, judged from a bounded rollout tail.
 * Returns `mtimeMs` untouched when the last record is real activity — or is
 * still being written — so every ordinary session keeps the exact number the
 * replica and the turn-end publish already compare. Only a tail of idle
 * records swaps it for the timestamp of the last record before them.
 * `undefined` means the tail held nothing but idle records: read further.
 */
export function codexActivityFromTail(tail: string, mtimeMs: number): number | undefined {
  const lines = tail.split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: unknown;
    try {
      record = JSON.parse(lines[i]!);
    } catch {
      return mtimeMs; // a record mid-write: something is happening now
    }
    if (isIdleRecord(record)) continue;
    if (i === lines.length - 1) return mtimeMs;
    const ts = parseTimestamp((record as { timestamp?: unknown }).timestamp);
    return ts === undefined ? mtimeMs : Math.min(ts, mtimeMs);
  }
  return undefined;
}

/** A settings record is ~3 KB: the small read decides an ordinary session,
 *  the big one covers a few dozen app opens since the last turn. */
const ACTIVITY_TAIL_STEPS = [8 * 1024, 256 * 1024];

/** `lastModified` for a rollout — see `codexActivityFromTail`. */
async function codexActivityMs(filePath: string, mtimeMs: number, size: number): Promise<number> {
  for (const bytes of ACTIVITY_TAIL_STEPS) {
    const found = codexActivityFromTail(await readFileTail(filePath, bytes), mtimeMs);
    if (found !== undefined) return found;
    if (bytes >= size) break;
  }
  return mtimeMs;
}

/** Like `parseCodexRollout` for the metadata only, but a failed open/read is an
 *  ERROR: "could not read" must never look like "no such session" to a caller
 *  that then replaces a replica with nothing. null = read fine, not a session. */
async function parseCodexRolloutStrict(file: RolloutFile): Promise<SessionSummary | null> {
  return parseCodexRolloutHead(await readFileHead(file.filePath, CODEX_HEAD_BYTES), file.mtimeMs, undefined, true);
}

async function parseCodexRollout(
  file: RolloutFile,
  includeEphemeral = false,
): Promise<SessionSummary | null> {
  try {
    const summary = parseCodexRolloutHead(
      await readFileHead(file.filePath, CODEX_HEAD_BYTES),
      file.mtimeMs,
      undefined,
      includeEphemeral,
    );
    if (!summary) return null;
    const activity = await codexActivityMs(file.filePath, file.mtimeMs, file.size).catch(() => file.mtimeMs);
    return activity === file.mtimeMs ? summary : { ...summary, lastModified: activity };
  } catch {
    return null;
  }
}

/**
 * THE rollout resolver: every lookup by session id (history, image, mirror,
 * size, mtime, replica sync, delete, resume) goes through here.
 *
 * Unconfined: the newest file with that id, exactly as before. Confined: the
 * same id may sit in several homes. A unit-home copy only counts when its own
 * recorded cwd belongs to that unit and, when the caller knows the session's
 * canonical `knownCwd`, to THAT cwd's unit. Of what remains one home must win
 * (`pickHome`). Zero candidates = null (no transcript). Several homes that
 * cannot be told apart throw `ConfineError`: callers must treat that as a
 * failure (skip the sync, refuse the read), never as an empty transcript that a
 * replica would then be overwritten with.
 */
async function resolveRollout(sessionId: string, knownCwd?: string): Promise<{ file: RolloutFile; hits: RolloutFile[] } | null> {
  const hits = (await listRollouts()).filter((file) => codexUuidFromFilename(file.filePath) === sessionId);
  if (confinePrefix() === undefined) return hits[0] ? { file: hits[0], hits } : null;
  const wantKey = knownCwd ? cwdUnitKey(knownCwd) : undefined;
  // A canonical cwd that is no confined unit (a pre-confinement session) can
  // only be answered by the legacy ~/.codex copy, never by a unit home.
  const legacyOnly = knownCwd !== undefined && wantKey === undefined;
  const valid: RolloutFile[] = [];
  for (const file of hits) {
    const key = unitHomeKeyOf(file.filePath);
    if (key === undefined) { valid.push(file); continue; }
    if (legacyOnly || (wantKey !== undefined && key !== wantKey)) continue;
    let summary: SessionSummary | null;
    try {
      summary = await parseCodexRolloutStrict(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // vanished since the listing
      throw error;
    }
    if (summary && cwdBelongsToUnitHome(summary.cwd, key)) valid.push(file);
  }
  if (valid.length === 0) return null;
  const home = pickHome(valid.map((f) => unitHomeKeyOf(f.filePath) ?? ''));
  if (home === null) throw new ConfineError(`session ${sessionId} exists in several homes and cannot be attributed`);
  const mine = valid.filter((f) => (unitHomeKeyOf(f.filePath) ?? '') === home);
  return { file: mine[0]!, hits: mine };
}

/** Locate the newest Codex rollout by its exact session uuid (see `resolveRollout`). */
export async function findCodexTranscript(sessionId: string, knownCwd?: string): Promise<string | null> {
  return (await resolveRollout(sessionId, knownCwd))?.file.filePath ?? null;
}

/** Rollouts over this are not read at all — matches the resume cap. */
export const CODEX_TRANSCRIPT_MAX_BYTES = 1024 * 1024 * 1024;
// A rollout line over MAX_LINE_BYTES is always a tool output, which the parser
// caps at 8000 characters anyway — the one thing lost is that result's first
// screen.
export { MAX_LINE_BYTES };

interface IncrementalRollout {
  filePath: string;
  cursor: JsonlCursor;
  parser: CodexDocumentParser;
  /** Rough parsed size (JSON length of the messages pushed), for the budget.
   *  Each kept parse costs roughly its PARSED size — a 158 MB rollout parsed to
   *  3.6 MB (26.09.2026), tool output is capped. Text and tool inputs are not
   *  capped by the parser, so a parse is not always tiny next to its file. */
  approxBytes: number;
}

const incremental = new Map<string, IncrementalRollout>();
const incrementalLocks = new Map<string, Promise<unknown>>();

/** Forget every kept parse — for tests. */
export function resetCodexParseCache(): void {
  incremental.clear();
}

/** Push every new complete line of the rollout into the entry's parser. */
async function advanceRollout(
  entry: IncrementalRollout,
  handle: import('node:fs/promises').FileHandle,
  size: number,
): Promise<void> {
  const messages = entry.parser.document.messages;
  const countBefore = messages.length;
  await advanceJsonl(entry.cursor, handle, size, (line) => entry.parser.push(line));
  // A compaction can retract a message already counted; the estimate only
  // ever grows, which errs on the side of evicting sooner.
  for (let i = Math.min(countBefore, messages.length); i < messages.length; i++) {
    entry.approxBytes += JSON.stringify(messages[i]).length;
  }
}

/**
 * The whole parsed transcript of one Codex session, plus the rollout's size.
 *
 * A big rollout is parsed ONCE and then only its new bytes are read. That is
 * the difference between a 158 MB rollout costing 5-9 s of CPU on every read
 * and costing milliseconds: before, the history RPC missed the hub's 6 s
 * deadline on every open and the replica was switched off entirely for the
 * file (the old 25 MB replica cap), so phones were served an 18-hour-old copy
 * (26.09.2026). The result is exactly what a one-shot parse of the same bytes
 * returns — the replica's append check hashes these messages.
 *
 * Callers get a fresh array and must not mutate the messages in it.
 */
export async function readCodexTranscript(
  sessionId: string,
  knownCwd?: string,
): Promise<{ messages: HistoryMessage[]; size: number } | null> {
  return serializedBy(incrementalLocks, sessionId, () => readCodexTranscriptLocked(sessionId, knownCwd));
}

async function readCodexTranscriptLocked(
  sessionId: string,
  knownCwd?: string,
): Promise<{ messages: HistoryMessage[]; size: number } | null> {
  const filePath = await findCodexTranscript(sessionId, knownCwd);
  // No rollout is a real answer: the session has no transcript yet.
  if (!filePath) {
    incremental.delete(sessionId);
    return null;
  }
  // A rollout that exists but cannot be READ is NOT an empty one. Swallowing
  // EACCES/EIO here returned `[]`, and the replica path reads that as "the
  // session lost its messages": `canAppend` fails, the mode becomes `replace`,
  // and a transient read error overwrites the hub's stored transcript with
  // nothing. Let it throw — syncSession's catch skips the sync (client.ts),
  // and the history RPC answers with an error instead of a lie.
  const handle = await openRollout(filePath);
  try {
    const st = await handle.stat();
    if (st.size > CODEX_TRANSCRIPT_MAX_BYTES) {
      incremental.delete(sessionId);
      throw new Error(
        `Codex transcript is ${Math.round(st.size / 1e6)} MB, over the ${Math.round(CODEX_TRANSCRIPT_MAX_BYTES / 1e6)} MB read limit`,
      );
    }
    let entry = incremental.get(sessionId);
    if (entry && (entry.filePath !== filePath || !(await cursorStillExtends(entry.cursor, handle, st)))) {
      incremental.delete(sessionId);
      entry = undefined;
    }
    const keep = entry !== undefined || st.size >= INCREMENTAL_MIN_BYTES;
    entry ??= {
      filePath,
      cursor: newCursor(st),
      parser: new CodexDocumentParser(),
      approxBytes: 0,
    };
    try {
      await advanceRollout(entry, handle, st.size);
    } catch (err) {
      // A parse cut short has an unknown offset; start over next time.
      incremental.delete(sessionId);
      throw err;
    }
    incremental.delete(sessionId);
    if (keep) keepBounded(incremental, sessionId, entry);
    return { messages: entry.parser.document.messages.slice(), size: st.size };
  } finally {
    await handle.close();
  }
}

/** Read a Codex transcript using the same parser as the live mirror. */
export async function loadCodexHistory(sessionId: string, limit?: number, toolChars?: number, knownCwd?: string): Promise<HistoryMessage[]> {
  const read = await readCodexTranscript(sessionId, knownCwd);
  if (!read) return [];
  const window = limit === undefined ? read.messages : read.messages.slice(-limit);
  return toolChars === undefined ? window : trimToolPayloads(window, toolChars);
}

/** Resolve one Codex `input_image` by the stable message-id/content-index ref
 * emitted by `parseCodexRecord`. Only inline data URLs are accepted: local
 * paths and remote URLs must never turn the agent into a filesystem or network
 * proxy for a browser. */
export async function loadCodexImage(
  sessionId: string,
  ref: string,
  knownCwd?: string,
): Promise<{ mediaType: string; dataB64: string } | null> {
  if (ref.startsWith('gen:')) return loadCodexGeneratedImage(sessionId, ref.slice(4), knownCwd);
  const hash = ref.lastIndexOf('#');
  if (hash <= 0) return null;
  const messageId = ref.slice(0, hash);
  const index = Number(ref.slice(hash + 1));
  if (!/^msg_[A-Za-z0-9-]+$/.test(messageId) || !Number.isInteger(index) || index < 0) return null;

  const filePath = await findCodexTranscript(sessionId, knownCwd);
  if (!filePath) return null;
  // Scan as a stream rather than the bounded history tail. A ref may stay on
  // screen from cache while tool output has already pushed its multi-megabyte
  // base64 line out of the newest 4 MiB; loading it must not depend on how much
  // the agent printed afterwards.
  const imageHandle = await openRollout(filePath);
  const stream = imageHandle.createReadStream({ encoding: 'utf8' });
  const lines = createInterface({ input: stream });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(messageId) || !trimmed.includes('input_image')) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const rollout = record as { type?: unknown; payload?: Record<string, unknown> } | null;
      if (rollout?.type !== 'response_item' || rollout.payload?.['type'] !== 'message') continue;
      if (rollout.payload['id'] !== messageId) continue;
      const content = rollout.payload['content'];
      if (!Array.isArray(content)) return null;
      const block = content[index] as Record<string, unknown> | undefined;
      if (!block || block['type'] !== 'input_image') return null;
      const url = typeof block['image_url'] === 'string' ? block['image_url'] : '';
      const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
      return match ? { mediaType: match[1]!, dataB64: match[2]! } : null;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

const generatedFileIdWarned = new Set<string>();

/** Same budget as the Claude loader's 15 MB file, in base64 characters. */
const GENERATED_IMAGE_MAX_B64 = 20 * 1024 * 1024;

/** `gen:<ig_…>`: stream the rollout (lines run past 1 MB) to the
 *  `image_generation_call` with that payload id and hand back its inline base64.
 *  Compaction scratch records are skipped, same as the history parser. */
async function loadCodexGeneratedImage(
  sessionId: string,
  id: string,
  knownCwd?: string,
): Promise<{ mediaType: string; dataB64: string } | null> {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return null;
  const filePath = await findCodexTranscript(sessionId, knownCwd);
  if (!filePath) return null;
  const handle = await openRollout(filePath);
  const stream = handle.createReadStream({ encoding: 'utf8' });
  const lines = createInterface({ input: stream });
  try {
    for await (const line of lines) {
      // Cheap prefilter before parsing a multi-megabyte line.
      if (!line.includes(id) || !line.includes('image_generation_call')) continue;
      let record: unknown;
      try {
        record = JSON.parse(line.trim());
      } catch {
        continue;
      }
      const rollout = record as {
        type?: unknown;
        payload?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      } | null;
      const payload = rollout?.payload;
      if (rollout?.type !== 'response_item' || payload?.['type'] !== 'image_generation_call') continue;
      if (payload['id'] !== id || rollout.metadata?.['compaction_output'] === true) continue;
      const result = payload['result'];
      if (typeof result === 'string' && result) {
        const b64 = result.replace(/\s+/g, '');
        // The answer must clear the hub's 32 MiB frame before the hub shrinks it.
        if (b64.length > GENERATED_IMAGE_MAX_B64) return null;
        return /^[A-Za-z0-9+/]+={0,2}$/.test(b64) ? { mediaType: sniffImageType(b64), dataB64: b64 } : null;
      }
      if (typeof payload['fileId'] === 'string' && payload['fileId'] && !generatedFileIdWarned.has(id)) {
        generatedFileIdWarned.add(id);
        console.warn(`[codex] generated image ${id} is stored by fileId only; not resolvable from the rollout`);
      }
      return null;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

/** Media type from the first bytes of base64 image data (PNG unless it is
 *  plainly JPEG or WebP). */
function sniffImageType(b64: string): string {
  const head = Buffer.from(b64.slice(0, 24), 'base64');
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * Delete a Codex session the way `session.delete` deletes a Claude one.
 *
 * Moved to `~/.cc-remote/trash`, never unlinked: the web asks "Delete this
 * session transcript?" and a person who mis-clicks that on a week of work
 * deserves a way back. Same trash the project remover uses.
 *
 * EVERY rollout carrying this uuid goes, not just the newest — Codex can leave
 * more than one file per thread (that is why `scanCodexSessions` deduplicates
 * by id), and leaving the older ones behind would resurrect the session on the
 * next inventory scan.
 */
export async function deleteCodexSession(
  sessionId: string,
  trashDir = path.join(stateDir(), 'trash'),
  knownCwd?: string,
  liveCwds: readonly string[] = [],
): Promise<{ removed: number }> {
  // Same resolver as every read: confined, only the chosen home's copies go.
  const resolved = await resolveRollout(sessionId, knownCwd);
  const targets = resolved?.hits ?? [];
  if (targets.length === 0) throw new Error(`no Codex rollout found for session ${sessionId}`);
  // Confined: the checks below verify a path and the rename then re-resolves it,
  // which a writer in the SAME unit home could race (swap a date dir for a
  // symlink). So deletion is allowed only while that unit has no live run: every
  // run is a bwrap with --unshare-pid, and the unit's last process dies with it
  // (see the confinement doc), so once no run is registered no writer exists.
  const unitKey = confinePrefix() !== undefined ? unitHomeKeyOf(resolved!.file.filePath) : undefined;
  if (unitKey !== undefined && liveCwds.some((cwd) => cwdUnitKey(cwd) === unitKey)) {
    throw new Error('сессии этого дела сейчас работают — завершите их и повторите удаление');
  }

  await mkdir(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [index, file] of targets.entries()) {
    await assertRolloutPath(file.filePath); // confined: refuse a swapped-in symlink
    const suffix = index === 0 ? '' : `-${index}`;
    const to = path.join(trashDir, `${path.basename(file.filePath, '.jsonl')}-${stamp}${suffix}.jsonl`);
    try {
      await rename(file.filePath, to);
    } catch (err) {
      // CODEX_HOME on a different filesystem than the home dir (a container
      // mount, a separate volume) makes rename fail with EXDEV; copy instead so
      // the delete still lands and the copy is still recoverable.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await copyFile(file.filePath, to);
      await unlink(file.filePath);
    }
  }
  return { removed: targets.length };
}

/** Byte size of the newest exact-id rollout, or -1 when absent. */
export async function codexRolloutSize(sessionId: string, knownCwd?: string): Promise<number> {
  return (await resolveRollout(sessionId, knownCwd))?.file.size ?? -1;
}

/** Where each session's rollout was last found — a turn end stats that one
 *  file instead of walking the whole corpus again. */
const rolloutPaths = new Map<string, string>();

/** `lastModified` of the newest exact-id rollout — the number
 *  `scanCodexSessions` reports (mtime, unless the tail is idle records) —
 *  or undefined when absent. Stats only, and after
 *  the first call for a session just the one file it was found in. A newer
 *  rollout for the same id appearing later reads as «not moved», which only
 *  costs the fast-lane rebuild `publishTurnEnd` schedules anyway. */
export async function codexRolloutMtime(sessionId: string, knownCwd?: string): Promise<number | undefined> {
  // Confined: the cache is per (id, canonical cwd) - a hit found for unit A must
  // not answer a lookup for unit B's double. Unconfined: per id, as before.
  const cacheKey = confinePrefix() === undefined ? sessionId : `${sessionId}\0${knownCwd ?? ''}`;
  const known = rolloutPaths.get(cacheKey);
  if (known) {
    try {
      const info = await stat(known);
      return await codexActivityMs(known, info.mtimeMs, info.size);
    } catch {
      rolloutPaths.delete(cacheKey); // moved or removed: look again
    }
  }
  // Same choice as every other lookup: a lookalike's (future) mtime must not
  // become this session's cursor.
  const resolved = await resolveRollout(sessionId, knownCwd);
  let newest: RolloutFile | undefined = resolved?.file;
  if (confinePrefix() === undefined) {
    newest = undefined;
    for (const file of resolved?.hits ?? []) {
      if (!newest || file.mtimeMs > newest.mtimeMs) newest = file;
    }
  }
  if (!newest) return undefined;
  const found = newest;
  rolloutPaths.set(cacheKey, found.filePath);
  return codexActivityMs(found.filePath, found.mtimeMs, found.size).catch(() => found.mtimeMs);
}

/** Discover this machine's Codex sessions, newest first and deduplicated by id. */
export async function scanCodexSessions(
  limit?: number,
  includeEphemeral = false,
): Promise<SessionSummary[]> {
  const files = await listRollouts();
  const parsed: Array<{ summary: SessionSummary; mtimeMs: number; homeKey: string }> = [];
  for (let i = 0; i < files.length; i += DISCOVERY_POOL_SIZE) {
    const batch = files.slice(i, i + DISCOVERY_POOL_SIZE);
    const summaries = await Promise.all(batch.map((f) => parseCodexRollout(f, includeEphemeral)));
    summaries.forEach((summary, index) => {
      if (!summary) return;
      // A rollout written inside a unit home must name a cwd of that unit.
      const key = confinePrefix() !== undefined ? unitHomeKeyOf(batch[index]!.filePath) : undefined;
      if (key !== undefined && !cwdBelongsToUnitHome(summary.cwd, key)) return;
      parsed.push({ summary, mtimeMs: batch[index]!.mtimeMs, ...(key !== undefined ? { homeKey: key } : { homeKey: '' }) });
    });
  }

  // The same session id in several homes: keep the one home pickHome trusts
  // (a legacy ~/.codex copy, else a single unit home); drop only the others.
  if (confinePrefix() !== undefined) {
    const homesById = new Map<string, Set<string>>();
    for (const item of parsed) {
      const set = homesById.get(item.summary.sessionId) ?? new Set<string>();
      set.add(item.homeKey);
      homesById.set(item.summary.sessionId, set);
    }
    for (let i = parsed.length - 1; i >= 0; i--) {
      const item = parsed[i]!;
      const homes = homesById.get(item.summary.sessionId)!;
      if (homes.size > 1 && pickHome(homes) !== item.homeKey) parsed.splice(i, 1);
    }
  }

  const newestById = new Map<string, { summary: SessionSummary; mtimeMs: number; homeKey: string }>();
  for (const item of parsed) {
    const previous = newestById.get(item.summary.sessionId);
    if (!previous || item.mtimeMs > previous.mtimeMs) {
      newestById.set(item.summary.sessionId, item);
    }
  }

  const sessions = [...newestById.values()]
    .map(({ summary }) => summary)
    .sort((a, b) => b.lastModified - a.lastModified);
  return typeof limit === 'number' ? sessions.slice(0, limit) : sessions;
}
