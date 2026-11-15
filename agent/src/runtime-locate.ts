import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams, type StdioOptions } from 'node:child_process';
import { access, constants, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from './child-env.js';
import { confinedCommand, type Confinement } from './confine.js';

/**
 * Where is `codex`? One answer for the whole agent.
 *
 * Three places used to ask separately, and each asked the same wrong way:
 * `process.env['CODEX_BIN'] || 'codex'`, i.e. a bare name resolved against the
 * agent's own PATH. That PATH is not the person's shell PATH. The macOS
 * LaunchAgent gets `$NODE_DIR:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`
 * (deploy/install-mac.sh) — so a Codex installed through nvm, through the
 * Node installer (`/usr/local/bin`), through `npm config set prefix
 * ~/.npm-global`, or through volta was simply not there. The session list
 * still filled up, because rollouts are read from disk; what failed was every
 * spawn, and it failed silently: the usage poll resolved to `null` and sent
 * nothing, a run died with «codex app-server failed: spawn codex ENOENT».
 * That is how a member's Mac came to show his Codex sessions and no Codex
 * limits, and nobody could say why from the hub (24.09.2026).
 *
 * So the lookup is one function that looks where people actually install
 * things, remembers what it found, and when it finds nothing says WHERE it
 * looked — that list is what the «Железо» card shows next to «Codex не найден».
 */

export interface ResolvedBin {
  path: string;
  /** `env` = CODEX_BIN; `path` = the agent's PATH; `well-known` = a package
   *  manager's bin dir; `app-bundle` = the copy inside ChatGPT.app. */
  source: 'env' | 'path' | 'well-known' | 'app-bundle';
}

export interface LocateFailure {
  /** Every directory tried, in order. */
  searched: string[];
  /** Set when CODEX_BIN was given but does not point at a runnable file. */
  envHint?: string;
}

export class CodexNotFound extends Error {
  constructor(
    readonly searched: string[],
    readonly envHint?: string,
  ) {
    super(
      `codex not found (searched ${searched.length ? searched.join(', ') : 'nothing'})` +
        (envHint ? `; ${envHint}` : ''),
    );
    this.name = 'CodexNotFound';
  }
}

const BIN_NAMES_UNIX = ['codex'];
const BIN_NAMES_WIN = ['codex.cmd', 'codex.exe', 'codex'];

/** The copy ChatGPT.app ships. Last resort: it is Codex, and it shares
 *  `~/.codex` with the CLI, but it is not what `npm i -g` would give and it
 *  goes away with the app. Reported as `app-bundle` so the card can say so. */
const MAC_APP_BUNDLE_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';

/**
 * Static candidate directories, most likely first. Pure, so the list per
 * platform is testable without a filesystem. Version-manager roots (nvm, fnm)
 * are expanded separately by `versionedBinDirs` because they need a readdir.
 */
export function codexCandidateDirs(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const appdata = env['APPDATA'] || path.join(home, 'AppData', 'Roaming');
    const local = env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return [
      path.join(appdata, 'npm'),
      path.join(local, 'pnpm'),
      path.join(local, 'Volta', 'bin'),
      path.join(home, 'scoop', 'shims'),
      path.join(local, 'Programs', 'nodejs'),
      path.join(env['ProgramFiles'] || 'C:\\Program Files', 'nodejs'),
    ];
  }
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
  ];
  if (env['NPM_CONFIG_PREFIX']) dirs.unshift(path.join(env['NPM_CONFIG_PREFIX'], 'bin'));
  return dirs;
}

/** Roots whose children are one Node version each, newest first. */
export function versionRoots(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return [path.join(local, 'fnm_multishells')];
  }
  const roots = [path.join(env['NVM_DIR'] || path.join(home, '.nvm'), 'versions', 'node')];
  roots.push(path.join(home, '.local', 'share', 'fnm', 'node-versions'));
  if (platform === 'darwin') roots.push(path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'));
  return roots;
}

/** `v22.11.0` > `v20.19.0` > `v18.x`. Anything unparsable sorts last. */
export function sortVersionsDesc(names: string[]): string[] {
  const key = (n: string): number[] => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(n);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
  };
  return [...names].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < 3; i += 1) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!;
    return a.localeCompare(b);
  });
}

