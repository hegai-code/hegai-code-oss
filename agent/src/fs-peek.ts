import os from 'node:os';
import path from 'node:path';
import { constants, fstat } from 'node:fs';
import { open, readlink, realpath, stat } from 'node:fs/promises';
import {
  FS_CHUNK_BYTES,
  FS_PEEK_EXTENSIONS,
  FS_PEEK_MAX_BYTES,
  type FsDownloadResult,
} from '@cc-remote/shared';

/**
 * `fs.peek`: the bytes behind the chat's file preview.
 *
 * An answer says «Скриншот: /tmp/claude-<uid>/-srv-app/<id>/scratchpad/mail.png»
 * and the person wants to SEE it, on a phone, without a terminal. The file
 * methods beside this one cannot serve that: they are confined to project
 * roots, and the scratchpad Claude Code hands every session lives in `/tmp`.
 *
 * So this method is narrower than `fs.download`, not a wider copy of it:
 *
 * - only preview types (`FS_PEEK_EXTENSIONS`), checked on the name asked for
 *   AND on the file it resolves to, so a `shot.png -> ~/.ssh/id_ed25519` link
 *   is not a picture;
 * - at most `FS_PEEK_MAX_BYTES`;
 * - only from two places: inside `cwd` (already proved a project root by the
 *   dispatcher's `assertRoot`), or a path in the system temp tree (`/tmp`,
 *   `os.tmpdir()`) that the request NAMES and that really resolves there.
 *   25.10.2026 this was only the scratchpad of `cwd`, and the very next answer
 *   put its frames in `/tmp/claude-<uid>/live2/` — sessions write to /tmp freely.
 *
 * Why a named temp path is safe to serve: realpath must land in temp too (a
 * planted `/tmp/a.png -> ~/secret.png` resolves outside and is refused), and a
 * share member never gets here with one — the hub judges `path` lexically
 * against the share's roots. What a member CAN name is a path inside the share,
 * and that must stay inside `cwd` after resolving.
 *
 * Same guard-rail caveat as fs-roots: whoever reaches this RPC already controls
 * the machine (or holds a share the hub checked); the boundary is the unix user.
 */

const PEEK_EXT = new Set<string>(FS_PEEK_EXTENSIONS);

export function peekable(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
  return PEEK_EXT.has(ext);
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** A temp tree a named file may sit in: where it is spelled (`lexical`, what a
 *  request must name) and where it really is (`/tmp` → `/private/tmp` on macOS). */
interface TmpBase {
  lexical: string;
  real: string;
}

/**
 * The system temp trees. Sessions put screenshots there — in Claude Code's
 * scratchpad, but just as often in `/tmp/claude-<uid>/live2/` or `/tmp/shot.png` —
 * so all of it is a preview source, for the two preview types only.
 */
export async function tmpBases(): Promise<TmpBase[]> {
  const out: TmpBase[] = [];
  for (const lexical of new Set([os.tmpdir(), '/tmp'])) {
    const real = await realpath(lexical).catch(() => null);
    if (!real) continue;
    // Both spellings may be named: `/tmp/a.png` and `/private/tmp/a.png` on macOS.
    out.push({ lexical: path.resolve(lexical), real }, { lexical: real, real });
  }
  return out;
}

/**
 * Where an open descriptor really points. Linux and Android: `/proc/self/fd`.
 * Elsewhere: `real` resolved again, accepted only if it is the same inode the
 * descriptor holds — a swap after the open shows up as a different file.
 */
export async function openedPath(fd: number, real: string): Promise<string | null> {
  const viaProc = await readlink(`/proc/self/fd/${fd}`).catch(() => null);
  if (viaProc && path.isAbsolute(viaProc)) return viaProc;
  const again = await realpath(real).catch(() => null);
  if (!again) return null;
  const [held, now] = await Promise.all([fstatAsync(fd), stat(again).catch(() => null)]);
  return held && now && held.ino === now.ino && held.dev === now.dev ? again : null;
}

function fstatAsync(fd: number): Promise<import('node:fs').Stats | null> {
  return new Promise((resolve) => fstat(fd, (err, st) => resolve(err ? null : st)));
}

export async function fsPeek(
  cwd: string,
  requested: string,
  offset = 0,
  length = FS_CHUNK_BYTES,
): Promise<FsDownloadResult> {
  if (!peekable(requested)) throw new Error('only images and markdown can be previewed');
  const realCwd = (await realpath(cwd).catch(() => null)) ?? path.resolve(cwd);
  const logical = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested);
  const real = await realpath(logical).catch((err: NodeJS.ErrnoException) => {
    throw new Error(err.code === 'ENOENT' ? 'file not found' : `cannot open: ${err.message}`);
  });
  if (!peekable(real)) throw new Error('only images and markdown can be previewed');
  // A temp file counts only when the request itself NAMES a temp path. A link
  // inside the project (`preview/link -> /tmp/…`) must not lead there: the hub
  // admits a share member by the lexical path, which then looks like it is
  // inside the share; a /tmp path it refuses them outright.
  // A path NAMED inside the project must also END inside it, wherever the
  // project lives — a project under /tmp included, or a link in a shared
  // `/tmp/shared` would reach every other temp file. The temp exception is
  // only for paths named outside the project.
  const named = path.resolve(logical);
  const namedInCwd = within(named, path.resolve(cwd)) || within(named, realCwd);
  const bases = namedInCwd ? [] : await tmpBases();
  const allowed = (where: string): boolean =>
    within(where, realCwd) ||
    (!namedInCwd && bases.some((b) => within(named, b.lexical) && within(where, b.real)));
  if (!allowed(real)) throw new Error('outside this project and the temp directory');
  // One descriptor from here on, opened without following a final symlink: the
  // checks above were made on `real`, and a `shot.png` swapped for a link to
  // `.env` between them and the read must not be what gets served.
  // (`O_NOFOLLOW` is 0 on Windows, where there is no scratch tree anyway.)
  const fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    (err: NodeJS.ErrnoException) => {
      throw new Error(err.code === 'ELOOP' ? 'file changed while opening' : `cannot open: ${err.message}`);
    },
  );
  try {
    // O_NOFOLLOW guards only the LAST component. In /tmp another account can
    // swap a parent directory for a link between the realpath above and the
    // open, so the file actually opened is judged again, by its descriptor.
    const opened = await openedPath(fh.fd, real);
    if (!opened || !peekable(opened) || !allowed(opened)) throw new Error('file changed while opening');
    const info = await fh.stat();
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > FS_PEEK_MAX_BYTES) throw new Error('file is too large to preview');
    const want = Math.max(0, Math.min(length, FS_CHUNK_BYTES, info.size - offset));
    const buf = Buffer.alloc(want);
    const { bytesRead } = want > 0 ? await fh.read(buf, 0, want, offset) : { bytesRead: 0 };
    return {
      path: requested,
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
