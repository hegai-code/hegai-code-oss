import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomicSync } from './atomic-write.js';
import { stateDir } from './config.js';
import { isRootish } from './fs-roots.js';

/**
 * What the OWNER OF THIS MACHINE allows the hub to do here — decided on the
 * machine, read once at start, and never taken from the wire.
 *
 * Everything else about access is hub policy (roles, shares, `can_control`),
 * and a hub that is broken into ignores its own policy. The outside review of
 * 28.09.2026 asked for switches the MACHINE enforces; this is where they live.
 * Be honest about what they are: they shrink what a hub can do through the
 * agent's own doors (a shell, file writes, git, running without prompts, which
 * sessions leave the machine). They are not a sandbox — a session the hub can
 * prompt and approve can still run commands. The only hard boundary remains the
 * unix user the agent runs as (FAQ, «Что сервер Hegai Code может сделать с моей
 * машиной?»).
 *
 * `~/.cc-remote/policy.json`:
 *
 *   { "chatOnly": true, "sync": { "projects": ["/home/me/work/site"] },
 *     "transcriptRetentionDays": 7 }
 *
 * - No file → today's behaviour: `chatOnly: false`, `sync: "all"`. The fleet
 *   that existed before this file keeps working unchanged.
 * - `CC_REMOTE_CHAT_ONLY=1|0` and `CC_REMOTE_SYNC=all` override the file.
 * - `transcriptRetentionDays` (or `CC_REMOTE_TRANSCRIPT_RETENTION_DAYS`; with
 *   both, the shorter wins): the hub keeps a session's transcript only while it
 *   has been written within the last N days. The agent stops listing and
 *   syncing older sessions, and the hub purges what it already holds
 *   (server-rs/src/hub/retention.rs). Local transcripts are left alone.
 * - Not in `agent.json`: `persistDeviceToken` rewrites that file whole.
 * - The hub cannot write it: `~/.cc-remote` is refused to `fs.write`
 *   (`fs-ops.ts`) and to Claude's Edit/Write (`protectedPathHook`).
 * - A change needs an agent restart, except `sync.projects`, which the agent
 *   itself extends when a person starts work in a new folder (`addSyncProject`).
 */
export interface AgentPolicy {
  /** No terminal, no file/git mutations, no process kill, no runtime
   *  install/login, no mode that skips approvals, every tool call asks. */
  chatOnly: boolean;
  /** Which sessions leave this machine: all of them, or only those whose cwd
   *  is one of these folders or under one. */
  sync: 'all' | { projects: string[] };
  /** How many days the hub may keep a session after it was last written.
   *  Absent = indefinitely (the old behaviour). Always a whole number >= 1. */
  transcriptRetentionDays?: number;
  /** Private machine (docs/E2EE.md): session content leaves only as ciphertext
   *  under a key that stays on this machine and the owner's paired devices.
   *  Present only as `true`. The owner's switch, never the hub's. */
  private?: true;
  /** On a private machine, also take plaintext content from the hub (an old
   *  client without the key). Default false: such a client cannot type in. */
  acceptPlaintextInput?: true;
}

/** Ten years: a cap so a typo of extra zeros is still a number the hub can use. */
const MAX_RETENTION_DAYS = 3650;

/** A declared retention, read the SAFE way: present but malformed (a string,
 *  zero, negative, NaN) is the shortest period, one day — never «for ever». */
export function parseRetentionDays(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_RETENTION_DAYS);
}

/** Is a session last written at `lastModified` (ms) still inside the period?
 *  No retention declared → always. */
export function withinRetention(lastModified: number, p: AgentPolicy = policy(), now: number = Date.now()): boolean {
  if (p.transcriptRetentionDays === undefined) return true;
  return lastModified >= now - p.transcriptRetentionDays * 86_400_000;
}

export const DEFAULT_POLICY: AgentPolicy = { chatOnly: false, sync: 'all' };

export function policyFile(): string {
  return path.join(stateDir(), 'policy.json');
}

