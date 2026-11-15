import os from 'node:os';
import path from 'node:path';
import { readdir, open, realpath, stat, lstat } from 'node:fs/promises';
import { writeFileAtomic } from './atomic-write.js';
import { stateDir } from './config.js';
import {
  FS_CHUNK_BYTES,
  FS_MAX_ENTRIES,
  FS_MAX_WRITE_BYTES,
  type FsDownloadResult,
  type FsEntry,
  type FsListResult,
  type FsReadResult,
  type FsWriteResult,
} from '@cc-remote/shared';

/**
 * Filesystem operations scoped to a working directory.
 *
 * Two guards, and they do different jobs. `safeResolve` is lexical: it proves a
 * relative path cannot climb out with `..`, and it is enough for a caller that
 * only reads. `resolveInRoot` additionally resolves symlinks, which is what a
 * caller that WRITES needs — a repository can legitimately contain
 * `docs -> /home/u/.ssh`, and a lexical check says that is inside the project
 * right up until the write lands somewhere else entirely.
 *
 * Whether the `cwd` itself is legitimate is decided one layer up, in fs-roots.
 */

const MAX_READ_BYTES = 512 * 1024;

export function safeResolve(cwd: string, rel: string): string {
  const base = path.resolve(cwd);
  const target = path.resolve(base, rel || '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('path escapes working directory');
  }
  return target;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** Nearest ancestor that exists, plus the segments below it that do not. */
async function nearestReal(p: string): Promise<{ real: string; tail: string[] }> {
  const tail: string[] = [];
  let probe = p;
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real !== null) return { real, tail: tail.reverse() };
    const parent = path.dirname(probe);
    if (parent === probe) return { real: probe, tail: tail.reverse() };
    tail.push(path.basename(probe));
    probe = parent;
  }
}

/**
 * `realpath` for a path that may not exist yet: resolve the nearest existing
 * ancestor and re-append the missing tail.
 *
 * Needed wherever two paths are compared and only one of them is known to
 * exist. Plain `realpath` with a fallback to `path.resolve` is NOT equivalent:
 * on macOS the fallback leaves `/var/...` while the resolved side reads
 * `/private/var/...`, so the two name one directory and compare as different —
 * which is how a "is a session live in here?" check silently answers no.
 */
export async function realpathish(p: string): Promise<string> {
  const { real, tail } = await nearestReal(path.resolve(p));
  return tail.length ? path.join(real, ...tail) : real;
}

/**
 * Resolve `rel` inside `cwd` through symlinks, and prove the result is still
 * inside. Works for a path that does not exist yet (an upload destination): the
 * nearest existing ancestor is resolved and the missing tail re-appended.
 *
 * Residual, and worth naming: without `openat`/`O_NOFOLLOW` this is a check
 * followed by an open, so a symlink swapped in between the two would still win.
 * That race needs code execution as the same unix user, which is already past
 * every boundary this agent has.
 */
export async function resolveInRoot(cwd: string, rel: string): Promise<string> {
  const logical = safeResolve(cwd, rel);
  const realBase = (await realpath(cwd).catch(() => null)) ?? path.resolve(cwd);
  const { real, tail } = await nearestReal(logical);
  const resolved = tail.length ? path.join(real, ...tail) : real;
  if (!within(resolved, realBase)) throw new Error('path escapes working directory');
  return resolved;
}

/** Refuse when the final component is itself a symlink. A write through one
 *  would land on its target, which is not the file the person is looking at. */
async function refuseSymlink(target: string): Promise<void> {
  const info = await lstat(target).catch(() => null);
  if (info?.isSymbolicLink()) throw new Error('refusing to write through a symlink');
}

/**
 * Directories no file operation may ever mutate, whatever the roots say.
 *
 * The first entry is the one that matters. `~/.claude/sessions/<pid>.json` is
 * how the agent knows an editor is holding a session: `readLiveSessions` reads
 * that directory, and the yield watcher is the third layer of the single-writer
 * invariant. Delete a stale-LOOKING file there and a live editor session becomes
 * invisible — the hub stops refusing `open`, and the agent resumes a transcript
 * someone else is still writing. That is the one corruption this product
 * promises cannot happen, reachable from a browser through a file manager.
 *
 * The rest are credentials and agent state: nothing a person browsing a project
 * means to touch, and everything they would regret touching.
 */
function denyList(): string[] {
  const home = os.homedir();
  return [
    stateDir(),
    path.join(home, '.claude'),
    path.join(home, '.codex'),
    path.join(home, '.codex-units'),
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
  ].map((p) => path.resolve(p));
}

/**
 * Refuse a mutation of protected state.
 *
 * Reads are deliberately NOT gated by this: opening `.git/config` to look at it
 * is ordinary, and a file manager that cannot show you `.git` is lying about the
 * disk. It is writing to it that corrupts a repository underneath a running
 * session.
 */
export function assertMutable(target: string): void {
  const resolved = path.resolve(target);
  for (const deny of denyList()) {
    if (within(resolved, deny)) {
      throw new Error(`${path.basename(deny)} is managed by the agent and cannot be changed here`);
    }
  }
  if (resolved.split(path.sep).includes('.git')) {
    throw new Error('refusing to change anything inside .git');
  }
}

/**
 * Resolve an ENTRY without following a final symlink.
 *
 * `resolveInRoot` canonicalises the whole path, which is what a read wants — and
 * exactly wrong for delete and rename. With `link -> actual` inside a project,
 * canonicalising meant trashing `link` moved `actual` and left a dangling link
 * behind: the operation quietly acted on a different file than the one the
 * person selected. The parent is still resolved, so the containment guarantee
 * is unchanged.
 */