async function versionedBinDirs(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const out: string[] = [];
  for (const root of versionRoots(platform, home, env)) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of sortVersionsDesc(names)) {
      // nvm: <root>/v22.11.0/bin ; fnm: <root>/v22.11.0/installation/bin
      out.push(path.join(root, name, 'bin'));
      out.push(path.join(root, name, 'installation', 'bin'));
    }
  }
  return out;
}

async function runnable(p: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(p, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findIn(dir: string, platform: NodeJS.Platform): Promise<string | undefined> {
  for (const name of platform === 'win32' ? BIN_NAMES_WIN : BIN_NAMES_UNIX) {
    const p = path.join(dir, name);
    if (await runnable(p, platform)) return p;
  }
  return undefined;
}

type Cache = { hit: ResolvedBin } | { miss: LocateFailure; at: number };
let cache: Cache | undefined;
/** A miss is retried on the next call at most this often — installing codex
 *  while the agent runs should be noticed within a poll, not never. */
const MISS_RETRY_MS = 30_000;

/** Forget what was found. Callers that get ENOENT from a spawn call this and
 *  try once more — the binary may have moved under us (an `npm i -g` upgrade
 *  replaces the file, a version manager switches the default). */
export function invalidateCodexBin(): void {
  cache = undefined;
  versionByPath.clear();
}

export async function resolveCodexBin(opts: {
  refresh?: boolean;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ResolvedBin | LocateFailure> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const searched: string[] = [];
  let envHint: string | undefined;

  // An explicit CODEX_BIN is never cached: it is read every time so a change
  // to the environment (a test, a sandbox env file rewritten by an update) is
  // honoured at once — one `access` call, cheaper than a stale answer.
  const fromEnv = env['CODEX_BIN'];
  if (fromEnv) {
    if (await runnable(fromEnv, platform)) return { path: fromEnv, source: 'env' };
    // Set but wrong: a sandbox env file naming a path that was upgraded away,
    // an nvm path from a version since removed. Say so and keep looking —
    // a stale hint must not turn into «codex not found» on a box that has it.
    envHint = `CODEX_BIN=${fromEnv} is not runnable`;
  }

  if (!opts.refresh && cache) {
    // A remembered hit is re-checked with one stat: `npm i -g` replaces the
    // file in place, but a version manager can retire the directory.
    if ('hit' in cache && (await runnable(cache.hit.path, platform))) return cache.hit;
    if ('miss' in cache && Date.now() - cache.at < MISS_RETRY_MS) return cache.miss;
  }

  const remember = (hit: ResolvedBin): ResolvedBin => {
    cache = { hit };
    return hit;
  };

  for (const dir of (env['PATH'] || '').split(path.delimiter).filter(Boolean)) {
    searched.push(dir);
    const p = await findIn(dir, platform);
    if (p) return remember({ path: p, source: 'path' });
  }

  const wellKnown = [...codexCandidateDirs(platform, home, env), ...(await versionedBinDirs(platform, home, env))];
  for (const dir of wellKnown) {
    if (searched.includes(dir)) continue;
    searched.push(dir);
    const p = await findIn(dir, platform);
    if (p) return remember({ path: p, source: 'well-known' });
  }

  if (platform === 'darwin') {
    searched.push(path.dirname(MAC_APP_BUNDLE_CODEX));
    if (await runnable(MAC_APP_BUNDLE_CODEX, platform)) {
      return remember({ path: MAC_APP_BUNDLE_CODEX, source: 'app-bundle' });
    }
  }

  const miss: LocateFailure = { searched, ...(envHint ? { envHint } : {}) };
  cache = { miss, at: Date.now() };
  return miss;
}

export function isResolved(r: ResolvedBin | LocateFailure): r is ResolvedBin {
  return 'path' in r;
}

/** The searched list as one short human line: the dirs that matter, not the
 *  whole PATH. Capped because it travels in a 300-char wire field. */
export function describeSearch(miss: LocateFailure, max = 220): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const d of miss.searched) {
    if (seen.has(d)) continue;
    seen.add(d);
    parts.push(d);
  }
  let line = `искал: ${parts.join(', ')}`;
  if (miss.envHint) line = `${miss.envHint}; ${line}`;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Spawn the machine's Codex. Resolves the binary first and throws
 * `CodexNotFound` — a typed error with the searched dirs — instead of letting
 * `spawn` emit a bare ENOENT for a name nobody can act on.
 *
 * Windows runs the npm shim (`codex.cmd`) through cmd.exe, which is the only
 * thing that can execute a batch file; a resolved full path may contain a
 * space (`C:\Users\Anna Ivanova\AppData\Roaming\npm\codex.cmd`) and has to be
 * quoted for that shell. Unix stays direct.
 */
export async function spawnCodex(
  args: string[],
  opts: { cwd?: string; stdio: StdioOptions; env?: NodeJS.ProcessEnv; confine?: Confinement } = { stdio: ['pipe', 'pipe', 'pipe'] },
): Promise<{ child: ChildProcessWithoutNullStreams; bin: ResolvedBin }> {
  let bin = await resolveCodexBin();
  if (!isResolved(bin)) {
    bin = await resolveCodexBin({ refresh: true });
    if (!isResolved(bin)) throw new CodexNotFound(bin.searched, bin.envHint);
  }
  const win = process.platform === 'win32';
  const command = win && /\s/.test(bin.path) ? `"${bin.path}"` : bin.path;
  // Confined run (CC_REMOTE_CONFINE_RUNS): the same codex, inside bubblewrap.
  const [file, fileArgs] = opts.confine ? confinedCommand(opts.confine, command, args) : [command, args];
  const child = spawn(file, fileArgs, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    stdio: opts.stdio,
    env: opts.env ?? childEnv(),
    windowsHide: true,
    shell: win,
  }) as ChildProcessWithoutNullStreams;
  return { child, bin };
}

/**
 * Where is `claude` — for LOGGING IN, not for sessions. Sessions run the binary
 * the Agent SDK bundles beside the agent, and that same binary answers
 * `claude auth login`, so a machine never needs a separate Claude install:
 * the person's own `claude` on PATH is tried first (it shares `~/.claude`
 * with the bundled one), then the bundled copy, then the usual dirs.
 */
export async function resolveClaudeBin(opts: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; bundled?: string | null } = {}): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = (env['PATH'] || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (await runnable(p, platform)) return p;
    }
  }
  const bundled = opts.bundled === undefined ? bundledClaudeBin(platform) : (opts.bundled ?? undefined);
  if (bundled && (await runnable(bundled, platform))) return bundled;
  const wellKnown = platform === 'win32' ? [path.join(env['APPDATA'] || path.join(home, 'AppData', 'Roaming'), 'npm')] : [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of wellKnown) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (await runnable(p, platform)) return p;
    }
  }
  return undefined;
}

