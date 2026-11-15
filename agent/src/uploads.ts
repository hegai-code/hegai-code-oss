import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, readdir, rename, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  FS_CHUNK_BYTES,
  type FsUploadBeginResult,
  type FsUploadChunkResult,
  type FsUploadCommitResult,
} from '@cc-remote/shared';
import { resolveInRoot, assertMutable } from './fs-ops.js';

/**
 * Uploads, in windows.
 *
 * A single-shot upload would have been less code, and it is the wrong shape for
 * three independent reasons: the browser rejects any RPC after 30 seconds, so a
 * 9MB file fails on a hotel connection and has to start over; the hub relays the
 * body opaquely and would hold all of it in memory, on the machine that runs the
 * whole fleet; and its outbound queue counts messages rather than bytes, so one
 * fat frame is invisible to the backpressure that is supposed to catch it.
 *
 * The bytes land in a hidden `.part` file BESIDE the destination — same
 * filesystem, so the commit is a rename and therefore atomic. A reader in that
 * directory never sees a half-written file under its real name, and a session
 * that globs the folder mid-upload does not pick up a truncated one.
 */

/** Concurrent uploads one machine will hold open. Each costs a file handle and
 *  a `.part`; past this something is wrong with the client, not the person. */
const MAX_OPEN_UPLOADS = 8;
/** An upload nobody has touched for this long is abandoned. */
const IDLE_MS = 10 * 60 * 1000;
/** A `.part` older than this in a destination directory is debris from a crash. */
const STALE_PART_MS = 24 * 60 * 60 * 1000;
const PART_PREFIX = '.ccr-upload-';

interface Upload {
  fh: FileHandle;
  /** Absolute destination, with the name it will actually get. */
  target: string;
  tmp: string;
  size: number;
  received: number;
  touched: number;
  /** Path relative to the caller's cwd, for the result. */
  rel: string;
  /** Serialises writes for this upload. Two windows claiming the same offset
   *  both passed the check before either write landed, so both wrote to the
   *  same place and both advanced the counter — a one-byte file that commit
   *  cheerfully reported as two. */
  chain: Promise<void>;
}

export class UploadStore {
  private open = new Map<string, Upload>();
  private sweeper?: NodeJS.Timeout;
  /** Destination paths an in-flight upload has claimed. `freeName` only looked
   *  at the disk, so two uploads of `photo.jpg` started before either committed
   *  both resolved to `photo.jpg` and the second silently overwrote the first. */
  private reserved = new Set<string>();
  /** Slots taken by a `begin` that has not finished its awaits yet. The size
   *  check used to run before them, so twenty simultaneous begins all passed a
   *  limit of eight. */
  private starting = 0;

  /**
   * Decide the destination and open the scratch file.
   *
   * Everything that can be refused is refused HERE, before a byte travels:
   * someone who dropped 80MB should learn about a missing directory or a bad
   * name immediately, not after a two-minute upload.
   */
  async begin(
    cwd: string,
    dir: string,
    rawName: string,
    size: number,
    overwrite = false,
  ): Promise<FsUploadBeginResult> {
    if (this.open.size + this.starting >= MAX_OPEN_UPLOADS) {
      throw new Error('too many uploads in flight — finish one first');
    }
    this.starting += 1;
    try {
      const name = validName(rawName);
      const destDir = await resolveInRoot(cwd, dir);
      assertMutable(destDir);
      const info = await stat(destDir).catch(() => null);
      if (!info?.isDirectory()) throw new Error('destination folder does not exist');

      await sweepStaleParts(destDir);
      const finalName = overwrite ? name : await freeName(destDir, name, this.reserved);
      const target = path.join(destDir, finalName);
      assertMutable(target);

      const uploadId = randomUUID();
      const tmp = path.join(destDir, `${PART_PREFIX}${uploadId}.part`);
      const fh = await open(tmp, 'wx');
      this.reserved.add(target);
      this.open.set(uploadId, {
        fh,
        target,
        tmp,
        size,
        received: 0,
        touched: Date.now(),
        rel: dir ? `${dir}/${finalName}` : finalName,
        chain: Promise.resolve(),
      });
      this.startSweeper();
      return { uploadId, name: finalName, path: dir ? `${dir}/${finalName}` : finalName };
    } finally {
      this.starting -= 1;
    }
  }

  /**
   * Append one window.
   *
   * Strictly sequential. `offset` must equal what has already been written, so a
   * window that arrives twice, or out of order after a retry, is refused rather
   * than silently written at the wrong place — which would corrupt the file in a
   * way nothing downstream could detect.
   */
  async chunk(uploadId: string, offset: number, data: string): Promise<FsUploadChunkResult> {
    const up = this.get(uploadId);
    const buf = Buffer.from(data, 'base64');
    if (buf.length > FS_CHUNK_BYTES) throw new Error('upload window too large');
    // Check and write inside one link of the chain, so the offset a window was
    // validated against is still true when it lands.
    const run = up.chain.then(async () => {
      if (offset !== up.received) {
        throw new Error(`out-of-order upload window (expected ${up.received}, got ${offset})`);
      }
      if (up.received + buf.length > up.size) throw new Error('upload is longer than it declared');
      let written = 0;
      while (written < buf.length) {
        // A short write is legal and used to be counted as a full one, which
        // let a truncated file sail past commit's size check.
        const r = await up.fh.write(buf, written, buf.length - written, up.received + written);
        if (r.bytesWritten <= 0) throw new Error('write stalled');
        written += r.bytesWritten;
      }
      up.received += written;
      up.touched = Date.now();
    });
    // Keep the chain alive even when this link rejects, or one bad window would
    // deadlock every window after it.
    up.chain = run.catch(() => {});
    await run;
    return { received: up.received };
  }

