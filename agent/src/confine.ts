import { constants as fsConstants, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { type FileHandle, chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from './config.js';
import { runStateDir } from './run-state.js';

/**
 * OS-level confinement of coder runs (`CC_REMOTE_CONFINE_RUNS=<prefix>`).
 *
 * The hub decides who may open which matter; it cannot stop a Codex process
 * that already runs as the agent's unix user from reading the neighbouring
 * matter's folder or its rollout in `~/.codex/sessions`. With the env set, every
 * coder run is spawned inside bubblewrap that sees only:
 *   - the machine read-only (`--ro-bind / /`), minus the agent's own state;
 *   - ONE confinement unit below the prefix, read-write: a matter
 *     `<prefix>/delo-x`, or a person's `<prefix>/_personal/<id>`;
 *   - a private CODEX_HOME (`~/.codex-units/<key>`), so the unit's rollouts
 *     live apart from every other unit's.
 * Unset = off, nothing changes. Set = fail closed: a cwd outside the prefix, an
 * escape through a symlink, a missing bwrap all refuse the run.
 */
export class ConfineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfineError';
  }
}

/** The configured prefix (absolute, normalised), or undefined when off. */
export function confinePrefix(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env['CC_REMOTE_CONFINE_RUNS']?.trim();
  if (!raw) return undefined;
  if (!path.isAbsolute(raw)) throw new ConfineError(`CC_REMOTE_CONFINE_RUNS must be an absolute path, got "${raw}"`);
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) throw new ConfineError('CC_REMOTE_CONFINE_RUNS must not be the filesystem root');
  return resolved;
}

export interface ConfineUnit {
  /** Real path of the confinement unit directory. */
  unitDir: string;
  /** Unit path relative to the real prefix: `delo-x` or `_personal/<id>`. */
  rel: string;
  /** Real prefix. */
  prefix: string;
  /** Real cwd (inside `unitDir`). */
  cwd: string;
}

const PERSONAL = '_personal';

function unitRel(segments: string[]): string | null {
  if (segments.length === 0) return null;
  if (segments[0] === PERSONAL) return segments.length >= 2 ? `${PERSONAL}/${segments[1]}` : null;
  return segments[0]!;
}