function truthy(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
  return undefined;
}

/** Parse whatever the file says; anything malformed falls back field by field
 *  to the SAFER reading, not the default — a typo in `chatOnly` must not
 *  quietly open the terminal back up. */
export function parsePolicy(raw: unknown): AgentPolicy {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const chatOnly = obj['chatOnly'] === undefined ? false : obj['chatOnly'] !== false;
  let sync: AgentPolicy['sync'] = 'all';
  const s = obj['sync'];
  if (s !== undefined && s !== 'all') {
    const list = s && typeof s === 'object' ? (s as Record<string, unknown>)['projects'] : undefined;
    const projects = Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
    sync = { projects: [...new Set(projects.map((p) => path.resolve(p)))] };
  }
  const retention = parseRetentionDays(obj['transcriptRetentionDays']);
  // Private only for a literal `true`. Any other value ("yes", 1, "false") is
  // not read as a switch: it is reported and the machine stays as it was, so a
  // typo can neither turn a machine private (the hub would purge its history)
  // nor crash the agent, which may be the only remote hand on the machine.
  const rawPrivate = obj['private'];
  const isPrivate = rawPrivate === true;
  if (rawPrivate !== undefined && rawPrivate !== true && rawPrivate !== false) {
    console.error(
      `[agent] policy.json: "private" must be true or false, got ${JSON.stringify(rawPrivate)} - ignored, this machine is NOT private until it is fixed`,
    );
  }
  return {
    chatOnly,
    sync,
    ...(retention !== undefined ? { transcriptRetentionDays: retention } : {}),
    ...(isPrivate ? { private: true as const } : {}),
    ...(obj['acceptPlaintextInput'] === true ? { acceptPlaintextInput: true as const } : {}),
  };
}

/** `<state>/private.last`: the private setting of the last policy that parsed. */
function lastFile(file: string): string {
  return path.join(path.dirname(file), 'private.last');
}

function lastKnownPrivate(file: string): boolean {
  try {
    return readFileSync(lastFile(file), 'utf8').trim() === 'true';
  } catch {
    return false;
  }
}

function rememberPrivate(file: string, isPrivate: boolean): void {
  const want = isPrivate ? 'true' : 'false';
  try {
    if (existsSync(lastFile(file)) && readFileSync(lastFile(file), 'utf8').trim() === want) return;
    writeFileSync(lastFile(file), `${want}\n`);
  } catch {
    /* read-only state dir: the next valid load tries again */
  }
}

export function loadPolicy(env: NodeJS.ProcessEnv = process.env, file: string = policyFile()): AgentPolicy {
  let base = DEFAULT_POLICY;
  if (existsSync(file)) {
    try {
      base = parsePolicy(JSON.parse(readFileSync(file, 'utf8')));
      rememberPrivate(file, base.private === true);
    } catch (err) {
      // Unreadable is not «no policy»: the owner wrote SOMETHING. Take the
      // restrictive reading and say so, rather than silently opening up.
      console.error(`[agent] ${file} is not valid JSON (${(err as Error).message}) — running chat-only with nothing synced until it is fixed`);
      // Private only if the last VALID policy said so (`private.last`): a typo
      // must not turn an ordinary machine private - the hub would purge its
      // history - and a key left over from `private off` is not that statement.
      const wasPrivate = lastKnownPrivate(file);
      base = { chatOnly: true, sync: { projects: [] }, ...(wasPrivate ? { private: true as const } : {}) };
    }
  } else {
    rememberPrivate(file, false);
  }
  const envChat = truthy(env['CC_REMOTE_CHAT_ONLY']);
  const envSync = env['CC_REMOTE_SYNC'];
  // Either source can only SHORTEN the period: the env cannot quietly undo a
  // retention the file promises, nor the file one a unit file sets.
  const envRetention = parseRetentionDays(env['CC_REMOTE_TRANSCRIPT_RETENTION_DAYS']);
  const retention =
    envRetention === undefined
      ? base.transcriptRetentionDays
      : base.transcriptRetentionDays === undefined
        ? envRetention
        : Math.min(envRetention, base.transcriptRetentionDays);
  // The env can switch private ON, never off.
  const isPrivate = base.private === true || truthy(env['CC_REMOTE_PRIVATE']) === true;
  return {
    chatOnly: envChat ?? base.chatOnly,
    sync: envSync === 'all' ? 'all' : base.sync,
    ...(retention !== undefined ? { transcriptRetentionDays: retention } : {}),
    ...(isPrivate ? { private: true as const } : {}),
    ...(base.acceptPlaintextInput ? { acceptPlaintextInput: true as const } : {}),
  };
}

