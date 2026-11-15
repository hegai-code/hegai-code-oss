import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type {
  ProjectAdoptResult,
  ProjectCreateResult,
  ProjectForgetResult,
  ProjectInfo,
  ProjectRemoveResult,
} from '@cc-remote/shared';
import { declaredRoots, stateDir } from './config.js';
import { safeResolve, realpathish } from './fs-ops.js';
import { readLiveSessions } from './sessions.js';
import { moveToTrash, trashRoot } from './trash.js';
import { childEnv } from './child-env.js';
import { isExternal } from './edition.js';

/**
 * Project directories under this machine's projects root — the "Create
 * project" button's other half.
 *
 * Everything stays inside the root (`CC_REMOTE_PROJECTS_ROOT`, default
 * `~/work`): a parent is resolved with the same anti-traversal idiom the file
 * RPCs use and re-checked through `realpath`, so a symlink cannot point a
 * create or a remove somewhere else. Git runs through `execFile` with argument
 * arrays only — no shell, `--` before anything user-supplied, and no prompts.
 * Nothing is ever deleted: `removeProject` renames into the agent's trash.
 */

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_PROJECTS = 30;
const CLONE_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;
/** Author of the initial commit of an empty project. Not the person: their
 *  first OWN commit must stay distinguishable for the community metrics. */
export function initAuthor(env: NodeJS.ProcessEnv = process.env, external: boolean = isExternal()): { name: string; email: string } {
  return {
    name: env['CC_REMOTE_GIT_AUTHOR_NAME']?.trim() || 'Hegai Code',
    email: env['CC_REMOTE_GIT_AUTHOR_EMAIL']?.trim() || (external ? 'agent@localhost' : 'code@a.test'),
  };
}

export interface ProjectCreateParams {
  name: string;
  gitUrl?: string;
  template?: 'empty';
  parent?: string;
}

/** Injection points for tests; production callers pass nothing. */
export interface ProjectOpsDeps {
  root?: string;
  maxProjects?: number;
  trashDir?: string;
  /** Working directories with a live writer (an editor session, one of our
   *  own runs). A project one of them sits in is never moved. */
  liveCwds?: () => Promise<string[]>;
  /** Where the adopted list is persisted. Tests redirect it; production uses
   *  `stateDir()`. */
  adoptedFile?: string;
}

export function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['CC_REMOTE_PROJECTS_ROOT']?.trim();
  return path.resolve(raw || path.join(os.homedir(), 'work'));
}

export function maxProjects(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['CC_REMOTE_MAX_PROJECTS']);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_PROJECTS;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: childEnv({ GIT_TERMINAL_PROMPT: '0' }),
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    const detail = e.stderr?.trim() || e.message || 'git failed';
    throw new Error(e.killed ? `git ${args[0]} timed out` : detail);
  }
}

type DirState = 'absent' | 'empty' | 'nonempty' | 'file';

async function dirState(target: string): Promise<DirState> {
  let info;
  try {
    info = await stat(target);
  } catch {
    return 'absent';
  }
  if (!info.isDirectory()) return 'file';
  const entries = await readdir(target);
  return entries.length ? 'nonempty' : 'empty';
}

/** Directories directly under the root, hidden ones excluded — `.cache` is
 *  not a project. */
async function countProjects(root: string): Promise<number> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).length;
  } catch {
    return 0;
  }
}

/** Resolve `parent` inside the root, creating it if needed, and prove through
 *  realpath that no symlink leads out. Returns the logical (non-realpath'd)
 *  path so the reported cwd matches what a session records. */
async function resolveParent(root: string, parent: string | undefined): Promise<string> {
  let logical: string;
  try {
    logical = safeResolve(root, parent ?? '');
  } catch {
    throw new Error('parent must be inside the projects root');
  }
  await mkdir(logical, { recursive: true });
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(logical)]);
  if (!within(realParent, realRoot)) throw new Error('parent must be inside the projects root');
  return logical;
}

