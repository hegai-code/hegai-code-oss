import os from 'node:os';
import path from 'node:path';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { OsKind } from '@cc-remote/shared';

/** Per-machine agent configuration, persisted under ~/.cc-remote/agent.json. */
export interface AgentConfig {
  machineId: string;
  name: string;
  os: OsKind;
  centralUrl: string;
  token: string;
  deviceToken?: string;
  enrollmentCode?: string;
  /** No credential and no code, against a real hub: the agent asks the hub for
   *  a connection code and waits for a person to approve it on `/link`
   *  (client.ts `linkAndConnect`). Cleared once the device token is saved. */
  linkMode: boolean;
  /** Max sessions per inventory push; undefined = no cap. Set INVENTORY_LIMIT
   *  on machines behind fragile/multi-hop tunnels — a big inventory frame can
   *  reset the connection there. */
  inventoryLimit?: number;
}

function osKind(): OsKind {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

/** Base64 in, UTF-8 out — or nothing, if the value did not survive the trip. */
function decodeName(b64: string | undefined): string | undefined {
  if (!b64?.trim()) return undefined;
  const text = Buffer.from(b64.trim(), 'base64').toString('utf8');
  // `Buffer.from` never throws on junk, it just decodes junk. A replacement
  // character means the value was truncated or was not base64 at all.
  return text.includes('�') ? undefined : text;
}

/**
 * Nothing but the wreckage of a lossy encoder: every letter became `?`.
 *
 * Only a TOTAL loss counts. "Anna's PC?" keeps its question mark, because a
 * name that still says something is the operator's choice, not a bug.
 */
function isMojibake(name: string): boolean {
  return name.includes('?') && !/[\p{L}\p{N}]/u.test(name.replace(/\?/g, ''));
}

/**
 * `os.hostname()` is not safe here on Windows: it goes through the ANSI
 * `gethostname()`, which mangles a non-ASCII computer name exactly the way the
 * installer used to. The environment block is UTF-16 and survives, so
 * COMPUTERNAME is the honest source on that platform.
 */
function defaultMachineName(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    const computerName = env['COMPUTERNAME']?.trim();
    if (computerName && !isMojibake(computerName)) return computerName;
  }
  return os.hostname();
}

/**
 * The machine's display name, as it survives Windows.
 *
 * `run-agent.cmd` — the launcher `install-win.ps1` writes and the Windows tray
 * app reads back as its configuration — is a 7-bit ASCII file on purpose:
 * cmd.exe reads it in the console's OEM codepage (866 on a Russian Windows)
 * while `windows/src-tauri/src/agent/config.rs` parses it as strict UTF-8, and
 * ASCII is the only encoding those two agree on. PowerShell's ASCII encoder
 * maps every character it cannot represent to a literal `?`, so
 * `-Name "Рабочий компьютер"` reached the hub as `??????? ?????????` and every
 * session on that machine was filed under a row of question marks (found
 * 18.09.2026 on Marat's box; `MacBook Владельца` in the same fleet list is the
 * proof that the wire, the hub and the web were never the problem).
 *
 * Hence the two rules here:
 *   - the name may arrive base64'd (`MACHINE_NAME_B64`) — ASCII in the file,
 *     UTF-8 after decode, and codepage-proof in between;
 *   - a name that is ALREADY nothing but question marks is repaired instead of
 *     reported, so a box installed before the fix heals on its next agent
 *     update rather than waiting for someone to walk over to it.
 */
export function resolveMachineName(
  env: NodeJS.ProcessEnv = process.env,
  persisted?: string,
): string {
  const candidates = [decodeName(env['MACHINE_NAME_B64']), env['MACHINE_NAME'], persisted];
  for (const candidate of candidates) {
    const name = candidate?.trim();
    if (name && !isMojibake(name)) return name;
  }
  return defaultMachineName(env);
}

/**
 * Everything this agent keeps on its machine: identity (`agent.json`), the
 * trash a delete moves things to, custom session titles. One definition, so a
 * new store cannot quietly invent a second state directory.
 *
 * Resolved per call rather than frozen at import, which is also what makes it
 * redirectable in tests.
 */
export function stateDir(): string {
  return process.env['CC_REMOTE_STATE_DIR'] ?? path.join(os.homedir(), '.cc-remote');
}

/**
 * Where this daemon publishes its own process id.
 *
 * A supervisor has to answer «is an agent already running?» BEFORE starting
 * one, and the obvious answer — scan process command lines for `agent.mjs` —
 * silently fails across a session boundary: an agent started by a Windows
 * scheduled task lives in session 0 under its own S4U logon, and a supervisor
 * in the user's session is refused the command line (`Access denied`) even
 * though it is the same user. The check then reads as «no agent» and a SECOND
 * daemon starts for the same machineId — two writers to one transcript, which
 * is what the whole single-writer rule exists to prevent (20.09.2026: this is
 * how buildbox-pc ran two agents for a day).
 *
 * A pid FILE crosses that boundary: whether a pid is alive, and the name of its
 * process, are readable without any right to inspect it.
 */
export function pidFile(): string {
  return path.join(stateDir(), 'agent.pid');
}

/** Publish this process as the machine's agent. Best-effort: a supervisor that
 *  cannot read the file falls back to scanning command lines, which is what it
 *  did before this existed. */
export function writePidFile(pid = process.pid): void {
  const file = pidFile();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, String(pid), 'utf8');
  } catch (err) {
    console.error(`[agent] could not write ${file}: ${(err as Error).message}`);
  }
}