export async function resolveEntry(cwd: string, rel: string): Promise<string> {
  const logical = safeResolve(cwd, rel);
  const realBase = await realpathish(cwd);
  if (logical === path.resolve(cwd)) return realBase; // the root itself
  const resolved = path.join(await realpathish(path.dirname(logical)), path.basename(logical));
  if (!within(resolved, realBase)) throw new Error('path escapes working directory');
  return resolved;
}

export async function fsList(cwd: string, rel: string): Promise<FsListResult> {
  const dir = await resolveInRoot(cwd, rel);
  const dirents = await readdir(dir, { withFileTypes: true });
  const total = dirents.length;
  // Sort before slicing, so truncation is predictable (all directories, then
  // alphabetical files) instead of an arbitrary slice of inode order.
  //
  // Nothing is hidden here. A file MANAGER that silently omits `node_modules` or
  // `.git` is lying about the disk; hiding dotfiles is a view preference and
  // belongs to the client.
  const ordered = dirents.sort((a, b) => {
    const ad = a.isDirectory();
    const bd = b.isDirectory();
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const slice = ordered.slice(0, FS_MAX_ENTRIES);
  const entries: FsEntry[] = await Promise.all(
    slice.map(async (d): Promise<FsEntry> => {
      const link = d.isSymbolicLink();
      const full = path.join(dir, d.name);
      // stat follows the link, so a symlink to a directory reads as a directory
      // — which is what a person clicking it expects. A broken one keeps the
      // lstat answer and simply carries no size.
      const info = await (link ? stat(full).catch(() => null) : lstat(full).catch(() => null));
      const isDir = info ? info.isDirectory() : d.isDirectory();
      const entry: FsEntry = { name: d.name, kind: isDir ? 'dir' : 'file' };
      if (info && !isDir) entry.size = info.size;
      if (info) entry.mtime = Math.round(info.mtimeMs);
      if (link) entry.link = true;
      return entry;
    }),
  );
  const out: FsListResult = { path: rel, entries };
  if (total > FS_MAX_ENTRIES) {
    out.truncated = true;
    out.total = total;
  }
  return out;
}

/**
 * Drop a trailing UTF-8 sequence the read window cut in half.
 *
 * Without this a Cyrillic file truncated at 512KB ends in a replacement
 * character, because the cut lands between the two bytes of a letter. The Rust
 * side already learned this lesson for transcripts (`clip_payload`).
 */
function trimPartialUtf8(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80) {
    cont += 1;
    i -= 1;
  }
  if (i < 0) return buf;
  const lead = buf[i]!;
  const need = lead < 0x80 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
  return need > cont ? buf.subarray(0, i) : buf;
}

export async function fsRead(cwd: string, rel: string): Promise<FsReadResult> {
  const file = await resolveInRoot(cwd, rel);
  const info = await stat(file);
  if (info.isDirectory()) throw new Error('path is a directory');
  const truncated = info.size > MAX_READ_BYTES;
  // Read at most MAX_READ_BYTES — never pull a huge file fully into memory just
  // to slice it. A multi-MB log would otherwise spike the agent's heap per read.
  const toRead = Math.min(info.size, MAX_READ_BYTES);
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, 0);
    const slice = buf.subarray(0, bytesRead);
    const content = (truncated ? trimPartialUtf8(slice) : slice).toString('utf8');
    return { path: rel, content, truncated };
  } finally {
    await fh.close();
  }
}

export async function fsWrite(cwd: string, rel: string, content: string): Promise<FsWriteResult> {
  const file = await resolveInRoot(cwd, rel);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > FS_MAX_WRITE_BYTES) throw new Error('file too large to write');
  // The same deny-list the destructive operations obey. Without it a text write
  // reached `.git/config` and the agent's own state — the prohibition was
  // enforced on three paths out of four.
  assertMutable(file);
  await refuseSymlink(file);
  // Write beside the target and rename: a dropped socket mid-write must not
  // leave a truncated file where a good one was.
  await writeFileAtomic(file, content, { fsync: true, hiddenTmp: true });
  return { path: rel, bytes };
}

/**
 * One window of a file's raw bytes.
 *
 * `size` and `mtime` ride every window, not just the first: a file rewritten
 * between windows would otherwise be stitched together from two generations
 * without anyone noticing. The handle is stat'd rather than the path, which
 * closes the obvious race inside a single call.
 */
export async function fsDownload(
  cwd: string,
  rel: string,
  offset = 0,
  length = FS_CHUNK_BYTES,
): Promise<FsDownloadResult> {
  const file = await resolveInRoot(cwd, rel);
  const fh = await open(file, 'r');
  try {
    const info = await fh.stat();
    if (info.isDirectory()) throw new Error('path is a directory');
    const want = Math.max(0, Math.min(length, FS_CHUNK_BYTES, info.size - offset));
    const buf = Buffer.alloc(want);
    const { bytesRead } = want > 0 ? await fh.read(buf, 0, want, offset) : { bytesRead: 0 };
    return {
      path: rel,
      offset,
      data: buf.subarray(0, bytesRead).toString('base64'),
      bytes: bytesRead,
      size: info.size,
      mtime: Math.round(info.mtimeMs),
      eof: offset + bytesRead >= info.size,
    };
  } finally {
    await fh.close();
  }
}
