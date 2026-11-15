import os from 'node:os';
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { openRollout } from './confine.js';
import chokidar, { type FSWatcher } from 'chokidar';
import type { HistoryMessage } from '@cc-remote/shared';
import { loadHistory, parseRecord, parseTimestamp, trimToolPayloads } from './history.js';
import { ImageGenLedger } from './image-gen.js';
import { findCodexTranscript, parseCodexLines } from './codex.js';

/** A line-block parser for a transcript format (Claude `.jsonl` or Codex rollout). */
type LineParser = (text: string) => HistoryMessage[];

/**
 * Read-only "mirror" of a LIVE session's transcript. Tails the append-only
 * `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` and streams new records as
 * they are written by the editor's own claude — WITHOUT spawning a second
 * writer. Single-writer-safe way to watch a session open in VSCode remotely.
 */

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEBOUNCE_MS = 120;
/** Messages per frame — large transcripts must not go as one giant WS frame
 *  (multi-MB frames choke the multi-hop SSH tunnels to remote agents). */
const CHUNK = 200;
/** Cap the mirror's INITIAL read to the last N bytes of the transcript. A
 *  pathological session (a giant tool output dumped into the `.jsonl` — we've
 *  seen 100+ MB) would otherwise be read + parsed + shipped whole on open,
 *  hanging the agent and the mobile view. The live tail keeps flowing past
 *  `offset` afterwards, so only the deep backlog is dropped — the recent
 *  context (what the operator actually needs to watch) is preserved. */
const INITIAL_TAIL_BYTES = 2_000_000;

interface MirrorEntry {
  /** Absent while the open is settling and for "no transcript" mirrors. */
  watcher?: FSWatcher;
  filePath: string;
  offset: number;
  partial: Buffer;
  /** Format parser for this transcript (Claude `.jsonl` vs Codex rollout). */
  parse: LineParser;
  /** Makes a fresh parser (empty ledger) — called when the offset resets. */
  newParser: () => LineParser;
  timer?: NodeJS.Timeout;
  /** Serializes drains: the debounce gates scheduling, not in-flight reads. */
  draining?: boolean;
  dirty?: boolean;
}

export type MirrorSink = (replace: boolean, messages: HistoryMessage[]) => void;