/**
 * Give the file up on the way out — but ONLY while it still names us.
 *
 * A superseded daemon and its replacement overlap: the newcomer has already
 * written its own pid by the time the old one exits. An unconditional delete
 * therefore removes the LIVE agent's claim, the supervisor finds no file, falls
 * back to a command-line scan that cannot see across a session boundary, and
 * starts a third agent — the very duplication this file exists to prevent.
 * (Observed the first time this shipped, 20.09.2026.)
 */
export function releasePidFile(pid = process.pid): void {
  const file = pidFile();
  try {
    if (readFileSync(file, 'utf8').trim() !== String(pid)) return;
    rmSync(file, { force: true });
  } catch {
    // Already gone, or never written. A stale file is survivable on its own:
    // the reader checks that the pid is alive before believing it.
  }
}

/**
 * Directories an operator names explicitly as "this is where work lives here",
 * separated the way PATH is on the platform (`CC_REMOTE_FILES_ROOTS`).
 *
 * Read by BOTH layers that have an opinion about where projects are — the file
 * RPCs' allow-list and the project listing. They used to disagree: a box whose
 * repositories live in `/srv` could be browsed there while the project picker,
 * which only ever scanned the projects root, insisted the machine had none. A
 * checkout made by hand was then invisible unless somebody happened to start a
 * session in it, which is not a thing you can do from a picker that does not
 * list it.
 */
export function declaredRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['CC_REMOTE_FILES_ROOTS']?.trim();
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

const CONFIG_DIR = stateDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'agent.json');

/**
 * `agent.json` holds the device token once the machine is enrolled, and the
 * directory beside it holds `env` (fleet token / enrollment code) and
 * `policy.json`. `writeFileSync(…, { mode })` applies the mode only when it
 * CREATES the file, and the first write (no token yet) used the umask — so an
 * enrolled machine kept its token in a world-readable 0644 file. Tighten on
 * every start and every write; best effort (Windows, a directory we do not own).
 */
function tighten(): void {
  if (process.platform === 'win32') return;
  // `env` holds the fleet token or enrollment code on Linux/macOS installs.
  for (const [target, mode] of [
    [CONFIG_DIR, 0o700],
    [CONFIG_FILE, 0o600],
    [path.join(CONFIG_DIR, 'env'), 0o600],
  ] as const) {
    try {
      if (existsSync(target)) chmodSync(target, mode);
    } catch (err) {
      console.warn(`[agent] could not restrict ${target} to ${mode.toString(8)}: ${(err as Error).message}`);
    }
  }
}

/** Load (or create) a stable machine identity, overlaying env for connection. */
export function loadConfig(): AgentConfig {
  tighten();
  let persisted: { machineId?: string; name?: string; deviceToken?: string } = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      persisted = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      /* ignore corrupt file, regenerate below */
    }
  }
  const machineId = persisted.machineId ?? randomUUID();
  const name = resolveMachineName(process.env, persisted.name);
  if (!persisted.machineId) {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_FILE, JSON.stringify({ machineId, name }, null, 2), { mode: 0o600 });
      tighten();
    } catch (err) {
      console.error('[agent] could not persist config:', err);
    }
  }
  const centralUrl = process.env['CENTRAL_URL'] ?? 'ws://127.0.0.1:4319';
  const deviceToken = process.env['CC_REMOTE_DEVICE_TOKEN'] ?? persisted.deviceToken;
  const enrollmentCode = process.env['CC_REMOTE_ENROLLMENT_CODE'];
  const token = deviceToken ?? process.env['CC_REMOTE_TOKEN'] ?? 'dev-token';
  // A missing token silently falls back to the guessable 'dev-token'. Against a
  // real (non-loopback) hub that just gets rejected — but the only symptom is
  // "agent won't connect", which is easy to misdiagnose. Warn loudly.
  const loopback = /\/\/(127\.0\.0\.1|localhost|\[?::1\]?)([:/]|$)/.test(centralUrl);
  // Nothing to log in with and a real hub ahead: that is not a misconfigured
  // agent any more, it is a machine waiting to be connected. The old warning
  // stays for a loopback dev hub, where 'dev-token' is what is expected.
  const linkMode = !deviceToken && !enrollmentCode && !process.env['CC_REMOTE_TOKEN'] && !loopback;
  if (linkMode) {
    console.log(`[agent] no credential yet — will ask ${centralUrl} for a connection code`);
  }
  return {
    machineId,
    name,
    os: osKind(),
    centralUrl,
    token,
    deviceToken,
    enrollmentCode,
    linkMode,
    inventoryLimit: Number(process.env['INVENTORY_LIMIT']) > 0 ? Number(process.env['INVENTORY_LIMIT']) : undefined,
  };
}

export function persistDeviceToken(cfg: AgentConfig, deviceToken: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ machineId: cfg.machineId, name: cfg.name, deviceToken }, null, 2), { mode: 0o600 });
  tighten();
}

declare const __CC_REMOTE_AGENT_VERSION__: string;

/** Build-time version for deployed bundles; source runs fall back to npm/env. */
export const AGENT_VERSION =
  typeof __CC_REMOTE_AGENT_VERSION__ === 'string'
    ? __CC_REMOTE_AGENT_VERSION__
    : process.env['CC_REMOTE_AGENT_VERSION'] ?? process.env['npm_package_version'] ?? 'dev';
