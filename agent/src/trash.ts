import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { stateDir } from './config.js';

/**
 * The agent's trash: where anything this product "deletes" actually goes.
 *
 * One trash for the whole machine, shared by `projects.remove`, Codex session
 * deletion and the file manager — one place to look when something is missing,
 * and one sweeper rather than three.
 */

/** How long a trashed entry is kept. Deleting became an everyday action the day
 *  the file manager shipped; before that the trash only ever held whole
 *  projects, so nothing swept it and nothing had to. */
const DEFAULT_TRASH_DAYS = 14;

export function trashRoot(): string {
  return path.join(stateDir(), 'trash');
}

export function trashDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['CC_REMOTE_TRASH_DAYS']);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TRASH_DAYS;
}

/** `2026-09-15T12-34-56-789Z` — filesystem-safe and sorts chronologically. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * When an entry was TRASHED, read back from the name this module wrote.
 *
 * Not its mtime: `rename` preserves that, so a file last edited a month ago was
 * already older than the retention window the moment it reached the trash and
 * the next sweep deleted it immediately — silently voiding the recovery the
 * word "trash" promises. Falls back to mtime for anything not named by us.
 */
function trashedAt(name: string, fallbackMs: number): number {
  const m = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-[0-9a-f]{1,8})?$/.exec(name);
  if (!m?.[1]) return fallbackMs;
  const iso = m[1].replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallbackMs;
}

/**
 * Move a file or directory into the trash and return where it landed.
 *
 * `rename` is the fast path, but it fails with `EXDEV` the moment the target
 * lives on a different filesystem than the state dir — an external volume, a
 * container mount, `/srv` on its own partition. `removeProject` had exactly this
 * bug and surfaced it as a raw errno; doing the copy-then-remove fallback here
 * fixes it for every caller at once.
 */
export async function moveToTrash(target: string, dir = trashRoot()): Promise<string> {
  await mkdir(dir, { recursive: true });
  // The suffix carries a short random tail as well as the stamp: two files with
  // the same basename deleted inside one millisecond produced identical
  // destinations, and POSIX rename then overwrote the first one's only copy.
  const movedTo = path.join(dir, `${path.basename(target)}-${stamp()}-${randomUUID().slice(0, 6)}`);
  try {
    await rename(target, movedTo);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(target, movedTo, { recursive: true });
    await rm(target, { recursive: true, force: true });
  }
  return movedTo;
}

/**
 * Drop trashed entries older than the retention window.
 *
 * Scoped so it can only ever remove things directly inside the trash directory:
 * a sweeper that could be pointed elsewhere is a much worse bug than a full
 * disk. Failures are swallowed per entry — housekeeping must never take the
 * agent down.
 */
export async function sweepTrash(dir = trashRoot(), days = trashDays()): Promise<number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // no trash yet — nothing to sweep
  }
  let removed = 0;
  for (const name of entries) {
    const full = path.join(dir, name);
    // Re-derive rather than trust: `full` must be a direct child of `dir`.
    if (path.dirname(full) !== path.resolve(dir)) continue;
    try {
      const info = await stat(full);
      if (trashedAt(name, info.mtimeMs) > cutoff) continue;
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* one unremovable entry must not stop the sweep */
    }
  }
  return removed;
}