async function initEmptyProject(target: string, name: string): Promise<void> {
  try {
    await git(target, ['init', '-b', 'main']);
  } catch {
    // git < 2.28 has no -b; the symbolic-ref form is what -b does internally.
    await git(target, ['init']);
    await git(target, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  await writeFile(path.join(target, 'README.md'), `# ${name}\n`, 'utf8');
  await git(target, ['add', '--', 'README.md']);
  const author = initAuthor();
  await git(target, [
    '-c', `user.name=${author.name}`,
    '-c', `user.email=${author.email}`,
    // A sandbox may inherit signing config with no key to sign with.
    '-c', 'commit.gpgsign=false',
    'commit', '-m', `init: ${name}`,
  ]);
}

async function cloneProject(parent: string, name: string, url: string): Promise<void> {
  await git(parent, ['clone', '--', url, name], CLONE_TIMEOUT_MS);
}

/** Empty a reused directory after a failed init/clone, or drop one we made. */
async function undoPartial(target: string, created: boolean): Promise<void> {
  if (created) {
    await rm(target, { recursive: true, force: true }).catch(() => {});
    return;
  }
  const entries = await readdir(target).catch(() => [] as string[]);
  for (const entry of entries) {
    await rm(path.join(target, entry), { recursive: true, force: true }).catch(() => {});
  }
}

export async function createProject(
  params: ProjectCreateParams,
  deps: ProjectOpsDeps = {},
): Promise<ProjectCreateResult> {
  const root = deps.root ?? projectsRoot();
  await mkdir(root, { recursive: true });
  const parent = await resolveParent(root, params.parent);
  const target = path.join(parent, params.name);

  const state = await dirState(target);
  if (state === 'file') throw new Error(`"${params.name}" exists and is not a directory`);
  if (state === 'nonempty') throw new Error(`project "${params.name}" already exists and is not empty`);
  const created = state === 'absent';
  if (created) {
    const cap = deps.maxProjects ?? maxProjects();
    const count = await countProjects(root);
    if (count >= cap) throw new Error(`project limit reached (${cap}) — remove one first`);
    await mkdir(target);
  }

  const mode: ProjectCreateResult['git'] = params.gitUrl ? 'clone' : 'init';
  try {
    if (params.gitUrl) await cloneProject(parent, params.name, params.gitUrl);
    else await initEmptyProject(target, params.name);
  } catch (err) {
    await undoPartial(target, created);
    throw new Error(`${mode === 'clone' ? 'clone' : 'init'} failed: ${(err as Error).message}`);
  }
  return { cwd: target, label: params.name, created, git: mode };
}

/** Working directories of every live editor session on this machine. Our own
 *  runs are not in here (the liveness scan skips them by design) — the
 *  dispatcher adds those from the RunManager. */
export async function liveSessionCwds(): Promise<string[]> {
  const live = await readLiveSessions();
  return [...live.values()].map((s) => s.cwd).filter((c): c is string => typeof c === 'string' && c.length > 0);
}

export async function removeProject(
  params: { cwd: string },
  deps: ProjectOpsDeps = {},
): Promise<ProjectRemoveResult> {
  const root = deps.root ?? projectsRoot();
  const resolvedRoot = path.resolve(root);
  let target: string;
  try {
    target = safeResolve(root, params.cwd);
  } catch {
    throw new Error('only projects under the projects root can be removed');
  }
  if (target === resolvedRoot) throw new Error('refusing to remove the projects root itself');
  const info = await stat(target).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error('project directory not found');
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (realTarget === realRoot || !within(realTarget, realRoot)) {
    throw new Error('only projects under the projects root can be removed');
  }

  // Compare resolved paths on both sides. A session records the logical cwd it
  // was started with, while `realTarget` has been through realpath — so any
  // symlink on the way (`/var` on macOS, a symlinked home, a bind mount) makes
  // the two differ as strings while naming one directory, and a live project
  // would be moved anyway.
  const live = await (deps.liveCwds ?? liveSessionCwds)();
  for (const cwd of live) {
    const resolved = await realpathish(cwd);
    if (within(resolved, realTarget)) throw new Error(`a session is live in ${cwd} — close it first`);
  }

  // Shared with the file manager, so both land in one trash — and so both get
  // the EXDEV fallback this used to lack (a project on another volume failed
  // with a raw errno).
  const movedTo = await moveToTrash(target, deps.trashDir ?? trashRoot());
  return { ok: true, movedTo };
}

// ---- Adopted projects -----------------------------------------------------
/**
 * Directories somebody took into the project list by hand.
 *
 * Its own file, deliberately NOT `files-roots.json`. That one is the file RPCs'
 * allow-list and holds every cwd a session has ever been seen in — hundreds on a
 * working box — so folding it into the project listing would bury the twenty
 * directories a person actually works in under every scratch dir a cron loop
 * ever ran from. Two lists because they answer two different questions: "may
 * this be opened" and "is this a project".
 *
 * What adoption is FOR is the gap the root scan leaves on purpose. That scan
 * admits a directory only if it holds `.git`, at depth one or two under a root —
 * so a folder that is not a repository is invisible, and no amount of declaring
 * roots fixes it.
 */
interface AdoptedFile {
  projects: { cwd: string; addedAt: number }[];
}

function adoptedFilePath(deps: ProjectOpsDeps = {}): string {
  return deps.adoptedFile ?? path.join(stateDir(), 'adopted-projects.json');
}

async function readAdopted(deps: ProjectOpsDeps = {}): Promise<AdoptedFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(adoptedFilePath(deps), 'utf8'));
    const projects = (parsed as AdoptedFile | null)?.projects;
    if (!Array.isArray(projects)) return { projects: [] };
    return {
      projects: projects.filter(
        (p): p is { cwd: string; addedAt: number } =>
          !!p && typeof p.cwd === 'string' && typeof p.addedAt === 'number',
      ),
    };
  } catch {
    // Absent or corrupt degrades to "nothing adopted": the root scan and the
    // session inventory still answer, so a lost file costs a few rows, never
    // access to anything.
    return { projects: [] };
  }
}

