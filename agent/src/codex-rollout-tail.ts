import { openRollout } from './confine.js';

/**
 * Follows a Codex rollout while a turn runs and hands over every new
 * `image_generation_call` payload.
 *
 * Why this exists: codex-cli 0.164 app-server emits NO `imageGeneration` item
 * for the built-in `image_gen` tool (verified live 24.10.2026) — the picture is
 * only a `response_item` line in the rollout, 1-3 MB of base64 on ONE line,
 * written right after the reasoning item before it. `rawResponseItem/completed`
 * would carry it but only exists when `thread/start` asks for raw events;
 * `thread/resume` does not take that flag, so it cannot cover resumed sessions.
 *
 * Cost control: only the APPENDED bytes are read (positioned reads from a
 * remembered offset), reads never overlap, and a line is parsed only when it
 * mentions `image_generation_call`.
 */

const POLL_MS = 1500;
const CHUNK_BYTES = 1024 * 1024;
/** A partial line longer than this is dropped (a tool output, never a picture we could show). */
const REMAINDER_CAP = 32 * 1024 * 1024;
const NEEDLE = '"image_generation_call"';

export interface RolloutImageTailOptions {
  /** The rollout path, or null while it does not exist / is not known yet. Called again on every tick until it answers. */
  resolve: () => Promise<string | null>;
  /** One new `image_generation_call` payload (never a compaction record). */
  onCall: (payload: Record<string, unknown>) => void;
  intervalMs?: number;
}

export class RolloutImageTail {
  private readonly opts: RolloutImageTailOptions;
  private timer?: NodeJS.Timeout;
  private path: string | null = null;
  private offset = 0;
  private remainder: Buffer = Buffer.alloc(0);
  /** Past the cap: ignore bytes until the next newline. */
  private skipToNewline = false;
  private reading: Promise<void> = Promise.resolve();
  private baseline: Promise<void> = Promise.resolve();
  private baselined = true;
  private generation = 0;
  private on = false;

  constructor(opts: RolloutImageTailOptions) {
    this.opts = opts;
  }

  /** A turn is in progress: tailing runs from here to `drain()`/`stop()`. */
  get active(): boolean {
    return this.on;
  }

  /** Start of a turn: what is in the file now is old news. The first read waits for the baseline;
   *  the returned promise (never rejects) settles when it is taken. */
  begin(): Promise<void> {
    this.stop();
    this.on = true;
    const generation = ++this.generation;
    this.path = null;
    this.offset = 0;
    this.remainder = Buffer.alloc(0);
    this.skipToNewline = false;
    this.baselined = false;
    this.baseline = this.mark(generation).finally(() => {
      if (generation === this.generation) this.baselined = true;
    });
    const interval = this.opts.intervalMs ?? POLL_MS;
    this.timer = setInterval(() => void this.poll(), interval);
    this.timer.unref();
    return this.baseline;
  }

  /** One last read, then stop. Resolves once every line written so far was delivered. */
  async drain(): Promise<void> {
    if (!this.on) return;
    const generation = this.generation;
    await this.poll(true);
    if (generation === this.generation) this.stop();
  }

  stop(): void {
    this.on = false;
    // A read already in flight sees the new generation and drops what it read:
    // nothing is announced after the turn ended, and nothing leaks into the
    // offset/remainder of the next turn's `begin()`.
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async mark(generation: number): Promise<void> {
    let path: string | null = null;
    try {
      path = await this.opts.resolve();
    } catch {
      // Not resolvable yet: the ticks keep asking.
    }
    if (!path || generation !== this.generation) return;
    this.path = path;
    try {
      const handle = await openRollout(path);
      try {
        const size = (await handle.stat()).size;
        if (generation === this.generation) this.offset = size;
      } finally {
        await handle.close();
      }
    } catch {
      // Named but not on disk yet (a fresh thread): everything in it is this turn's.
      if (generation === this.generation) this.offset = 0;
    }
  }

  /** Serialised: a tick while a read is in flight waits for it instead of overlapping. */
  private poll(final = false): Promise<void> {
    const next = this.reading.then(() => this.readNew(final)).catch(() => {});
    this.reading = next;
    return next;
  }

  private async readNew(final: boolean): Promise<void> {
    if (!this.on) return;
    const generation = this.generation;
    // The closing read does not wait for a baseline still being taken (a directory
    // scan): a turn that ended that fast cannot have finished a picture.
    if (final && !this.baselined) return;
    await this.baseline;
    if (generation !== this.generation) return;
    try {
      if (!this.path) {
        // The closing read must not wait on a directory scan: a file no tick
        // has found in 1.5 s+ cannot hold a finished picture yet.
        if (final) return;
        const path = await this.opts.resolve();
        if (!path || generation !== this.generation) return;
        this.path = path;
      }
      // `openRollout`, not `open`: on a confined machine the rollout is written
      // by a sandboxed model, so the name is opened O_NOFOLLOW and the
      // descriptor must really be inside its unit's sessions dir. Size and
      // bytes both come from that one handle — never a re-resolved pathname.
      const handle = await openRollout(this.path);
      try {
        const size = (await handle.stat()).size;
        if (generation !== this.generation) return;
        if (size < this.offset) {
          // Truncated or replaced: nothing in it is ours to announce.
          this.offset = size;
          this.remainder = Buffer.alloc(0);
          this.skipToNewline = false;
          return;
        }
        while (this.offset < size && generation === this.generation) {
          const want = Math.min(CHUNK_BYTES, size - this.offset);
          const buf = Buffer.allocUnsafe(want);
          const { bytesRead } = await handle.read(buf, 0, want, this.offset);
          if (bytesRead <= 0 || generation !== this.generation) break;
          this.offset += bytesRead;
          this.feed(buf.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Unreadable right now: the next tick retries from the same offset.
    }
  }

  private feed(chunk: Buffer): void {
    let data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    this.remainder = Buffer.alloc(0);
    for (;;) {
      const nl = data.indexOf(0x0a);
      if (nl < 0) break;
      const line = data.subarray(0, nl);
      data = data.subarray(nl + 1);
      if (this.skipToNewline) {
        this.skipToNewline = false;
        continue;
      }
      this.line(line);
    }
    // The record type sits in a line's first ~100 bytes; a long line that is
    // not a picture (tool output, an attached image) is skipped at once rather
    // than re-copied chunk after chunk on the event loop every session shares.
    const notAPicture = data.length > 64 * 1024 && !data.subarray(0, 4096).includes(NEEDLE);
    if (data.length > REMAINDER_CAP || notAPicture || (this.skipToNewline && data.length > 0)) {
      this.skipToNewline = true;
      return;
    }
    // `subarray` views the big chunk; copy so a short tail does not pin it.
    this.remainder = Buffer.from(data);
  }

  private line(line: Buffer): void {
    if (!line.includes(NEEDLE)) return;
    let record: { type?: unknown; payload?: Record<string, unknown>; metadata?: Record<string, unknown> } | null;
    try {
      record = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    const payload = record?.payload;
    if (record?.type !== 'response_item' || !payload || payload['type'] !== 'image_generation_call') return;
    // The compactor's scratch pictures, not the model's (see parseCodexPayload).
    if (record.metadata?.['compaction_output'] === true) return;
    if (asMeta(payload)['compaction_output'] === true) return;
    this.opts.onCall(payload);
  }
}

function asMeta(payload: Record<string, unknown>): Record<string, unknown> {
  const meta = payload['metadata'];
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}
