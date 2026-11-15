import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, stat } from 'node:fs/promises';
import type { FsMkdirResult, FsRenameResult, FsTrashResult } from '@cc-remote/shared';
import { resolveInRoot, resolveEntry, realpathish, assertMutable } from './fs-ops.js';
import { moveToTrash } from './trash.js';

/**
 * Creating, renaming and deleting through the file manager.
 *
 * Modelled on `project-ops.ts`, which already worked out how this product does
 * destructive things: resolve, prove through realpath that no symlink leads out,
 * refuse when a live session owns the target, and never unlink — move to the
 * trash. What is added here is a deny-list, because the file manager can reach
 * directories `projects.remove` never could.
 */

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Refuse when a live session owns the target, or sits underneath it.
 *
 * Both sides go through realpath first, and that is load-bearing rather than
 * tidy: `target` arrives already resolved, while a session's recorded cwd is the
 * logical path it was started with. Compare the two directly and any symlink on
 * the way — `/var` on macOS, a symlinked home, a bind mount — makes the paths
 * differ as strings while naming one directory. The check would then pass, and
 * the directory of a running session would be renamed out from under it.
 */
async function assertNotLive(target: string, liveCwds: () => Promise<string[]>): Promise<void> {
  const live = await liveCwds();
  const realTarget = await realpathish(target);
  for (const cwd of live) {
    // `realpathish`, not `realpath`: a session's cwd may name a directory that
    // no longer exists, and a plain fallback to `path.resolve` would leave it
    // unresolved while the target is resolved — the two would then never match.
    const resolved = await realpathish(cwd);
    // Both directions: renaming a session's own cwd breaks it, and so does
    // renaming a parent directory out from under it.
    if (within(resolved, realTarget) || within(realTarget, resolved)) {
      throw new Error(`a session is live in ${cwd} — close it first`);
    }
  }
}

export interface FsManageDeps {
  /** Working directories with a live writer. Same provider `projects.remove`
   *  uses, so the two cannot disagree about what "busy" means. */
  liveCwds?: () => Promise<string[]>;
  trashDir?: string;
}

const noLive = async (): Promise<string[]> => [];

/**
 * Create a directory and any missing parents.
 *
 * Recursive AND idempotent on purpose: that is what makes a dropped folder a
 * plain loop over its distinct subdirectories, with no ordering dance and no
 * special case for a re-drop.
 */
export async function fsMkdir(cwd: string, rel: string, opts: { recursive?: boolean } = {}): Promise<FsMkdirResult> {
  const target = await resolveInRoot(cwd, rel);
  assertMutable(target);
  if (opts.recursive === false) {
    // One plain mkdir: a missing parent fails (ENOENT) and anything already
    // there — a folder, a file or a symlink — is refused, never reported as made.
    try {
      await mkdir(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Папка с таким именем уже есть');
      throw err;
    }
    return { path: rel, created: true };
  }
  const existing = await stat(target).catch(() => null);
  if (existing) {
    if (!existing.isDirectory()) throw new Error('a file with that name already exists');
    return { path: rel, created: false };
  }
  await mkdir(target, { recursive: true });
  return { path: rel, created: true };
}

export async function fsRename(
  cwd: string,
  from: string,
  to: string,
  deps: FsManageDeps = {},
): Promise<FsRenameResult> {
  // `resolveEntry`, not `resolveInRoot`: renaming a symlink must move the LINK,
  // not whatever it points at.
  const src = await resolveEntry(cwd, from);
  const dest = await resolveEntry(cwd, to);
  assertMutable(src);
  assertMutable(dest);
  if (src === dest) return { path: to };

  const info = await lstat(src).catch(() => null);
  if (!info) throw new Error('not found');

  const occupied = await lstat(dest).catch(() => null);
  let caseOnly = false;
  if (occupied) {
    // On a case-insensitive filesystem (APFS by default) `Readme.md` and
    // `README.md` are the same file, so a plain exists-check refuses a legal
    // case-only rename. Resolving both sides tells the two apart — and when
    // they ARE the same file, the rename still has to happen, through a
    // temporary name: `rename('Readme.md','README.md')` is a no-op there, and
    // returning success without renaming is worse than refusing.
    const [realSrc, realDest] = await Promise.all([
      realpath(src).catch(() => src),
      realpath(dest).catch(() => dest),
    ]);
    if (realSrc !== realDest) {
      // No silent clobber: a file manager that overwrites on rename is one that
      // loses work.
      throw new Error('something with that name already exists');
    }
    caseOnly = true;
  }

  await assertNotLive(src, deps.liveCwds ?? noLive);
  // The DESTINATION too: moving something into a directory a session is working
  // in mutates that session's tree just as surely as moving the source out.
  await assertNotLive(path.dirname(dest), deps.liveCwds ?? noLive);

  if (caseOnly) {
    const via = path.join(path.dirname(src), `.ccr-case-${randomUUID().slice(0, 8)}`);
    await rename(src, via);
    await rename(via, dest);
  } else {
    await rename(src, dest);
  }
  return { path: to };
}

export async function fsTrash(
  cwd: string,
  rel: string,
  deps: FsManageDeps = {},
): Promise<FsTrashResult> {
  // Trashing a symlink must move the LINK. Canonicalising here meant `link`
  // disappeared and its TARGET went to the trash instead — a delete that hit a
  // different file than the one shown.
  const target = await resolveEntry(cwd, rel);
  assertMutable(target);
  const base = await realpathish(cwd);
  if (target === base) throw new Error('refusing to delete the project root itself');
  const info = await lstat(target).catch(() => null);
  if (!info) throw new Error('not found');

  await assertNotLive(target, deps.liveCwds ?? noLive);
  const movedTo = await moveToTrash(target, deps.trashDir);
  return { ok: true, movedTo };
}
