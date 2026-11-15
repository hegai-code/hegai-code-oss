import fs from 'node:fs';

/**
 * Feeds typed/pasted input into a pty WITHOUT ever blocking the event loop.
 *
 * Why this exists (24.09.2026, dev-mac-mini-001 offline for half an hour):
 * node-pty's own `write()` goes through a `tty.ReadStream` on the pty master.
 * libuv cannot reopen a master, so it marks that handle BLOCKING_WRITES — and a
 * blocking-writes stream whose fd is actually non-blocking (node-pty sets
 * O_NONBLOCK) spins on EAGAIN inside `uv__write` until the kernel takes every
 * byte. A 3 KB line typed into zsh was enough: the pty input queue filled, zsh
 * echoed until the OUTPUT queue filled and stopped reading, and the agent — the
 * only reader of that output — sat in `write()` at 100% CPU forever. The event
 * loop never turned again, the hub socket died, and the machine read as offline
 * while its process was alive.
 *
 * So input is queued here and written with the async `fs.write` on the master
 * fd: EAGAIN comes back to JS as an error instead of a spin, and between chunks
 * the loop keeps turning — which is what lets the agent drain the pty's output
 * and the shell read its input again.
 */

/** A write of at most this many bytes at a time: small enough to fit the
 *  smallest pty input queue in the fleet (macOS), big enough for a paste to
 *  flow at full speed. */
export const PTY_CHUNK_BYTES = 512;
/** Input nobody reads for this long is dropped — the program in front is not
 *  reading stdin, and replaying a stale paste minutes later is worse. */
export const PTY_STALL_MS = 30_000;
/** Refuse input past this much pending. A terminal is not a file transfer. */
export const PTY_MAX_QUEUE_BYTES = 1024 * 1024;
const BACKOFF_MIN_MS = 5;
const BACKOFF_MAX_MS = 100;

/** One raw write: report how many bytes the other side took (0 is fine). */
export type RawWrite = (buf: Buffer, cb: (err: NodeJS.ErrnoException | null, written: number) => void) => void;

export interface PtyInputOptions {
  write: RawWrite;
  /** Tell the person at the terminal what happened to their input. */
  notice?: (text: string) => void;
  chunkBytes?: number;
  stallMs?: number;
  maxQueueBytes?: number;
  now?: () => number;
}

const RETRYABLE = new Set(['EAGAIN', 'EWOULDBLOCK', 'EINTR']);

/** Async non-blocking write straight to a pty master fd (Unix). */
export function fdWriter(fd: number): RawWrite {
  return (buf, cb) => fs.write(fd, buf, 0, buf.length, null, (err, written) => cb(err, written ?? 0));
}

/** Largest prefix of `buf` of at most `max` bytes that does not cut a UTF-8
 *  sequence in half (a Windows ConPTY write takes a string, and a split code
 *  point would reach the shell as two replacement characters). */
export function chunkEnd(buf: Buffer, max: number): number {
  if (buf.length <= max) return buf.length;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return end > 0 ? end : max;
}

export class PtyInput {
  private readonly queue: Buffer[] = [];
  private queued = 0;
  private inFlight = false;
  private timer: NodeJS.Timeout | undefined;
  private backoff = 0;
  private lastProgress = 0;
  private disposed = false;
  private readonly chunkBytes: number;
  private readonly stallMs: number;
  private readonly maxQueueBytes: number;
  private readonly now: () => number;

  constructor(private readonly opts: PtyInputOptions) {
    this.chunkBytes = opts.chunkBytes ?? PTY_CHUNK_BYTES;
    this.stallMs = opts.stallMs ?? PTY_STALL_MS;
    this.maxQueueBytes = opts.maxQueueBytes ?? PTY_MAX_QUEUE_BYTES;
    this.now = opts.now ?? Date.now;
  }

  /** Bytes accepted but not yet taken by the pty. */
  get pending(): number {
    return this.queued;
  }

  push(data: string): void {
    if (this.disposed || !data) return;
    const buf = Buffer.from(data, 'utf8');
    if (this.queued + buf.length > this.maxQueueBytes) {
      console.warn(`[agent] terminal input refused: ${buf.length} bytes over the ${this.maxQueueBytes}-byte queue`);
      this.opts.notice?.(`\r\n[агент] ввод не принят: в очереди уже ${this.queued} байт, терминал их ещё не прочёл\r\n`);
      return;
    }
    if (this.queued === 0) this.lastProgress = this.now();
    this.queue.push(buf);
    this.queued += buf.length;
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.queued = 0;
  }

  private pump(): void {
    if (this.disposed || this.inFlight || this.timer) return;
    const head = this.queue[0];
    if (!head) return;
    const n = chunkEnd(head, this.chunkBytes);
    this.inFlight = true;
    let sync = true;
    let settled = false;
    this.opts.write(head.subarray(0, n), (err, written) => {
      if (settled) return;
      settled = true;
      this.inFlight = false;
      if (this.disposed) return;
      if (err && !RETRYABLE.has(err.code ?? '')) {
        // EIO/EBADF: the shell is gone. Nothing will ever read this.
        console.warn(`[agent] terminal input dropped (${err.code ?? err.message}), ${this.queued} bytes`);
        this.drop();
        return;
      }
      const took = err ? 0 : Math.max(0, Math.min(written, n));
      if (took > 0) {
        this.consume(took);
        this.lastProgress = this.now();
        this.backoff = 0;
        // A synchronous writer (Windows) must not recurse through a whole
        // paste in one tick — that is the very starvation this class exists
        // to prevent. An async one already yielded.
        if (sync) setImmediate(() => this.pump());
        else this.pump();
        return;
      }
      if (this.now() - this.lastProgress >= this.stallMs) {
        console.warn(`[agent] terminal input dropped: pty took nothing for ${this.stallMs}ms, ${this.queued} bytes`);
        this.opts.notice?.(
          `\r\n[агент] ввод отброшен (${this.queued} байт): программа в терминале не читает его ${Math.round(this.stallMs / 1000)} с\r\n`,
        );
        this.drop();
        return;
      }
      this.backoff = this.backoff ? Math.min(this.backoff * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, this.backoff);
    });
    sync = false;
  }

  private consume(bytes: number): void {
    let left = bytes;
    while (left > 0 && this.queue.length) {
      const head = this.queue[0]!;
      if (head.length <= left) {
        this.queue.shift();
        left -= head.length;
      } else {
        this.queue[0] = head.subarray(left);
        left = 0;
      }
    }
    this.queued -= bytes;
  }

  private drop(): void {
    this.queue.length = 0;
    this.queued = 0;
  }
}