let current: AgentPolicy | undefined;

/** The policy this process runs under — read once, on first use. */
export function policy(): AgentPolicy {
  current ??= loadPolicy();
  return current;
}

/** Tests only: run the next checks under this policy (undefined → re-read). */
export function setPolicyForTests(p: AgentPolicy | undefined): void {
  current = p;
}

/** Case-insensitive file systems: Windows always, macOS by default (APFS). */
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

/** `child` is `parent` or sits underneath it; segment-aware on both
 *  separators, case-folded where the file system is. */
export function within(child: string, parent: string): boolean {
  const fold = (x: string) => (FOLD_CASE ? path.resolve(x).toLowerCase() : path.resolve(x));
  const c = fold(child);
  const p = fold(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Does a session in this folder leave the machine? A session with no cwd
 *  syncs only under `sync: "all"`. */
export function syncsCwd(cwd: string | undefined, p: AgentPolicy = policy()): boolean {
  if (p.sync === 'all') return true;
  if (!cwd) return false;
  return p.sync.projects.some((proj) => within(cwd, proj));
}

/** Refusal text the hub relays verbatim — it names the machine-side switch so
 *  the person reading it knows it is not a bug on the server. */
export function chatOnlyRefusal(what: string): string {
  return `${what} is switched off on this machine (chat-only mode, ~/.cc-remote/policy.json).`;
}

/**
 * RPC methods chat-only refuses. Reading stays: listing and reading files,
 * git status and branches, the process list — what the person can already see
 * of their own sessions. What goes is what changes the machine.
 */
const CHAT_ONLY_REFUSED = new Set<string>([
  'fs.write',
  'fs.mkdir',
  'fs.rename',
  'fs.trash',
  'fs.upload.begin',
  'fs.upload.chunk',
  'fs.upload.commit',
  'git.stage',
  'git.unstage',
  'git.commit',
  'git.checkout',
  'git.worktree.add',
  'git.worktree.remove',
  'git.push',
  'git.pr.create',
  'session.delete',
  'session.fork',
  'session.rename',
  'projects.create',
  'projects.remove',
  'projects.adopt',
  'projects.forget',
  'proc.kill',
  'runtime.install',
  'runtime.login.start',
  'runtime.login.input',
  'runtime.codex.provider',
]);

export function refusedInChatOnly(method: string, p: AgentPolicy = policy()): boolean {
  return p.chatOnly && CHAT_ONLY_REFUSED.has(method);
}

/**
 * Add a folder to `sync.projects` and persist it — the one policy change the
 * agent makes itself, because a person who starts a session in a folder from
 * their phone has just said they want to see it there. A no-op under
 * `sync: "all"` or when the folder is already covered.
 */
export function addSyncProject(dir: string, file: string = policyFile()): boolean {
  const p = policy();
  if (p.sync === 'all' || syncsCwd(dir, p)) return false;
  // Never a folder that would sync everything: `/`, a drive, a bare home, or
  // anything the home sits inside. A hub naming one in `new_session` must not
  // widen the list to the whole machine (security review 28.09.2026).
  if (tooBroadToSync(dir)) throw new Error(`${dir} is too broad to sync — pick a project folder`);
  const next: AgentPolicy = { ...p, sync: { projects: [...p.sync.projects, path.resolve(dir)] } };
  writePolicyFile(next, file);
  current = next;
  return true;
}

/** Switch between «everything leaves» and «only picked folders». Going to
 *  `selected` from `all` starts with an EMPTY list — the hub then forgets what
 *  it held, which is the point of asking for it. */
export function setSyncMode(mode: 'all' | 'selected', file: string = policyFile()): boolean {
  const p = policy();
  if (mode === 'all' ? p.sync === 'all' : p.sync !== 'all') return false;
  const next: AgentPolicy = { ...p, sync: mode === 'all' ? 'all' : { projects: [] } };
  writePolicyFile(next, file);
  current = next;
  return true;
}

/** A folder whose sessions would be most of the machine. */
export function tooBroadToSync(dir: string, home: string = os.homedir()): boolean {
  const d = path.resolve(dir);
  return isRootish(d) || within(home, d);
}

/** Remove a folder from `sync.projects`. Returns whether anything changed. */
export function removeSyncProject(dir: string, file: string = policyFile()): boolean {
  const p = policy();
  if (p.sync === 'all') return false;
  const target = path.resolve(dir);
  const projects = p.sync.projects.filter((x) => x !== target);
  if (projects.length === p.sync.projects.length) return false;
  const next: AgentPolicy = { ...p, sync: { projects } };
  writePolicyFile(next, file);
  current = next;
  return true;
}

/** Drop `dir` and every `sync.projects` entry under it — for a project the
 *  agent has just moved to the trash, so the list does not keep folders that
 *  no longer exist. Same atomic write as the other `sync` changes; a no-op
 *  under `sync: "all"`. Returns whether anything changed. */
export function removeSyncProjectsUnder(dir: string, file: string = policyFile()): boolean {
  const p = policy();
  if (p.sync === 'all') return false;
  const projects = p.sync.projects.filter((x) => !within(x, dir));
  if (projects.length === p.sync.projects.length) return false;
  const next: AgentPolicy = { ...p, sync: { projects } };
  writePolicyFile(next, file);
  current = next;
  return true;
}

/** Read the policy file as the owner wrote it, let `mutate` change what this
 *  call owns, and write it back atomically with everything else untouched. */
function updatePolicyFile(file: string, mutate: (raw: Record<string, unknown>) => void): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    // A file we cannot parse is the owner's, half-edited: rewriting it would
    // drop their `chatOnly` and open the machine up on the next restart.
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  }
  mutate(raw);
  writeFileAtomicSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600, mkdir: true });
}