/** Serialises read-modify-write. Two adoptions racing read the same snapshot and
 *  the later write drops the earlier one — the same bug fs-roots.ts fixed. */
let adoptChain: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const run = adoptChain.then(work);
  adoptChain = run.catch(() => {});
  return run;
}

async function writeAdopted(file: AdoptedFile, deps: ProjectOpsDeps = {}): Promise<void> {
  const target = adoptedFilePath(deps);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(file, null, 2), 'utf8');
}

/**
 * Take an existing directory into the list.
 *
 * The caller has already proved the path is inside one of this machine's roots
 * (`assertRoot`, applied in the dispatcher beside the file methods). Here we only
 * establish that it is a directory, and that adopting it would ADD something:
 * a git repository the root scan already finds needs no entry, and writing one
 * would make `projects.forget` look broken later — it would report success while
 * the row stayed on screen, because the scan keeps producing it.
 */
export async function adoptProject(
  params: { cwd: string },
  deps: ProjectOpsDeps = {},
): Promise<ProjectAdoptResult> {
  const cwd = path.resolve(params.cwd);
  const info = await stat(cwd).catch(() => undefined);
  if (!info) throw new Error('directory not found');
  if (!info.isDirectory()) throw new Error('that path is a file, not a directory');

  const label = path.basename(cwd) || cwd;
  const scanned = await listRootProjects(deps).catch((): ProjectInfo[] => []);
  if (scanned.some((p) => path.resolve(p.cwd) === cwd)) {
    return { cwd, label, alreadyKnown: true };
  }

  return serialise(async () => {
    const file = await readAdopted(deps);
    if (file.projects.some((p) => path.resolve(p.cwd) === cwd)) {
      return { cwd, label, alreadyKnown: true };
    }
    file.projects.push({ cwd, addedAt: Date.now() });
    await writeAdopted(file, deps);
    return { cwd, label, alreadyKnown: false };
  });
}

/**
 * Drop a directory from the adopted list. The directory is never touched — see
 * the method's doc comment in `shared/rpc.ts` for why this is not a flag on
 * `projects.remove`.
 */