  /** Flush to disk, then put the file under its real name in one step. */
  async commit(uploadId: string): Promise<FsUploadCommitResult> {
    const up = this.get(uploadId);
    if (up.received !== up.size) {
      throw new Error(`upload is incomplete (${up.received} of ${up.size} bytes)`);
    }
    // fsync before the rename: the whole promise of a file manager is that the
    // file is really on disk once it says so.
    await up.fh.sync();
    await up.fh.close();
    this.open.delete(uploadId);
    this.reserved.delete(up.target);
    try {
      await rename(up.tmp, up.target);
    } catch (err) {
      await unlink(up.tmp).catch(() => {});
      throw err;
    }
    return { path: up.rel, bytes: up.size };
  }

  /** Cancel: nothing was ever visible under the real name, so just drop it. */
  async abort(uploadId: string): Promise<{ ok: boolean }> {
    const up = this.open.get(uploadId);
    if (!up) return { ok: true }; // already gone — cancelling twice is not an error
    this.open.delete(uploadId);
    this.reserved.delete(up.target);
    await up.fh.close().catch(() => {});
    await unlink(up.tmp).catch(() => {});
    return { ok: true };
  }

  /** Drop every open upload. Called when the agent is shutting down. */
  async closeAll(): Promise<void> {
    const ids = [...this.open.keys()];
    for (const id of ids) await this.abort(id);
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  private get(uploadId: string): Upload {
    const up = this.open.get(uploadId);
    if (!up) throw new Error('unknown upload — it may have timed out, start again');
    return up;
  }

  /**
   * Abandoned uploads, closed on a timer.
   *
   * A dropped socket does not tell the agent which uploads died with it, and an
   * open handle plus a `.part` would otherwise sit there until the process
   * restarts. `unref` so this timer can never keep the agent alive.
   */
  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, up] of this.open) {
        if (now - up.touched > IDLE_MS) void this.abort(id);
      }
      if (!this.open.size && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = undefined;
      }
    }, 60_000);
    this.sweeper.unref?.();
  }
}

/**
 * A filename from a browser, VALIDATED rather than rewritten.
 *
 * `safeName` in attachments.ts is the right tool for an attachment and the wrong
 * one here, which is worth spelling out because reusing it looks obviously
 * correct. It strips leading dots, so `.gitignore` would land as `gitignore`;
 * and its allow-list stops at U+04FF, so a name macOS hands over in NFD — every
 * name dragged out of Finder — loses its combining marks: `Мой отчёт.txt`
 * becomes `Мои_ отче_т.txt`. An attachment can afford a mangled display name. A
 * file written into someone's project cannot.
 *
 * So: normalise to NFC, then refuse what cannot be a filename, and otherwise
 * keep exactly what was sent.
 */
export function validName(raw: string): string {
  const name = raw.normalize('NFC').trim();
  if (!name || name === '.' || name === '..') throw new Error('invalid file name');
  if (/[/\\]/.test(name)) throw new Error('a file name cannot contain a path separator');
  // NUL and the C0 range, written escaped: a literal control byte in source is
  // a trap for every tool that reads this file.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('invalid character in file name');
  if (Buffer.byteLength(name, 'utf8') > 255) throw new Error('file name too long');
  // A trailing dot or space is legal on POSIX but silently stripped by Windows,
  // which turns one file into two depending on who opens the project.
  if (/[ .]$/.test(name)) throw new Error('a file name cannot end with a space or a dot');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new Error('that name is reserved by Windows');
  }
  return name;
}

/**
 * `photo.jpg` → `photo-1.jpg` when taken.
 *
 * Auto-suffixing rather than asking: a prompt per collision is unusable when
 * someone drops forty photos. The cost is a silent second copy, which is why the
 * chosen name is returned to the caller and shown.
 */
async function freeName(dir: string, name: string, reserved: Set<string>): Promise<string> {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  for (let n = 1; n < 1000; n += 1) {
    const full = path.join(dir, candidate);
    // Both the disk AND the uploads already heading for that name.
    const taken =
      reserved.has(full) || (await stat(full).then(() => true, () => false));
    if (!taken) return candidate;
    candidate = `${stem}-${n}${ext}`;
  }
  throw new Error('too many files with that name');
}

/** Debris from an agent that died mid-upload, cleaned as we pass through. */
async function sweepStaleParts(dir: string): Promise<void> {
  const cutoff = Date.now() - STALE_PART_MS;
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.startsWith(PART_PREFIX) || !name.endsWith('.part')) continue;
    const full = path.join(dir, name);
    try {
      const info = await stat(full);
      if (info.mtimeMs < cutoff) await unlink(full);
    } catch {
      /* someone else's race — leave it */
    }
  }
}