/** The owner's own switch, from the command line ON the machine
 *  (`node agent.mjs policy chat-only on`). Never reachable from the wire. */
export function writeChatOnly(on: boolean, file: string = policyFile()): void {
  updatePolicyFile(file, (raw) => {
    raw['chatOnly'] = on;
  });
  current = undefined;
}

/** The owner's retention switch (`node agent.mjs policy retention 7|off`),
 *  same rules as `writeChatOnly`: on the machine only, never from the wire. */
export function writeRetentionDays(days: number | undefined, file: string = policyFile()): void {
  updatePolicyFile(file, (raw) => {
    if (days === undefined) delete raw['transcriptRetentionDays'];
    else raw['transcriptRetentionDays'] = parseRetentionDays(days);
  });
  current = undefined;
}

/** The owner's private-machine switch (`node agent.mjs policy private on|off`). */
export function writePrivate(on: boolean, file: string = policyFile()): void {
  updatePolicyFile(file, (raw) => {
    if (on) raw['private'] = true;
    else delete raw['private'];
  });
  current = undefined;
}

/** Write `sync` into the file, keeping everything else the owner put there —
 *  in particular `chatOnly`, which only the owner changes (an env override
 *  must not get baked into the file by this). */
function writePolicyFile(next: AgentPolicy, file: string): void {
  updatePolicyFile(file, (raw) => {
    raw['sync'] = next.sync;
  });
}