/** Find the transcript file for a sessionId by scanning project folders. */
async function findTranscript(sessionId: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }
  const name = `${sessionId}.jsonl`;
  for (const d of dirs) {
    const p = path.join(PROJECTS_DIR, d, name);
    try {
      await stat(p);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

async function readFrom(filePath: string, from: number, to: number): Promise<Buffer> {
  if (to <= from) return Buffer.alloc(0);
  const fh = await openRollout(filePath);
  try {
    const buf = Buffer.alloc(to - from);
    await fh.read(buf, 0, buf.length, from);
    return buf;
  } finally {
    await fh.close();
  }
}

/**
 * A Claude line parser with its own image ledger. The ledger is state of the
 * ENTRY, not of a chunk: a Bash call and its result land in different drains,
 * and a fresh ledger per chunk would lose the picture. A new parser (= a new
 * ledger) is made only where the mirror resets its offset: open, file replaced
 * or truncated.
 */
function newClaudeParser(): LineParser {
  const ledger = new ImageGenLedger();
  return (text) => {
    const out: HistoryMessage[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const record: unknown = JSON.parse(t);
        const m = parseRecord(record);
        if (m) out.push(m);
        out.push(...ledger.observe(record, parseTimestamp((record as { timestamp?: unknown }).timestamp)));
      } catch {
        /* skip malformed / partial */
      }
    }
    return out;
  };
}

/**
 * A mirror is a read-only VIEW of a transcript — there is no archival consumer
 * on the other end — so the tool-payload trim the interactive read takes as an
 * option is unconditional here. It is also the path that most needs it: a
 * mirror re-sends its whole tail on every (re)open and appends live, and a
 * single `tool_result` in this fleet has been seen at half a megabyte, which is
 * exactly what CHUNK exists to keep off a tunnel.
 */
const MIRROR_TOOL_CHARS = 1000;

/** Send a message list in tunnel-safe chunks. The first frame may `replace`. */
function chunkSend(sink: MirrorSink, msgs: HistoryMessage[], replaceFirst: boolean): void {
  if (msgs.length === 0) {
    if (replaceFirst) sink(true, []);
    return;
  }
  const trimmed = trimToolPayloads(msgs, MIRROR_TOOL_CHARS);
  for (let i = 0; i < trimmed.length; i += CHUNK) {
    sink(replaceFirst && i === 0, trimmed.slice(i, i + CHUNK));
  }
}

export class MirrorManager {
  private readonly mirrors = new Map<string, MirrorEntry>();

  async open(mirrorId: string, sessionId: string, cwd: string, sink: MirrorSink): Promise<void> {
    if (this.mirrors.has(mirrorId)) return;
    // Reserve the slot before the first await: a duplicate open bounces off the
    // has() check above, and a close() racing this open deletes the reservation
    // — we detect that after each await instead of leaking a live watcher.
    const placeholder: MirrorEntry = { filePath: '', offset: 0, partial: Buffer.alloc(0), parse: newClaudeParser(), newParser: newClaudeParser };
    this.mirrors.set(mirrorId, placeholder);
    const cancelled = () => this.mirrors.get(mirrorId) !== placeholder;

    // Route by transcript format: a Claude session lives under ~/.claude/projects
    // and parses with parseLines; if not found there, try a Codex rollout
    // (~/.codex/sessions/**) with the Codex parser. mirror_open carries only
    // sessionId+cwd, so the agent self-detects the source.
    let filePath = await findTranscript(sessionId);
    let newParser: () => LineParser = newClaudeParser;
    if (cancelled()) return;
    if (!filePath) {
      const codexPath = await findCodexTranscript(sessionId, cwd);
      if (cancelled()) return;
      if (codexPath) {
        filePath = codexPath;
        newParser = () => parseCodexLines;
      }
    }

    // Initial load: read the transcript directly (predictable, same parser as the
    // tail), chunked. Fall back to the SDK only if no file can be located (Claude
    // sessions only — a Codex uuid that isn't on disk just yields an empty mirror).
    if (!filePath) {
      try {
        chunkSend(sink, await loadHistory(sessionId, cwd), true);
      } catch {
        sink(true, []);
      }
      // The placeholder doubles as the inert "no transcript" entry.
      return;
    }

    const parse = newParser();
    let offset = 0;
    let initialPartial = Buffer.alloc(0);
    try {
      const size = (await stat(filePath)).size;
      offset = size;
      // Read only the tail on open (see INITIAL_TAIL_BYTES) — a huge transcript
      // must not be slurped whole. Live appends past `offset` still stream in full.
      const start = Math.max(0, size - INITIAL_TAIL_BYTES);
      const buf = await readFrom(filePath, start, size);
      // If we started mid-file the first line is a fragment of an earlier record;
      // drop it so we only ever parse whole records.
      const firstNl = start > 0 ? buf.indexOf(0x0a) : -1;
      const body = firstNl >= 0 ? buf.subarray(firstNl + 1) : buf;
      // Split at the last newline: the writer may be mid-append, and the
      // already-written prefix of that record must carry into `partial` or the
      // record is lost forever (drain only reads past `offset`). Copy the
      // fragment so we don't pin the whole initial buffer.
      const lastNl = body.lastIndexOf(0x0a);
      initialPartial = Buffer.from(lastNl >= 0 ? body.subarray(lastNl + 1) : body);
      chunkSend(sink, parse(body.subarray(0, lastNl >= 0 ? lastNl : 0).toString('utf8')), true);
    } catch {
      sink(true, []);
      offset = 0;
      initialPartial = Buffer.alloc(0);
    }
    if (cancelled()) return;

    const watcher = chokidar.watch(filePath, { ignoreInitial: true });
    const entry: MirrorEntry = { watcher, filePath, offset, partial: initialPartial, parse, newParser };
    this.mirrors.set(mirrorId, entry);

    const onChange = () => {
      if (entry.timer) return;
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        void this.drain(mirrorId, sink);
      }, DEBOUNCE_MS);
    };
    watcher.on('change', onChange).on('add', onChange);
  }

  private async drain(mirrorId: string, sink: MirrorSink): Promise<void> {
    const entry = this.mirrors.get(mirrorId);
    if (!entry || !entry.filePath) return;
    if (entry.draining) {
      entry.dirty = true; // the in-flight drain loops again when it lands
      return;
    }
    entry.draining = true;
    try {
      do {
        entry.dirty = false;
        await this.drainOnce(entry, sink);
      } while (entry.dirty);
    } catch (err) {
      console.error(`[agent] mirror ${mirrorId} drain error:`, (err as Error).message);
    } finally {
      entry.draining = false;
    }
  }

  private async drainOnce(entry: MirrorEntry, sink: MirrorSink): Promise<void> {
    let size: number;
    try {
      size = (await stat(entry.filePath)).size;
    } catch {
      return;
    }
    // File shrank (rewrite / compaction): reload — but only the tail, capped the
    // same way the open path is (INITIAL_TAIL_BYTES). A compacted transcript can
    // still be 100+ MB; reading it whole here would re-introduce the hang the cap
    // exists to prevent. Drop the leading partial record; carry the trailing one.
    if (size < entry.offset) {
      let messages: HistoryMessage[] = [];
      let partial = Buffer.alloc(0);
      entry.parse = entry.newParser();
      try {
        const start = Math.max(0, size - INITIAL_TAIL_BYTES);
        const buf = await readFrom(entry.filePath, start, size);
        const firstNl = start > 0 ? buf.indexOf(0x0a) : -1;
        const body = firstNl >= 0 ? buf.subarray(firstNl + 1) : buf;
        const lastNl = body.lastIndexOf(0x0a);
        partial = Buffer.from(lastNl >= 0 ? body.subarray(lastNl + 1) : body);
        messages = entry.parse(body.subarray(0, lastNl >= 0 ? lastNl : 0).toString('utf8'));
      } catch {
        messages = [];
        partial = Buffer.alloc(0);
      }
      entry.offset = size;
      entry.partial = partial;
      chunkSend(sink, messages, true);
      return;
    }
    if (size === entry.offset) return;

    const chunk = await readFrom(entry.filePath, entry.offset, size);
    entry.offset = size;
    const combined = Buffer.concat([entry.partial, chunk]);
    // Split on the last newline so a partial trailing record is held over
    // (records are newline-delimited; bytes may split a multibyte char).
    const lastNl = combined.lastIndexOf(0x0a);
    if (lastNl < 0) {
      entry.partial = combined;
      return;
    }
    entry.partial = combined.subarray(lastNl + 1);
    chunkSend(sink, entry.parse(combined.subarray(0, lastNl).toString('utf8')), false);
  }

  close(mirrorId: string): void {
    const entry = this.mirrors.get(mirrorId);
    if (!entry) return;
    this.mirrors.delete(mirrorId);
    if (entry.timer) clearTimeout(entry.timer);
    void entry.watcher?.close();
  }

  closeAll(): void {
    for (const id of [...this.mirrors.keys()]) this.close(id);
  }
}