export async function forgetProject(
  params: { cwd: string },
  deps: ProjectOpsDeps = {},
): Promise<ProjectForgetResult> {
  const cwd = path.resolve(params.cwd);
  return serialise(async () => {
    const file = await readAdopted(deps);
    const kept = file.projects.filter((p) => path.resolve(p.cwd) !== cwd);
    if (kept.length === file.projects.length) return { ok: true, forgot: false };
    await writeAdopted({ projects: kept }, deps);
    return { ok: true, forgot: true };
  });
}

/**
 * Adopted directories that still exist, newest first.
 *
 * A directory that has since been deleted or renamed outside the platform is
 * skipped rather than reported: a row that cannot be opened is worse than no
 * row. It stays in the file — the disappearance may be a mount that is not up
 * yet, and silently pruning the list on a transient stat failure would lose work
 * nobody asked to lose.
 */
export async function listAdoptedProjects(deps: ProjectOpsDeps = {}): Promise<ProjectInfo[]> {
  const file = await readAdopted(deps);
  const out: ProjectInfo[] = [];
  for (const entry of file.projects) {
    const info = await stat(entry.cwd).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    out.push({
      cwd: entry.cwd,
      label: path.basename(entry.cwd) || entry.cwd,
      lastModified: Math.round(info.mtimeMs),
      count: 0,
      origin: 'adopted',
    });
  }
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

async function isRepo(dir: string): Promise<boolean> {
  // A worktree's `.git` is a file, a clone's is a directory — either counts.
  return stat(path.join(dir, '.git')).then(() => true, () => false);
}

async function rootProject(cwd: string, label: string): Promise<ProjectInfo> {
  const info = await stat(cwd);
  return { cwd, label, lastModified: Math.round(info.mtimeMs), count: 0, origin: 'root' };
}

/** Git repositories inside ONE root — see `listRootProjects`. */
async function scanRoot(root: string, out: Map<string, ProjectInfo>): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dir = path.join(root, d.name);
    if (await isRepo(dir)) {
      if (!out.has(dir)) out.set(dir, await rootProject(dir, d.name));
      continue;
    }
    const nested = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const n of nested) {
      if (!n.isDirectory() || n.name.startsWith('.')) continue;
      const sub = path.join(dir, n.name);
      if (await isRepo(sub) && !out.has(sub)) out.set(sub, await rootProject(sub, n.name));
    }
  }
}

/**
 * Git repositories under the machine's roots, so a project that has no session
 * yet still shows in the picker. Direct children first; a child that is not
 * itself a repo is treated as a grouping folder (`parent`) and scanned one level
 * down. Hidden directories are skipped at both levels.
 *
 * ROOTS, plural: the projects root plus whatever `CC_REMOTE_FILES_ROOTS`
 * declares. The file layer has honoured that variable for a while, and the
 * picker did not — so a box whose nineteen repositories live in `/srv` could be
 * browsed there while the platform maintained the machine had two projects,
 * both inferred from sessions. A checkout made by hand was invisible, and the
 * only cure was to start a session in it, which is precisely what the picker
 * that would not list it is for.
 */
/**
 * The directories this machine is scanned for projects, deduped, in the order
 * they are scanned.
 *
 * Reported to clients (`ProjectsResult.roots`) so "add a project from a folder
 * on this machine" can open somewhere real. Without it a browser has to infer
 * where work lives from the projects it already found, which is exactly wrong
 * for the case adoption exists to serve: a folder that is not a project yet.
 */
export function scanRoots(deps: ProjectOpsDeps = {}): string[] {
  const roots = deps.root ? [deps.root] : [projectsRoot(), ...declaredRoots()];
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

export async function listRootProjects(deps: ProjectOpsDeps = {}): Promise<ProjectInfo[]> {
  const roots = scanRoots(deps);
  const found = new Map<string, ProjectInfo>();
  // Sequential on purpose: one root is the common case, and a machine that
  // declares several has them on the same disk.
  for (const root of roots) await scanRoot(root, found);
  return [...found.values()].sort((a, b) => b.lastModified - a.lastModified);
}