/** Segments of `target` below `base`; [] when equal; null when outside. */
function relSegments(base: string, target: string): string[] | null {
  const rel = path.relative(base, target);
  if (rel === '') return [];
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

/**
 * Which unit a cwd belongs to. Lexical and real paths must agree on the unit:
 * `delo-a -> delo-b` or `delo-a/link -> ../delo-b` would otherwise let a person
 * with access to one matter land in another.
 */
export function resolveUnit(
  cwd: string,
  prefix: string,
  realpath: (p: string) => string = realpathSync,
): ConfineUnit {
  let realPrefix: string;
  let realCwd: string;
  try {
    realPrefix = realpath(prefix);
    realCwd = realpath(path.resolve(cwd));
  } catch (error) {
    throw new ConfineError(`cannot resolve ${cwd}: ${(error as Error).message}`);
  }
  const lexical = path.resolve(cwd);
  const lexSegs = relSegments(prefix, lexical) ?? relSegments(realPrefix, lexical);
  const realSegs = relSegments(realPrefix, realCwd);
  if (!realSegs) throw new ConfineError(`cwd ${cwd} is outside ${prefix}: runs here are confined to the matter folders`);
  const lexUnit = lexSegs ? unitRel(lexSegs) : null;
  const realUnit = unitRel(realSegs);
  if (!realUnit || !lexUnit) throw new ConfineError(`cwd ${cwd} is not inside a matter or personal folder under ${prefix}`);
  if (lexUnit !== realUnit) throw new ConfineError(`cwd ${cwd} leaves its folder through a symlink`);
  return { unitDir: path.join(realPrefix, realUnit), rel: realUnit, prefix: realPrefix, cwd: realCwd };
}

/** Directory name of a unit's private CODEX_HOME: readable slug + 128 bits of
 *  sha256 over the REAL prefix and the unit. Two units never share one by
 *  sanitising to the same text, and moving CC_REMOTE_CONFINE_RUNS to another
 *  tree gives every unit a new home instead of inheriting the old tree's. */
export function unitKey(rel: string, prefix: string | undefined = confinePrefix()): string {
  let realPrefix = '';
  if (prefix) {
    try { realPrefix = realpathSync(prefix); } catch { realPrefix = path.resolve(prefix); }
  }
  const slug = rel.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return `${slug}-${createHash('sha256').update(`${realPrefix}\0${rel}`).digest('hex').slice(0, 32)}`;
}

export function scratchRoot(home: string = os.homedir()): string {
  return path.join(home, '.codex-scratch');
}

export function unitsRoot(home: string = os.homedir()): string {
  return path.join(home, '.codex-units');
}

export function unitCodexHome(rel: string, home: string = os.homedir(), prefix: string | undefined = confinePrefix()): string {
  return path.join(unitsRoot(home), unitKey(rel, prefix));
}

/** Every unit's CODEX_HOME that exists now (for rollout discovery). */
export function listUnitCodexHomes(home: string = os.homedir()): string[] {
  try {
    return readdirSync(unitsRoot(home), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(unitsRoot(home), e.name));
  } catch {
    return [];
  }
}

/** The directories holding rollouts: the machine's own plus, when confinement
 *  is on, every unit's. */
export function codexSessionRoots(
  baseCodexHome: string,
  enabled: boolean = confinePrefix() !== undefined,
  home: string = os.homedir(),
): string[] {
  const roots = [path.join(baseCodexHome, 'sessions')];
  if (enabled) for (const h of listUnitCodexHomes(home)) roots.push(path.join(h, 'sessions'));
  return roots;
}

/** Which unit home a rollout file lives in (its directory name under
 *  `~/.codex-units`), or undefined for the machine's own `~/.codex`. */
export function unitHomeKeyOf(filePath: string, home: string = os.homedir()): string | undefined {
  return relSegments(unitsRoot(home), path.resolve(filePath))?.[0];
}

/**
 * The unit-home key a cwd belongs to, or undefined. The lexical unit and the
 * REAL unit (symlinks resolved) must agree: a cwd `delo-a/link -> ../delo-b`
 * names matter A on paper and matter B on disk, and file RPCs would follow it.
 * A cwd that no longer exists has no real path to disagree with.
 */
export function cwdUnitKey(cwd: string | undefined, prefix: string | undefined = confinePrefix()): string | undefined {
  if (!cwd || !prefix) return undefined;
  const lexical = path.resolve(cwd);
  let realPrefix = prefix;
  try { realPrefix = realpathSync(prefix); } catch { /* use as given */ }
  const lexSegs = relSegments(prefix, lexical) ?? relSegments(realPrefix, lexical);
  const lexRel = lexSegs ? unitRel(lexSegs) : null;
  if (lexRel === null) return undefined;
  try {
    const realSegs = relSegments(realPrefix, realpathSync(lexical));
    const realRel = realSegs ? unitRel(realSegs) : null;
    if (realRel !== lexRel) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }
  return unitKey(lexRel, prefix);
}

/** A rollout kept in unit home `key` may only claim a cwd inside that same unit:
 *  the sandboxed model writes these files and could name another matter's cwd. */
export function cwdBelongsToUnitHome(
  cwd: string | undefined,
  key: string,
  prefix: string | undefined = confinePrefix(),
): boolean {
  const k = cwdUnitKey(cwd, prefix);
  return k !== undefined && k === key;
}

export interface MountPlan {
  unitDir: string;
  prefix: string;
  cwd: string;
  home: string;
  codexHome: string;
  /** Agent-written scratch for images/attachments, mounted READ-ONLY (the
   *  sandbox must not be able to swap it for a symlink the agent then writes through). */
  scratch: string;
  /** Paths below $HOME kept readable (the codex binary's tree). */
  roHome: string[];
  /** Existing directories to blank out (agent state outside $HOME, env files). */
  hide: string[];
}

/** Pure: bwrap options (without the trailing `-- cmd args`).
 *
 *  Order matters, a later mount hides every earlier one beneath it:
 *    1. the blank-out of $HOME and <prefix>, then the unit and its CODEX_HOME;
 *    2. the `hide` masks (agent state, base CODEX_HOME, /etc/cc-remote) - after
 *       the binds, so no earlier parent bind can shadow a mask; a mask that
 *       would itself cover a bound path is refused instead;
 *    3. the read-only exceptions (scratch, run-state, tool dirs).
 */
export function buildBwrapArgs(plan: MountPlan): string[] {
  for (const mask of plan.hide) {
    // roHome / scratch are mounted AFTER the masks on purpose, so a mask may contain them.
    for (const kept of [plan.prefix, plan.unitDir, plan.home, plan.codexHome]) {
      if (relSegments(mask, kept) !== null) {
        throw new ConfineError(`mask ${mask} would cover ${kept}: refusing this layout`);
      }
    }
  }
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  // /run carries host Unix sockets (user D-Bus/systemd manager, docker.sock): a
  // read-only mount does not stop connect(), and a manager can start a process
  // outside the sandbox. Blank it; keep only the resolver's files so DNS works.
  args.push('--tmpfs', '/run');
  args.push('--tmpfs', plan.home);
  args.push('--tmpfs', plan.prefix);
  args.push('--bind', plan.unitDir, plan.unitDir);
  args.push('--bind', plan.codexHome, plan.codexHome);
  for (const p of plan.hide) args.push('--tmpfs', p);
  args.push('--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve');
  args.push('--ro-bind', plan.scratch, plan.scratch);
  for (const p of plan.roHome) args.push('--ro-bind', p, p);
  args.push('--chdir', plan.cwd, '--die-with-parent', '--unshare-pid', '--new-session');
  return args;
}

export interface Confinement {
  unit: ConfineUnit;
  codexHome: string;
  scratch: string;
  bwrap: string;
  plan: MountPlan;
}

/** Explicit read-only paths below $HOME (CC_REMOTE_CONFINE_RO_HOME), existing only. */
export function roHomeFor(home: string, extra: string[] = []): string[] {
  const out = new Set<string>();
  for (const p of extra) if (path.isAbsolute(p) && relSegments(home, p)?.length) out.add(path.resolve(p));
  return [...out].filter((p) => existsSync(p));
}

/** A codex binary under $HOME is invisible in the blank home. Binding "its tree"
 *  automatically would expose neighbours (~/.local/share, keyrings), so it must
 *  be named in CC_REMOTE_CONFINE_RO_HOME; otherwise the run is refused. */
function assertBinReachable(c: Confinement, cmd: string): void {
  const candidates = [cmd];
  try { candidates.push(realpathSync(cmd)); } catch { /* as given */ }
  for (const candidate of candidates) {
    if (!relSegments(c.plan.home, candidate)?.length) continue;
    const covered = c.plan.roHome.some((p) => relSegments(p, candidate) !== null);
    if (!covered) {
      throw new ConfineError(`codex (${candidate}) lives under ${c.plan.home}, which is blank in a confined run: add its directory to CC_REMOTE_CONFINE_RO_HOME`);
    }
  }
}

/** chmod through an open descriptor, never by pathname, and never through a
 *  symlink in the last component. */
async function chmodNoFollow(file: string, mode: number): Promise<void> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/**
 * Staging area for everything the agent builds before it enters a unit home.
 *
 * It lives in `unitsRoot` (a sibling of the unit homes), which NO sandbox sees:
 * a sandbox only has its own unit home bind-mounted, and `unitsRoot` itself is
 * not mounted at all. So nothing in here can be watched or swapped by a run.
 * The unit home is the one directory a run does touch; it cannot itself be
 * replaced from inside, because inside the sandbox it is a mount point (rename
 * or unlink of a mount point fails with EBUSY, and its parent is not visible).
 * Files cross into the home only by an atomic rename from the staging area.
 */
async function stagingDir(home: string): Promise<string> {
  return mkdtemp(path.join(path.dirname(home), '.stage-'));
}

/** Replace `dst` with a copy of `src`: built and chmod'ed in the staging area,
 *  then renamed over `dst` (a rename never follows a symlink at the destination). */
async function replaceFile(src: string, dst: string, staging: string): Promise<void> {
  const tmp = path.join(staging, `${randomBytes(6).toString('hex')}.tmp`);
  await copyFile(src, tmp, 1 /* COPYFILE_EXCL */);
  await chmodNoFollow(tmp, 0o600);
  await rename(tmp, dst);
}

/** Create `dir` (0700) and require that it is a real directory, not a symlink. */
async function ensureRealDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  await chmod(dir, 0o700).catch(() => {});
}

