import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write a file so that a reader (or a crash) sees the old content or the new
 * one, never half of it: the bytes go to a scratch file beside the target and
 * are renamed over it. Same directory, so the rename stays on one filesystem
 * and is atomic.
 *
 * On any failure the scratch file is removed and the error is rethrown.
 * Callers that used to swallow a failed save swallow it themselves
 * (`.catch`), so that choice stays visible where it is made.
 */
export interface AtomicWriteOptions {
  /** Mode of the new file. Omitted: the process default (0o666 minus umask). */
  mode?: number;
  /** `mkdir -p` the parent first; a number is the mode for what that creates. */
  mkdir?: boolean | number;
  /** fsync before the rename, so the name never points at bytes not yet on disk. */
  fsync?: boolean;
  /** Hidden scratch name (`.<name>.<id>.part`) instead of `<name>.<id>.tmp`. */
  hiddenTmp?: boolean;
}

/** A fresh scratch path beside `target`. The id is random, so concurrent writers never share one. */
export function tmpPathFor(target: string, opts: { hidden?: boolean } = {}): string {
  const id = randomUUID().slice(0, 8);
  return opts.hidden
    ? path.join(path.dirname(target), `.${path.basename(target)}.${id}.part`)
    : `${target}.${id}.tmp`;
}

function mkdirOptions(mode: boolean | number): { recursive: true; mode?: number } {
  return typeof mode === 'number' ? { recursive: true, mode } : { recursive: true };
}

export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  if (opts.mkdir) await mkdir(path.dirname(target), mkdirOptions(opts.mkdir));
  const tmp = tmpPathFor(target, { hidden: opts.hiddenTmp === true });
  // `wx`: a name that already exists is somebody else's file, not ours to remove.
  const fh = await open(tmp, 'wx', opts.mode);
  try {
    await fh.writeFile(data);
    if (opts.fsync) await fh.sync();
    await fh.close();
    await rename(tmp, target);
  } catch (err) {
    // A failed write (ENOSPC is the realistic one) must not leave its scratch
    // file behind: nothing sweeps this name.
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** `writeFileAtomic` for the callers that are synchronous by contract. */
export function writeFileAtomicSync(target: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  if (opts.mkdir) mkdirSync(path.dirname(target), mkdirOptions(opts.mkdir));
  const tmp = tmpPathFor(target, { hidden: opts.hiddenTmp === true });
  const fd = openSync(tmp, 'wx', opts.mode);
  let fdOpen = true;
  try {
    writeFileSync(fd, data);
    if (opts.fsync) fsyncSync(fd);
    closeSync(fd);
    fdOpen = false;
    renameSync(tmp, target);
  } catch (err) {
    if (fdOpen) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* the scratch file may never have been created */
    }
    throw err;
  }
}
