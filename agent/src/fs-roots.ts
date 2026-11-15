import path from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { declaredRoots, stateDir } from './config.js';
import { projectsRoot } from './project-ops.js';

/**
 * Which directories the file RPCs may be pointed at.
 *
 * `safeResolve` in fs-ops guards a path RELATIVE to a caller-supplied `cwd` — it
 * has never had an opinion about the cwd itself, so `cwd: "/"` was accepted and
 * granted the whole disk. That went unnoticed while no client called the file
 * RPCs. A browser file manager that can write, rename and delete makes it the
 * one place where a boundary can exist at all: the hub cannot help, because it
 * cannot resolve a path on a machine it does not have (see the comment on
 * `normalize_root` in server-rs/src/workspace.rs).
 *
 * **This is a guard-rail, not a sandbox.** A caller who reaches these RPCs has
 * already passed the hub's `can_control`, and that same caller can open a pty in
 * any directory. The real boundary is the unix user the agent runs as. What this
 * buys is that the product's promise — "you can browse your projects" — is true
 * in the agent rather than only in the web, and that a stale client or a
 * copy-pasted cwd cannot wander off into `~/.ssh`.
 *
 * The allow-list is deliberately PERSISTED rather than recomputed from the
 * session inventory on every call. Deriving it live would make access depend on
 * `buildInventory`'s 500-session window: start a burst of new sessions and an
 * older project silently falls out of the set, so a person three folders deep
 * gets an error and an empty pane. A root, once admitted, stays admitted.
 */

/** Cwds a session has been seen in, admitted once and remembered. */
interface RootsFile {
  roots: { cwd: string; lastSeen: number }[];
}

/**
 * Cap on remembered roots. Far above `buildInventory`'s own 500-session window,
 * so the eviction that would reintroduce the instability above cannot happen in
 * practice; it exists only so the file cannot grow without bound on a machine
 * that has run thousands of sessions.
 */
const MAX_REMEMBERED = 1000;
/** How long a resolved allow-list is reused before it is rebuilt. */
const CACHE_MS = 30_000;

function rootsFile(): string {
  return path.join(stateDir(), 'files-roots.json');
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Directories that are not projects, however a session came to sit in one.
 *
 * This is not hygiene, it is the difference between a guard-rail and no
 * guard-rail: a session started from a shell that happened to be at `/` records
 * `cwd: "/"`, and admitting that as a root admits the entire filesystem —
 * every other root in the list becomes decoration. A real fleet has these (this
 * machine had five), so the filter has to live here rather than in the caller
 * that happens to remember.
 *
 * The web has always applied the same test in `isRootish` before offering a
 * project to start in; the agent simply never did.
 */
export function isRootish(cwd: string): boolean {
  const seg = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  if (seg.length <= 1) return true; // "/", "/root", "C:"
  // A bare home directory is a person's whole world, not a project. On Windows
  // the drive letter is a segment of its own, so `C:/Users/Alice` has three —
  // counting only two admitted the whole home, `.ssh` included.
  const drive = /^[a-z]:$/i.test(seg[0]!) ? 1 : 0;
  const rest = seg.slice(drive);
  return rest.length === 2 && /^(users|home)$/i.test(rest[0]!);
}

/* Extra roots an operator names explicitly live in `declaredRoots` (config.ts)
   now — the project listing reads the same list, and two parsers of one env var
   is how the two layers came to disagree about what this machine holds. */

let sessionCwds: () => string[] = () => [];

/**
 * Where the agent learns about project directories that are not under the
 * projects root. Wired to the client's last inventory, which is refreshed on
 * every debounced watcher event — so this costs nothing and is never stale.
 */
export function setSessionCwdProvider(provider: () => string[]): void {
  sessionCwds = provider;
}

async function readRemembered(): Promise<RootsFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(rootsFile(), 'utf8'));
    const roots = (parsed as RootsFile | null)?.roots;
    if (!Array.isArray(roots)) return { roots: [] };
    return {
      roots: roots.filter(
        (r): r is { cwd: string; lastSeen: number } =>
          !!r && typeof r.cwd === 'string' && typeof r.lastSeen === 'number',
      ),
    };
  } catch {
    // Absent or corrupt: an empty memory still leaves the projects root and any
    // configured roots reachable, so a lost file degrades rather than locks out.
    return { roots: [] };
  }
}

