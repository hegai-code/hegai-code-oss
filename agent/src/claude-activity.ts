import { type FileHandle, open } from 'node:fs/promises';
import { parseRecord, taskNoticesOf } from './history.js';

/**
 * When a Claude session last really moved — the `lastModified` the inventory
 * sorts by.
 *
 * The transcript's mtime is not that. The CLI appends bookkeeping after the
 * conversation: `last-prompt`, `ai-title`, `atis-latch`, `mode`, and on every
 * process exit a `cost-state`. An agent self-update on 11.10.2026 ended 25 idle
 * live runs at once; each process wrote its `cost-state` on the way out, and
 * every one of those sessions jumped above work that had really finished
 * later — in the drawer, the project order and the project picker alike.
 *
 * So the activity of a session is the newest record the transcript RENDERS —
 * exactly what `history.ts`'s `parseRecord` turns into a message (a user or
 * assistant turn, a queued prompt, a compaction), plus a background task
 * notification (`taskNoticesOf`), which changes a rendered result. The CLI's own
 * injections (`isMeta` user records, empty assistants) and everything after
 * the last rendered record are ignored.
 *
 * This is the SORT key only. The replica's sync cursor is the raw file mtime,
 * sent as `fileMtime` when it differs (`replicaCursor` in client.ts,
 * `replica_is_current` in the hub), so skipping records here never hides a
 * write from the replica.
 */
function isActivity(record: unknown): boolean {
  return parseRecord(record) !== null || taskNoticesOf(record).length > 0;
}

/** See `ActivityWalk`: past this much `progress` the session is live. */
const PROGRESS_MAX_BYTES = 1024 * 1024;

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Lines fed newest first; `feed` returns a number once decided, `undefined`
 * to keep walking, and `finish` closes the walk at the end of the input.
 *
 * - The newest line being real activity, or a record still being written
 *   (it does not parse), keeps `mtimeMs` exactly — every ordinary session
 *   keeps the number it had. An OLDER line that does not parse is just a
 *   damaged record and is skipped, as `history.ts` skips it.
 * - Otherwise the last real record's timestamp, never later than the mtime.
 *   A queued prompt (an attachment) carries the moment it was SENT, which can
 *   be earlier than the replies written before it, so attachments are walked
 *   through to the record before them and the latest timestamp wins.
 * - A real record without a usable timestamp: the mtime.
 * - More than `PROGRESS_MAX_BYTES` of `progress` records: the mtime. Those
 *   are what a run streams while a sub-agent or a long tool works; a megabyte
 *   of them is a run going on right now, and walking past it on every
 *   inventory pass would re-parse megabytes per live session every few
 *   seconds. Exit bookkeeping (`cost-state`, a long `last-prompt`) never
 *   counts toward it, and progress followed by a `cost-state` is a run that
 *   has ended — walked through like any bookkeeping.
 */
class ActivityWalk {
  private best: number | undefined;
  private newest = true;
  private progress = 0;
  /** A `cost-state` after it: the process that streamed it has exited. */
  private exited = false;
  constructor(private readonly mtimeMs: number) {}

  feed(line: string): number | undefined {
    const newest = this.newest;
    this.newest = false;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return newest ? this.mtimeMs : undefined;
    }
    if (!isActivity(record)) {
      const type = (record as { type?: unknown } | null)?.type;
      if (type === 'cost-state') this.exited = true;
      if (type !== 'progress' || this.exited) return undefined;
      this.progress += line.length;
      return this.progress > PROGRESS_MAX_BYTES ? this.mtimeMs : undefined;
    }
    if (newest) return this.mtimeMs;
    const ts = parseTimestamp((record as { timestamp?: unknown }).timestamp);
    if (ts === undefined) return this.mtimeMs;
    this.best = Math.max(this.best ?? ts, ts);
    if ((record as { type?: unknown }).type === 'attachment') return undefined;
    return Math.min(this.best, this.mtimeMs);
  }

  /** `undefined`: nothing real in the input. */
  finish(): number | undefined {
    return this.best === undefined ? undefined : Math.min(this.best, this.mtimeMs);
  }
}

/** The walk over a whole tail string. `undefined`: nothing real in it. */
export function claudeActivityFromTail(tail: string, mtimeMs: number): number | undefined {
  const lines = tail.split(/\r?\n/).filter((line) => line.trim());
  const walk = new ActivityWalk(mtimeMs);
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = walk.feed(lines[i]!);
    if (found !== undefined) return found;
  }
  return walk.finish();
}

const CHUNK = 64 * 1024;
/** How far back to look. Bookkeeping is a few KB; this bound exists for the
 *  last real record, which can be a pasted screenshot several MB long. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * Complete lines of a file, newest first, read backwards in chunks. A line
 * longer than a chunk is assembled from its pieces once, not re-copied per
 * chunk. Stops at `maxBytes` (the line straddling that point is dropped).
 */
async function* linesFromEnd(handle: FileHandle, size: number, maxBytes: number): AsyncGenerator<string> {
  let pos = size;
  let pieces: Buffer[] = []; // the current (newest unfinished) line, front first
  while (pos > 0 && size - pos < maxBytes) {
    const len = Math.min(CHUNK, pos);
    pos -= len;
    const chunk = Buffer.alloc(len);
    const { bytesRead } = await handle.read(chunk, 0, len, pos);
    // A short read leaves zeros that would parse as transcript: no verdict.
    if (bytesRead !== len) throw new Error('short read');
    let end = len;
    for (let i = len - 1; i >= 0; i--) {
      if (chunk[i] !== 0x0a) continue;
      const line = Buffer.concat([chunk.subarray(i + 1, end), ...pieces]);
      pieces = [];
      end = i;
      if (line.length) yield line.toString('utf8');
    }
    if (end > 0) pieces.unshift(chunk.subarray(0, end));
  }
  if (pos === 0 && pieces.length) yield Buffer.concat(pieces).toString('utf8');
}

/** file → the mtime it was judged at and the verdict. An unchanged file is
 *  never re-read, so a steady inventory walk costs no tail reads at all. */
const cache = new Map<string, { mtimeMs: number; activity: number }>();

/**
 * `lastModified` for the Claude transcript at `filePath`, whose mtime the SDK
 * reported as `mtimeMs`. `undefined` when the file is gone or its mtime is not
 * that one (a different copy of the session, or written since): the caller
 * decides what that means. Nothing real within the scan bound: the mtime.
 */
export async function claudeActivityMs(filePath: string, mtimeMs: number): Promise<number | undefined> {
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.activity;
  let activity = mtimeMs;
  try {
    // One handle, read up to the size it had when its mtime was checked: an
    // append landing mid-scan is not judged under the older mtime.
    const handle = await open(filePath, 'r');
    try {
      const actual = await handle.stat();
      // The SDK reports integer milliseconds.
      if (Math.abs(actual.mtimeMs - mtimeMs) > 1) return undefined;
      const walk = new ActivityWalk(mtimeMs);
      let found: number | undefined;
      for await (const line of linesFromEnd(handle, actual.size, MAX_SCAN_BYTES)) {
        if (!line.trim()) continue;
        found = walk.feed(line);
        if (found !== undefined) break;
      }
      activity = found ?? walk.finish() ?? mtimeMs;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined; // vanished or unreadable: do not cache a guess
  }
  cache.set(filePath, { mtimeMs, activity });
  return activity;
}
