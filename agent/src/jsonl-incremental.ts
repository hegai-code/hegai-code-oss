import type { open } from 'node:fs/promises';

/**
 * Byte-level machinery shared by the incremental transcript readers (Codex
 * rollouts in codex.ts, Claude transcripts in history.ts): read a growing
 * JSONL file ONCE and afterwards only its new bytes, noticing when it was
 * rewritten instead. What each reader does with a line, and what it keeps, is
 * its own business.
 */

type FileHandle = Awaited<ReturnType<typeof open>>;

/**
 * Transcripts at least this large keep their parse between reads. Below it a
 * fresh parse costs milliseconds, and keeping every small session would only
 * churn the cache: one replica pass walks hundreds of them, and each would push
 * a big one out.
 */
export const INCREMENTAL_MIN_BYTES = 4 * 1024 * 1024;
/** How many big transcripts keep a parse (per reader). */
export const INCREMENTAL_MAX_ENTRIES = 8;
/** Total parsed size the kept parses may hold before the oldest goes, and the
 *  most one may hold to be kept at all. */
export const INCREMENTAL_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const INCREMENTAL_MAX_ENTRY_BYTES = 96 * 1024 * 1024;
/** Bytes right before the consumed offset, compared on the next read so a
 *  transcript rewritten in place is noticed rather than appended to blindly. */
const INCREMENTAL_GUARD_BYTES = 256;
const READ_CHUNK_BYTES = 1024 * 1024;
/**
 * One line longer than this is dropped unread, like a torn record. Assembling
 * it costs several times its size at once (the pieces, their concatenation,
 * the string, the parsed object), and a single tool dump of hundreds of
 * megabytes is exactly what used to OOM the agent in a loop.
 */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Where a reader stands in one file, and how to tell it is still that file. */
export interface JsonlCursor {
  dev: number;
  ino: number;
  /** Bytes consumed. Always sits just past a newline (or at a complete record). */
  offset: number;
  guard: Buffer;
}

export function newCursor(st: { dev: number; ino: number }): JsonlCursor {
  return { dev: st.dev, ino: st.ino, offset: 0, guard: Buffer.alloc(0) };
}

/**
 * Hand every complete line of `[cursor.offset, size)` to `push` and move the
 * cursor past them. A trailing line without its newline is left for the next
 * read — it is usually a record still being written — unless it already parses
 * as a whole JSON value: a proper prefix of a serialized object never does, so
 * that record is complete and only its newline is missing. Consuming it keeps
 * the result identical to a one-shot parse of the same bytes.
 */
export async function advanceJsonl(
  cursor: JsonlCursor,
  handle: FileHandle,
  size: number,
  push: (line: string) => void,
): Promise<void> {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let pos = cursor.offset;
  let consumed = cursor.offset;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  /** The current line outgrew MAX_LINE_BYTES: skip to its newline. */
  let skipping = false;
  while (pos < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - pos), pos);
    if (!bytesRead) break;
    const view = chunk.subarray(0, bytesRead);
    let start = 0;
    for (let nl = view.indexOf(0x0a, start); nl !== -1; nl = view.indexOf(0x0a, start)) {
      const piece = view.subarray(start, nl);
      if (!skipping && pendingBytes + piece.length <= MAX_LINE_BYTES) {
        const line = (pending.length ? Buffer.concat([...pending, piece]) : piece).toString('utf8');
        push(line);
      }
      pending = [];
      pendingBytes = 0;
      skipping = false;
      start = nl + 1;
      consumed = pos + start;
    }
    if (start < bytesRead && !skipping) {
      pendingBytes += bytesRead - start;
      if (pendingBytes > MAX_LINE_BYTES) {
        pending = [];
        skipping = true;
      } else {
        pending.push(Buffer.from(view.subarray(start)));
      }
    }
    pos += bytesRead;
  }
  if (pending.length && !skipping && pos >= size) {
    const tail = Buffer.concat(pending).toString('utf8');
    let complete = false;
    try {
      JSON.parse(tail);
      complete = true;
    } catch {
      /* still being written, or torn — the next read sees it again */
    }
    if (complete) {
      push(tail);
      consumed = size;
    }
  }
  cursor.offset = consumed;
  const guardLen = Math.min(INCREMENTAL_GUARD_BYTES, consumed);
  const guard = Buffer.alloc(guardLen);
  if (guardLen) await handle.read(guard, 0, guardLen, consumed - guardLen);
  cursor.guard = guard;
}

/** True when the bytes before `cursor.offset` are still the ones it consumed. */
export async function cursorStillExtends(
  cursor: JsonlCursor,
  handle: FileHandle,
  st: { dev: number; ino: number; size: number },
): Promise<boolean> {
  if (st.dev !== cursor.dev || st.ino !== cursor.ino || st.size < cursor.offset) return false;
  const len = cursor.guard.length;
  if (!len) return true;
  const now = Buffer.alloc(len);
  const { bytesRead } = await handle.read(now, 0, len, cursor.offset - len);
  return bytesRead === len && now.equals(cursor.guard);
}

/** Run `fn` after every earlier call with the same key has settled. */
export async function serializedBy<T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

/**
 * Store `entry` as the most recently used parse and evict from the oldest end
 * until the entry count and the total parsed size are within budget. An entry
 * over the per-entry budget is not kept at all.
 */
export function keepBounded<E extends { approxBytes: number }>(cache: Map<string, E>, key: string, entry: E): void {
  cache.delete(key);
  if (entry.approxBytes > INCREMENTAL_MAX_ENTRY_BYTES) return;
  // Most recently used last; the oldest goes first.
  cache.set(key, entry);
  let total = 0;
  for (const kept of cache.values()) total += kept.approxBytes;
  while (cache.size > INCREMENTAL_MAX_ENTRIES || total > INCREMENTAL_MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next().value!;
    total -= cache.get(oldest)!.approxBytes;
    cache.delete(oldest);
  }
}