async function writeRemembered(file: RootsFile): Promise<void> {
  try {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(rootsFile(), JSON.stringify(file, null, 2), 'utf8');
  } catch (err) {
    // Losing the memory costs reachability of session-derived roots until the
    // next successful write, never correctness. Not worth failing a call over.
    console.error('[agent] could not persist file roots:', (err as Error).message);
  }
}

/** Serialises the read-modify-write below. Two concurrent admissions read the
 *  same snapshot and the later write dropped the earlier one's root — which
 *  then became unreachable once it left the inventory. */
let writeChain: Promise<void> = Promise.resolve();

/** Admit these working directories, now and for future runs. */
export async function rememberRoots(cwds: string[]): Promise<void> {
  const run = writeChain.then(() => rememberRootsUnlocked(cwds));
  writeChain = run.catch(() => {});
  return run;
}

async function rememberRootsUnlocked(cwds: string[]): Promise<void> {
  const fresh = cwds.map((c) => path.resolve(c)).filter((c) => c && !isRootish(c));
  if (!fresh.length) return;
  const file = await readRemembered();
  const byCwd = new Map(file.roots.map((r) => [r.cwd, r]));
  const now = Date.now();
  let changed = false;
  for (const cwd of fresh) {
    const prev = byCwd.get(cwd);
    if (prev) {
      // Only the timestamp moves; rewriting for that alone would mean a disk
      // write on every listing, so it is not a change worth persisting.
      prev.lastSeen = now;
    } else {
      byCwd.set(cwd, { cwd, lastSeen: now });
      changed = true;
    }
  }
  if (!changed) return;
  const roots = [...byCwd.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_REMEMBERED);
  await writeRemembered({ roots });
  cache = undefined;
}

let cache: { at: number; roots: string[] } | undefined;

/** Resolve the allow-list to real paths, so a symlinked root still matches. */
async function buildRoots(): Promise<string[]> {
  const remembered = await readRemembered();
  const candidates = [
    projectsRoot(),
    ...declaredRoots(),
    ...remembered.roots.map((r) => r.cwd),
    ...sessionCwds().map((c) => path.resolve(c)),
  ];
  const out = new Set<string>();
  for (const c of candidates) {
    // `isRootish` is applied to the RESOLVED path too: `/Users/x/link` may be a
    // symlink to `/`, and a check that only looked at what was typed would let
    // it through.
    if (!c || isRootish(c)) continue;
    // A root that does not exist yet (a projects root on a fresh machine) is
    // still a legitimate root — keep the logical path so it works the moment it
    // is created.
    const real = await realpath(c).catch(() => c);
    if (isRootish(real)) continue;
    out.add(real);
  }
  return [...out];
}

async function currentRoots(force = false): Promise<string[]> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_MS) return cache.roots;
  const roots = await buildRoots();
  cache = { at: now, roots };
  return roots;
}

/** Drop the cached allow-list; the next check rebuilds it. */
export function invalidateRoots(): void {
  cache = undefined;
}

/**
 * Prove `cwd` is one of the allowed roots, or inside one, and return it resolved
 * through realpath.
 *
 * On a miss the list is rebuilt once before refusing: a project created seconds
 * ago must not be rejected because the cache predates it.
 */
export async function assertRoot(cwd: string): Promise<string> {
  const target = await realpath(cwd).catch(() => path.resolve(cwd));
  for (const force of [false, true]) {
    const roots = await currentRoots(force);
    if (roots.some((r) => within(target, r))) return target;
    if (force) break;
  }
  throw new Error('that directory is not one of this machine\'s project roots');
}