/** `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude` next to the SDK. */
export function bundledClaudeBin(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
    const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
    const pkg = `@anthropic-ai/claude-agent-sdk-${os}-${arch}`;
    return path.join(path.dirname(sdkDir), path.basename(pkg), platform === 'win32' ? 'claude.exe' : 'claude');
  } catch {
    return undefined;
  }
}

const versionByPath = new Map<string, { version: string | undefined; at: number }>();
/** The nightly updater (deploy/update-runtimes.sh) replaces codex in place
 *  without touching the agent, so a per-path cache that lived forever kept
 *  reporting the old version on «Железо» until the next agent restart. */
const VERSION_TTL_MS = 15 * 60_000;

/** `codex --version` → `0.154.0`. Cached per path for VERSION_TTL_MS. */
export async function codexVersion(binPath: string, timeoutMs = 5_000): Promise<string | undefined> {
  const hit = versionByPath.get(binPath);
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.version;
  const win = process.platform === 'win32';
  const command = win && /\s/.test(binPath) ? `"${binPath}"` : binPath;
  const version = await new Promise<string | undefined>((resolve) => {
    let out = '';
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: win, env: childEnv() });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const m = /(\d+\.\d+\.\d+)/.exec(out);
      resolve(m ? m[1] : undefined);
    });
  });
  versionByPath.set(binPath, { version, at: Date.now() });
  return version;
}