interface UnitOwner {
  prefix: string;
  rel: string;
}

/**
 * Ownership marker of a unit home: `<home>.owner`, a SIBLING of the home in
 * `unitsRoot`, so no sandbox (which sees only the home itself) can delete or
 * forge it. The key already hashes the real prefix, so a different tree gets a
 * different home; the marker is the second lock. A home whose marker names
 * someone else - or that holds files but has no marker at all (unknown
 * provenance) - is never used: it is renamed into a dot-prefixed quarantine
 * (not listed as a unit home) and a fresh one is created.
 */
async function claimUnitHome(unitHome: string, owner: UnitOwner): Promise<void> {
  const marker = `${unitHome}.owner`;
  const want = JSON.stringify({ prefix: owner.prefix, rel: owner.rel });
  const have = await readFile(marker, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (have === want) return;
  const info = await lstat(unitHome).catch(() => null);
  const populated = info !== null && (!info.isDirectory() || info.isSymbolicLink() || (await readdir(unitHome)).length > 0);
  if (info !== null && (have !== null || populated)) {
    const quarantine = path.join(path.dirname(unitHome), `.quarantine-${path.basename(unitHome)}-${Date.now()}-${randomBytes(3).toString('hex')}`);
    await rename(unitHome, quarantine);
    console.warn(`[agent] unit home ${unitHome} had a foreign or missing owner marker: moved to ${quarantine}`);
  }
  const tmp = `${marker}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, want, { mode: 0o600, flag: 'wx' });
  await rename(tmp, marker);
}

/** Two runs starting in one unit at once must not interleave the swap below. */
const seedLocks = new Map<string, Promise<unknown>>();
function seedUnitHome(unitHome: string, baseHome: string, owner: UnitOwner): Promise<void> {
  const run = (seedLocks.get(unitHome) ?? Promise.resolve()).catch(() => {}).then(() => seedUnitHomeLocked(unitHome, baseHome, owner));
  seedLocks.set(unitHome, run);
  void run.finally(() => { if (seedLocks.get(unitHome) === run) seedLocks.delete(unitHome); }).catch(() => {});
  return run;
}

/** Copy the base CODEX_HOME's config/credentials into the unit's private home. */
async function seedUnitHomeLocked(unitHome: string, baseHome: string, owner: UnitOwner): Promise<void> {
  await ensureRealDir(path.dirname(unitHome));
  await claimUnitHome(unitHome, owner);
  await ensureRealDir(unitHome);
  const staging = await stagingDir(unitHome);
  try {
    await seedInto(unitHome, baseHome, staging);
  } finally {
    // If the previous skills tree could not be put back, it is the only copy:
    // keep the staging directory instead of deleting it.
    const stranded = await lstat(path.join(staging, 'skills.old')).then(() => true, () => false);
    if (!stranded) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function seedInto(unitHome: string, baseHome: string, staging: string): Promise<void> {
  // The confined process owns everything inside: never follow what it leaves
  // behind (a symlink named sessions/, auth.json, skills/ would point the
  // agent's own writes or reads at the agent's state or another unit).
  const sessions = path.join(unitHome, 'sessions');
  const existing = await lstat(sessions).catch(() => null);
  if (existing && !existing.isDirectory()) await rm(sessions, { force: true });
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  for (const name of ['config.toml', 'AGENTS.md']) {
    if (await stat(path.join(baseHome, name)).then((x) => x.isFile(), () => false)) {
      await replaceFile(path.join(baseHome, name), path.join(unitHome, name), staging);
    } else {
      // Removed at the base (an integration switched off): the copy goes too.
      await rm(path.join(unitHome, name), { recursive: true, force: true });
    }
  }
  // Credentials: copy once, refresh when the base is newer. A ChatGPT login's
  // refresh token rotates, so on such a machine the copies drift; the gateway
  // (API key) login does not have that problem.
  const authSrc = path.join(baseHome, 'auth.json');
  const authDst = path.join(unitHome, 'auth.json');
  const [s, d] = await Promise.all([stat(authSrc).catch(() => null), lstat(authDst).catch(() => null)]);
  if (!s?.isFile()) {
    // Logged out / removed at the base: the copy must not outlive it.
    await rm(authDst, { recursive: true, force: true });
  } else {
    // Always refreshed from the base: the copy's own mtime is sandbox-controlled
    // and so cannot decide whether it is current.
    if (d && !d.isFile()) await rm(authDst, { recursive: true, force: true });
    await replaceFile(authSrc, authDst, staging);
  }
  const skills = path.join(baseHome, 'skills');
  if (!(await stat(skills).then((x) => x.isDirectory(), () => false))) {
    await rm(path.join(unitHome, 'skills'), { recursive: true, force: true });
  } else {
    // Build the copy in the staging area (not in the unit home, where a run
    // could swap the directory for a symlink mid-copy), then swap it in by
    // rename; the previous tree is renamed out to staging, never deleted in place.
    const dst = path.join(unitHome, 'skills');
    const fresh = path.join(staging, 'skills.new');
    const old = path.join(staging, 'skills.old');
    await cp(skills, fresh, { recursive: true, errorOnExist: true, force: false });
    const hadOld = await lstat(dst).then(() => true, () => false);
    if (hadOld) await rename(dst, old);
    try {
      await rename(fresh, dst);
      if (hadOld) await rm(old, { recursive: true, force: true }).catch(() => {}); // installed: the previous tree is obsolete
    } catch (error) {
      // Never leave the canonical path absent: put the old one back.
      if (hadOld) {
        // A live run may have re-created skills/ meanwhile: move that aside first.
        await rename(dst, path.join(staging, 'skills.live')).catch(() => {});
        await rename(old, dst);
      }
      throw error;
    }
  }
}

/** Only THIS run's state dir goes into the sandbox, read-only: the agent
 *  replaces the file by rename inside it, which a single-file bind would never see. */
function runStateBinds(runStateFile: string | undefined): string[] {
  if (!runStateFile) return [];
  const dir = path.resolve(path.dirname(runStateFile));
  return relSegments(path.resolve(runStateDir()), dir)?.length && existsSync(dir) ? [dir] : [];
}

/** Per-unit scratch dir for images/attachments of a confined run: outside the
 *  unit's writable CODEX_HOME, mounted read-only in the sandbox. */
export function unitScratchDir(cwd: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | undefined {
  const prefix = confinePrefix(env);
  if (!prefix) return undefined;
  try {
    const dir = path.join(scratchRoot(home), unitKey(resolveUnit(cwd, prefix).rel, prefix));
    // Validated BEFORE the first attachment is written: a planted symlink must
    // not redirect the agent's write into another matter.
    for (const d of [scratchRoot(home), dir]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      const info = lstatSync(d);
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    }
    return dir;
  } catch {
    return undefined; // the run itself is refused by prepareConfinement
  }
}

export interface PrepareOptions {
  /** HEGAI_RUN_STATE_FILE of this run (created before the spawn). */
  runStateFile?: string;
  prefix?: string;
  home?: string;
  baseCodexHome?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Everything a confined spawn needs, or a ConfineError. Off (no env) = undefined.
 * Creates the unit's private CODEX_HOME. Resume lands in the same unit because
 * the unit is a function of the cwd alone.
 */
export async function prepareConfinement(cwd: string, opts: PrepareOptions = {}): Promise<Confinement | undefined> {
  const env = opts.env ?? process.env;
  const prefix = opts.prefix ?? confinePrefix(env);
  if (!prefix) return undefined;
  const unit = resolveUnit(cwd, prefix);
  const home = opts.home ?? os.homedir();
  const baseHome = opts.baseCodexHome ?? env['CODEX_HOME'] ?? path.join(home, '.codex');
  const codexHome = unitCodexHome(unit.rel, home, unit.prefix);
  const scratch = path.join(scratchRoot(home), unitKey(unit.rel, unit.prefix));
  let state = path.resolve(stateDir());
  // Everything below uses the REAL path: a symlinked state dir hides nothing at its target.
  try { state = realpathSync(state); } catch { /* not created yet: lexical */ }
  // The agent's own state and credentials must never sit where a unit is
  // writable or listable: the prefix is the one tree runs get into. Refuse the
  // configuration (the run does not start) instead of trying to mask inside it.
  for (const [what, where] of [['agent state dir', state], ['base CODEX_HOME', baseHome], ['HOME', home]] as const) {
    let real = path.resolve(where);
    try { real = realpathSync(real); } catch { /* not created yet: lexical */ }
    if (relSegments(unit.prefix, real) !== null || relSegments(real, unit.prefix) !== null && what !== 'HOME') {
      throw new ConfineError(`${what} (${real}) overlaps CC_REMOTE_CONFINE_RUNS (${unit.prefix}): refusing to start confined runs`);
    }
  }
  try {
    await seedUnitHome(codexHome, baseHome, { prefix: unit.prefix, rel: unit.rel });
    await ensureRealDir(scratchRoot(home));
    await ensureRealDir(scratch);
  } catch (error) {
    throw new ConfineError(`cannot prepare ${codexHome}: ${(error as Error).message}`);
  }
  const extraRo = (env['CC_REMOTE_CONFINE_RO_HOME'] ?? '').split(':').filter(Boolean);
  const hide: string[] = [];
  // State inside $HOME is blanked with the home; elsewhere it needs its own mask.
  if (!relSegments(home, state)) hide.push(state);
  hide.push('/etc/cc-remote');
  // A CODEX_HOME outside $HOME (CODEX_HOME=/var/lib/codex) would stay readable
  // through the read-only root: auth and pre-confinement transcripts included.
  try {
    const realBase = realpathSync(baseHome);
    if (realBase !== path.parse(realBase).root && !relSegments(home, realBase)) hide.push(realBase);
  } catch { /* no base home: nothing to hide */ }
  // CC_REMOTE_CONFINE_RO_HOME is mounted after the masks and over the blank home, so
  // an entry overlapping a secret (agent state, the base CODEX_HOME with auth and old
  // transcripts, other units' homes or scratch) would re-expose it. Refuse, not skip:
  // a silently dropped entry hides a misconfiguration.
  // The prefix too: below HOME, an entry naming it (or a sibling matter) would be
  // mounted after the blank prefix and show other matters. Canonical forms as well,
  // so an alias through a symlinked HOME cannot slip past the lexical comparison.
  const secrets = [...hide, state, baseHome, unit.prefix, unitsRoot(home), scratchRoot(home)];
  for (const p of [...secrets]) {
    try { secrets.push(realpathSync(p)); } catch { /* absent */ }
  }
  // One snapshot: validated and mounted are the same list (a path created between
  // two existence checks must not reach the mount unvalidated).
  const roHome = roHomeFor(home, extraRo);
  for (const ro of roHome) {
    let real = ro;
    try { real = realpathSync(ro); } catch { /* as given */ }
    for (const secret of secrets) {
      for (const candidate of [ro, real]) {
        if (relSegments(secret, candidate) !== null || relSegments(candidate, secret) !== null) {
          throw new ConfineError(`CC_REMOTE_CONFINE_RO_HOME entry ${ro} overlaps ${secret}: refusing to re-expose it`);
        }
      }
    }
  }
  const plan: MountPlan = {
    unitDir: unit.unitDir,
    prefix: unit.prefix,
    cwd: unit.cwd,
    home,
    codexHome,
    scratch,
    roHome: [...roHome, ...runStateBinds(opts.runStateFile)],
    hide: hide.filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } }),
  };
  return { unit, codexHome, scratch, bwrap: env['CC_REMOTE_BWRAP']?.trim() || 'bwrap', plan };
}

/** `[command, args]` that runs `cmd args` inside the confinement. */
export function confinedCommand(c: Confinement, cmd: string, args: string[]): [string, string[]] {
  assertBinReachable(c, cmd);
  return [c.bwrap, [...buildBwrapArgs(c.plan), '--', cmd, ...args]];
}

/** A resumed rollout must live in THIS unit's home; anything else is another
 *  unit's (or the machine's pre-confinement) transcript and is not mounted. */
export function assertRolloutInUnit(rolloutPath: string | null, codexHome: string): void {
  if (!rolloutPath) return;
  if (!relSegments(codexHome, path.resolve(rolloutPath))?.length) {
    throw new ConfineError('эта сессия записана вне папки своего дела (до включения изоляции) — продолжить её здесь нельзя, начните новую');
  }
}

/** The key of a rollout's unit home when confinement is on and the file lives
 *  below `~/.codex-units`; undefined = not subject to the checks below. */
function confinedRolloutKey(abs: string): string | undefined {
  if (confinePrefix() === undefined) return undefined;
  const segs = relSegments(unitsRoot(), abs);
  return segs && segs.length > 1 ? segs[0] : undefined;
}

/**
 * Open a Codex rollout for reading. With confinement OFF this is exactly
 * `open(path, 'r')`. With it ON, a rollout under a unit home is written by a
 * sandboxed model, so the pathname cannot be trusted between discovery and
 * read: open it O_NOFOLLOW (no symlink as the file) and then check where the
 * OPENED descriptor really is (no symlinked directory component either) - it
 * must lie inside that unit's own `sessions` dir. Read through the handle only.
 */
export async function openRollout(filePath: string): Promise<FileHandle> {
  const abs = path.resolve(filePath);
  const key = confinedRolloutKey(abs);
  if (key === undefined) return open(filePath, 'r');
  const handle = await open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    // ELOOP = the last component is a symlink; ENOENT stays an ordinary "gone".
    throw error.code === 'ELOOP' ? new ConfineError(`rollout ${abs} is a symlink`) : error;
  });
  try {
    const expected = path.join(realpathSync(unitsRoot()), key, 'sessions');
    if (process.platform === 'linux') {
      const real = readlinkSync(`/proc/self/fd/${handle.fd}`);
      if (!relSegments(expected, real)?.length) throw new ConfineError(`rollout ${abs} resolves outside ${expected}`);
    } else {
      const [opened, link] = await Promise.all([handle.stat(), lstat(abs)]);
      const real = realpathSync(abs);
      if (link.isSymbolicLink() || opened.ino !== link.ino || opened.dev !== link.dev || !relSegments(expected, real)?.length) {
        throw new ConfineError(`rollout ${abs} changed under us`);
      }
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error instanceof ConfineError ? error : new ConfineError(`rollout ${abs} refused: ${(error as Error).message}`);
  }
}

/** Throws when `filePath` is a rollout that would not pass `openRollout` (delete
 *  target check). No-op with confinement off. */
export async function assertRolloutPath(filePath: string): Promise<void> {
  if (confinedRolloutKey(path.resolve(filePath)) === undefined) return;
  await (await openRollout(filePath)).close();
}

/** Which home's copy of a session id to trust. Pure. A legacy '' copy (the
 *  pre-confinement ~/.codex, never writable by a sandbox) wins; otherwise
 *  exactly one unit home must remain, else null (ambiguous). */
export function pickHome(homeKeys: Iterable<string>): string | null {
  const set = new Set(homeKeys);
  if (set.size === 1) return [...set][0]!;
  if (set.has('')) return '';
  return null;
}

/**
 * Which paths below `~/.codex-units` the inventory watcher may enter: only
 * `<unit>/sessions/...` (to YYYY/MM/DD depth). The unit homes are written by
 * sandboxed models, so the skills tree, scratch, staging and quarantine dirs -
 * and any symlink pointing at a big host tree - must never be traversed.
 * Used as chokidar's `ignored`; pairs with `followSymlinks: false`.
 */
export function unitsWatchIgnored(home: string = os.homedir()): (target: string) => boolean {
  const root = unitsRoot(home);
  return (target: string) => {
    const segs = relSegments(root, path.resolve(target));
    if (segs === null) return false; // not ours: the other watched roots keep chokidar's defaults
    if (segs.length === 0) return false; // the root itself
    if (segs[0]!.startsWith('.') || segs[0]!.endsWith('.owner')) return true; // staging, quarantine, markers
    if (segs.length === 1) return false; // a unit home
    if (segs[1] !== 'sessions') return true;
    return segs.length > 2 + 3 + 1; // sessions/YYYY/MM/DD/<file>
  };
}
