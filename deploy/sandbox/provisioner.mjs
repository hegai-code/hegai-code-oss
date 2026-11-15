#!/usr/bin/env node
/**
 * Hegai Code sandbox provisioner — one file, Node 20 ESM, no npm dependencies.
 *
 * A sandbox is a unix user `sb-<slug>` on the sandbox host with its own agent
 * (`cc-remote-sandbox@sb-<slug>`), its own `~/.codex/config.toml` pointed at
 * the HegAI gateway, and cgroup limits from `sandboxes.slice`. This program
 * creates, suspends, resumes, deletes and re-keys those users. It runs as root.
 *
 * Two modes:
 *   provisioner.mjs local <job.json>   run ONE job from a file, print the result
 *   provisioner.mjs daemon             long-poll the hub for jobs, one at a time
 *
 * The daemon dials OUT only (like every agent): it claims a job, heartbeats
 * while working, posts the result. Nothing listens on the host.
 *
 * Every step of `sandbox_create` is an "ensure": a re-run on an existing user
 * repairs what is missing and changes nothing that is already right. In
 * particular an existing `~/.cc-remote/agent.json` is never rewritten — it
 * holds the device credential the hub trusts.
 *
 * Secrets (the enrollment code, the gateway key) never reach stdout or the
 * journal: log lines carry step names only. Every file inside a sandbox home
 * is read and written AS THAT USER (`runuser -u`), so a symlink planted by the
 * sandbox can only ever point root at the sandbox's own files.
 *
 * Config comes from the environment (see provisioner.env.example).
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCb);

export const PROVISIONER_VERSION = '1';
export const UNIX_USER_RE = /^sb-[a-z0-9-]{2,24}$/;
export const JOB_KINDS = ['sandbox_create', 'sandbox_suspend', 'sandbox_resume', 'sandbox_delete', 'sandbox_rotate_key'];

/** Managed-block delimiters. Must stay byte-compatible with
 *  server-rs/assets/codex-gateway.sh — that installer and this provisioner
 *  edit the same file with the same rule. */
export const TOML_BLOCK_START = '# >>> hegai-gateway (managed by installer - do not edit inside) >>>';
export const TOML_BLOCK_END = '# <<< hegai-gateway <<<';
export const PROFILE_BLOCK_START = '# >>> hegai-sandbox (managed by the provisioner - do not edit inside) >>>';
export const PROFILE_BLOCK_END = '# <<< hegai-sandbox <<<';

const ENROLL_WAIT_MS = 120_000;
const ENROLL_POLL_MS = 2_000;
const IDLE_SLEEP_MS = 20_000;
const HEARTBEAT_MS = 30_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const IDLE_LOG_EVERY = 30; // one "idle" line per ~10 min so the monitor can age the journal

// ------------------------------------------------------------------ config

export function loadConfig(env = process.env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
  return {
    hubUrl: (env.CC_REMOTE_HUB_URL || 'https://code.acme.test').replace(/\/+$/, ''),
    token: env.CC_REMOTE_PROVISIONER_TOKEN || '',
    host: env.SANDBOX_HOST || os.hostname(),
    agentDir: env.SANDBOX_AGENT_DIR || '/opt/cc-remote-agent/current',
    node: env.SANDBOX_NODE || '/usr/bin/node',
    codexBin: env.SANDBOX_CODEX_BIN || '/usr/bin/codex',
    uidMin: num(env.SANDBOX_UID_MIN, 20000),
    uidMax: num(env.SANDBOX_UID_MAX, 29999),
    group: env.SANDBOX_GROUP || 'sandbox',
    projectsDir: env.SANDBOX_PROJECTS_DIR || 'work',
    homeRoot: '/home',
    // The unit's EnvironmentFile. It lives OUTSIDE the sandbox's home on
    // purpose: systemd reads EnvironmentFile as root, before dropping to the
    // sandbox uid, so a file the sandbox owns (and can replace with a symlink)
    // would let it make PID1 read any root-only file into its own environment.
    envDir: env.SANDBOX_ENV_DIR || '/etc/cc-remote/sandboxes',
    unitPrefix: 'cc-remote-sandbox@',
    backupDir: '/var/backups/sandboxes',
    defaultModel: env.SANDBOX_DEFAULT_MODEL || 'gpt-5.6-sol',
    // Written to config.toml when a job's gateway names no baseUrl. No built-in
    // host: the hub always sends one with a key; this is only the operator's
    // own fallback. Empty + a key without baseUrl = the job fails.
    gatewayUrl: (env.SANDBOX_GATEWAY_URL || '').replace(/\/+$/, ''),
    // Preview pool: the hub reverse-tunnels these loopback ports from this box
    // (preview-tunnel.service) and serves each one under its own name. The pool
    // is small on purpose — ports 3100-3106 belong to the employee projects,
    // and this box holds 3-5 sandboxes anyway.
    previewPortBase: num(env.SANDBOX_PREVIEW_PORT_BASE, 3110),
    previewSlots: num(env.SANDBOX_PREVIEW_SLOTS, 3),
    previewHost: env.SANDBOX_PREVIEW_HOST || 'preview-sb{n}.acme.test',
  };
}

/**
 * Which preview slot a sandbox owns, derived from its uid so it is stable
 * without any shared bookkeeping. Past the pool there is simply no preview —
 * the sandbox works, its dev server just isn't reachable from outside.
 */
export function previewFor(cfg, uid) {
  const slot = uid - cfg.uidMin;
  if (!Number.isFinite(slot) || slot < 0 || slot >= cfg.previewSlots) return null;
  return {
    port: cfg.previewPortBase + slot,
    url: `https://${cfg.previewHost.replace('{n}', String(slot + 1))}`,
  };
}

// ------------------------------------------------------- pure text helpers

function splitLines(text) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function joinLines(lines) {
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** A TOML basic string: only backslash and double quote need escaping for the
 *  values we ever write (URLs, keys, model ids, absolute paths). */
export function tomlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function validateUnixUser(unixUser) {
  if (typeof unixUser !== 'string' || !UNIX_USER_RE.test(unixUser)) {
    throw new StepError('validate', `unixUser ${JSON.stringify(unixUser)} must match ${UNIX_USER_RE}`, false);
  }
  return unixUser;
}

/**
 * Merge the HegAI gateway provider into an existing `~/.codex/config.toml`.
 * This is the awk rule of server-rs/assets/codex-gateway.sh:34-59, line for
 * line: root-level `model` / `model_provider` are replaced and put first, a
 * previous managed block is dropped, a hand-written `[model_providers.hegai]`
 * table anywhere outside the block is stripped up to the next table header,
 * everything else (including `[projects."…"]` tables Codex adds later) is kept
 * verbatim, and the managed block goes LAST.
 *
 * One deliberate difference from the awk: trailing blank lines of the kept
 * body are trimmed before the block is appended. The shell version grows one
 * blank line per run; the provisioner re-runs on every retry and rotate, so
 * the merge has to be a fixed point — merge(merge(x)) === merge(x).
 */
export function mergeCodexToml(existing, { model, baseUrl, apiKey }) {
  let skipBlock = false;
  let skipTable = false;
  let seenTable = false;
  const body = [];
  for (const line of splitLines(existing)) {
    if (/^\s*#\s*>>>\s*hegai-gateway/.test(line)) { skipBlock = true; continue; }
    if (/^\s*#\s*<<<\s*hegai-gateway/.test(line)) { skipBlock = false; continue; }
    if (skipBlock) continue;
    if (/^\s*\[model_providers\.hegai\]\s*$/.test(line)) { skipTable = true; continue; }
    if (skipTable) {
      if (/^\s*\[/.test(line)) skipTable = false;
      else continue;
    }
    if (/^\s*\[/.test(line)) seenTable = true;
    if (!seenTable && /^\s*model\s*=/.test(line)) continue;
    if (!seenTable && /^\s*model_provider\s*=/.test(line)) continue;
    body.push(line);
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const head = [`model = ${tomlString(model)}`, 'model_provider = "hegai"'];
  const block = [
    TOML_BLOCK_START,
    '[model_providers.hegai]',
    'name = "HegAI Gateway"',
    `base_url = ${tomlString(baseUrl)}`,
    `experimental_bearer_token = ${tomlString(apiKey)}`,
    'wire_api = "responses"',
    TOML_BLOCK_END,
  ];
  return joinLines([...head, ...body, '', ...block]);
}

/**
 * Ensure `[projects."<dir>"] trust_level = "trusted"` exists. Added once; a
 * present header (whatever its body says) is left alone — the user may have
 * changed the trust level on purpose. Inserted before the managed block when
 * there is one, so the gateway table stays last.
 */
export function ensureProjectTrust(text, dir) {
  const header = `[projects.${tomlString(dir)}]`;
  const lines = splitLines(text);
  if (lines.some((l) => l.trim() === header)) return text;
  const table = [header, 'trust_level = "trusted"'];
  const at = lines.findIndex((l) => /^\s*#\s*>>>\s*hegai-gateway/.test(l));
  if (at === -1) {
    const trimmed = [...lines];
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
    return joinLines(trimmed.length ? [...trimmed, '', ...table] : table);
  }
  const before = lines.slice(0, at);
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  return joinLines([...before, ...(before.length ? [''] : []), ...table, '', ...lines.slice(at)]);
}

function envLineRe(key) {
  return new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
}

/** Replace every `KEY=` line with one `KEY=value`, or append it. */
export function upsertEnvLine(text, key, value) {
  if (/[\r\n]/.test(String(value))) throw new Error(`env value for ${key} must be a single line`);
  const re = envLineRe(key);
  const out = [];
  let done = false;
  for (const line of splitLines(text)) {
    if (re.test(line)) {
      if (!done) { out.push(`${key}=${value}`); done = true; }
      continue;
    }
    out.push(line);
  }
  if (!done) out.push(`${key}=${value}`);
  return joinLines(out);
}

/** Drop every `KEY=` line; everything else stays byte-identical. */
export function stripEnvLine(text, key) {
  const re = envLineRe(key);
  return joinLines(splitLines(text).filter((line) => !re.test(line)));
}

export function readEnvValue(text, key) {
  const re = envLineRe(key);
  for (const line of splitLines(text)) {
    if (re.test(line)) return line.slice(line.indexOf('=') + 1);
  }
  return undefined;
}

/** Replace or append a delimited managed block (used for ~/.profile). */
export function upsertManagedBlock(text, start, end, bodyLines) {
  const lines = splitLines(text);
  const from = lines.indexOf(start);
  const to = from === -1 ? -1 : lines.indexOf(end, from + 1);
  const block = [start, ...bodyLines, end];
  if (from !== -1 && to !== -1) {
    return joinLines([...lines.slice(0, from), ...block, ...lines.slice(to + 1)]);
  }
  const kept = from === -1 ? lines : lines.slice(0, from); // an unterminated block: drop its tail
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  return joinLines(kept.length ? [...kept, '', ...block] : block);
}

/** `useradd -c` refuses ':' and newlines; ',' separates GECOS fields. */
export function gecosFor(user) {
  const raw = [user?.fullName, user?.email].filter(Boolean).join(' ');
  return raw.replace(/[:,\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function gitNameFor(user) {
  const full = (user?.fullName || '').trim();
  if (full) return full;
  const local = String(user?.email || '').split('@')[0];
  return local || 'Hegai Code user';
}

export function toWsUrl(url) {
  return String(url).replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/+$/, '');
}

export function backupName(unixUser, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `${unixUser}-${stamp}.tgz`;
}

// ------------------------------------------------------------- job runtime

export class StepError extends Error {
  constructor(stage, message, retryable = true) {
    super(message);
    this.stage = stage;
    this.retryable = retryable;
  }
}

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

async function run(cmd, args, { input, env, timeoutMs = 120_000, ok = [0] } = {}) {
  try {
    // `input` is a spawnSync/execFileSync option — the ASYNC execFile ignores it,
    // which left every stdin-reading child (writeAsUser) waiting on a stream
    // nobody wrote to until the timeout killed it. Feed the child ourselves:
    // the promisified execFile exposes the ChildProcess as `.child`.
    const pending = execFile(cmd, args, {
      env: { PATH: SAFE_PATH, LANG: 'C.UTF-8', ...env },
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (input !== undefined) {
      pending.child.stdin.on('error', () => {}); // the child may exit before we finish writing
      pending.child.stdin.end(input);
    }
    const { stdout, stderr } = await pending;
    return { code: 0, stdout, stderr };
  } catch (err) {
    const code = typeof err.code === 'number' ? err.code : -1;
    if (ok.includes(code)) return { code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-3).join(' | ');
    const e = new Error(`${cmd} ${args.join(' ')} failed (${err.code ?? err.signal}): ${detail}`);
    e.exitCode = code;
    throw e;
  }
}

function log(job, step, status, msg = '') {
  const who = job?.sandbox?.unixUser ? ` user=${job.sandbox.unixUser}` : '';
  console.log(`${new Date().toISOString()} job=${job?.jobId ?? '-'}${who} step=${step} ${status}${msg ? ' ' + msg : ''}`);
}

async function step(job, name, fn, { retryable = true } = {}) {
  try {
    const out = await fn();
    log(job, name, 'ok', typeof out === 'string' ? out : '');
    return out;
  } catch (err) {
    if (err instanceof StepError) { log(job, err.stage, 'err', err.message); throw err; }
    log(job, name, 'err', err.message);
    throw new StepError(name, err.message, retryable);
  }
}

// --------------------------------------------------- per-user file helpers

/**
 * Where the unit's EnvironmentFile lives for this sandbox (root:root 0600).
 * `unixUser` is validated as `sb-<slug>` before any job gets here, so it is
 * safe as a file name.
 */
export function envFileOf(cfg, unixUser) {
  if (!UNIX_USER_RE.test(unixUser)) throw new Error(`refusing env path for ${unixUser}`);
  return path.posix.join(cfg.envDir, `${unixUser}.env`);
}

/** Read a root-owned file. `null` when it does not exist. */
async function readRootFile(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Atomic root write (dir 0700, file 0600, never through a symlink). */
async function writeRootFile(file, content) {
  const dir = path.posix.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

/** Read a file as the sandbox user. `null` when it does not exist. */
async function readAsUser(unixUser, file) {
  const r = await run('runuser', ['-u', unixUser, '--', 'cat', '--', file], { ok: [0, 1] });
  if (r.code === 0) return r.stdout;
  if (/No such file|Not a directory/.test(r.stderr)) return null;
  throw new Error(`read ${file} as ${unixUser}: ${r.stderr.trim()}`);
}

/** Atomic write as the sandbox user: exclusive tmp + rename, mode applied. */
async function writeAsUser(cfg, unixUser, file, content, mode) {
  const script =
    "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);" +
    "process.stdin.on('end',()=>{const fs=require('fs');const {file,content,mode}=JSON.parse(d);" +
    "const tmp=file+'.tmp-'+process.pid;fs.writeFileSync(tmp,content,{mode,flag:'wx'});" +
    'fs.chmodSync(tmp,mode);fs.renameSync(tmp,file);});';
  await run('runuser', ['-u', unixUser, '--', cfg.node, '-e', script], {
    input: JSON.stringify({ file, content, mode }),
    env: { HOME: homeOf(cfg, unixUser) },
  });
}

async function mkdirAsUser(unixUser, dir, mode = '700') {
  await run('runuser', ['-u', unixUser, '--', 'mkdir', '-p', '-m', mode, '--', dir]);
  await run('runuser', ['-u', unixUser, '--', 'chmod', mode, '--', dir]);
}

function homeOf(cfg, unixUser) {
  return path.posix.join(cfg.homeRoot, unixUser);
}

function unitOf(cfg, unixUser) {
  return `${cfg.unitPrefix}${unixUser}.service`;
}

async function passwdEntry(unixUser) {
  const r = await run('getent', ['passwd', unixUser], { ok: [0, 2] });
  if (r.code !== 0) return null;
  const [name, , uid, gid, gecos, home, shell] = r.stdout.trim().split(':');
  return { name, uid: Number(uid), gid: Number(gid), gecos, home, shell };
}

async function readAgentJson(cfg, unixUser) {
  const text = await readAsUser(unixUser, path.posix.join(homeOf(cfg, unixUser), '.cc-remote', 'agent.json'));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function agentVersion(cfg) {
  for (const candidate of ['VERSION']) {
    try {
      const v = (await fs.readFile(path.join(cfg.agentDir, candidate), 'utf8')).trim();
      if (v) return v;
    } catch { /* fall through */ }
  }
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cfg.agentDir, 'package.json'), 'utf8'));
    if (pkg.version) return String(pkg.version);
  } catch { /* fall through */ }
  return 'unknown';
}

async function journalTail(cfg, unixUser, lines = 40) {
  try {
    const r = await run('journalctl', ['-u', unitOf(cfg, unixUser), '-n', String(lines), '--no-pager', '-o', 'cat'], { ok: [0, 1] });
    return r.stdout.trimEnd();
  } catch (err) {
    return `journalctl unavailable: ${err.message}`;
  }
}

function redact(text, secrets) {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  return out;
}

async function unitState(cfg, unixUser) {
  const r = await run('systemctl', ['show', unitOf(cfg, unixUser), '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'NRestarts'], { ok: [0, 1, 4] });
  const props = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map((l) => l.split('=')));
  return { active: props.ActiveState === 'active', enabled: props.UnitFileState === 'enabled', restarts: Number(props.NRestarts || 0) };
}

// ----------------------------------------------------------------- results

function okResult(extra) {
  return { ok: true, ...extra };
}

async function baseReport(cfg, unixUser) {
  const pw = await passwdEntry(unixUser);
  const agent = pw ? await readAgentJson(cfg, unixUser) : null;
  return {
    machineId: agent?.machineId ?? undefined,
    machineName: agent?.name ?? undefined,
    unixUser,
    uid: pw?.uid ?? undefined,
    agentVersion: await agentVersion(cfg),
  };
}

// ---------------------------------------------------------------- creation

async function ensureUser(cfg, job, unixUser) {
  let pw = await passwdEntry(unixUser);
  if (!pw) {
    await run('useradd', [
      '-m', '-d', homeOf(cfg, unixUser), '-s', '/bin/bash', '-g', cfg.group,
      '-K', `UID_MIN=${cfg.uidMin}`, '-K', `UID_MAX=${cfg.uidMax}`,
      '-c', gecosFor(job.user) || unixUser,
      unixUser,
    ]);
    pw = await passwdEntry(unixUser);
    if (!pw) throw new Error('useradd reported success but getent finds nothing');
  }
  if (pw.uid < cfg.uidMin || pw.uid > cfg.uidMax) {
    throw new StepError('useradd', `${unixUser} has uid ${pw.uid} outside ${cfg.uidMin}-${cfg.uidMax} — not a sandbox user, refusing to manage it`, false);
  }
  const grp = await run('getent', ['group', cfg.group], { ok: [0, 2] });
  const gid = grp.code === 0 ? Number(grp.stdout.split(':')[2]) : NaN;
  if (Number.isFinite(gid) && pw.gid !== gid) {
    throw new StepError('useradd', `${unixUser} primary group is gid ${pw.gid}, expected ${cfg.group} (${gid})`, false);
  }
  await run('chmod', ['700', homeOf(cfg, unixUser)]);
  return `uid=${pw.uid}`;
}

async function ensureDirs(cfg, unixUser) {
  const home = homeOf(cfg, unixUser);
  for (const d of ['.cc-remote', '.codex', '.claude', cfg.projectsDir]) {
    await mkdirAsUser(unixUser, path.posix.join(home, d), '700');
  }
}

async function ensureEnv(cfg, job, unixUser, { enrolled, preview }) {
  const home = homeOf(cfg, unixUser);
  const file = envFileOf(cfg, unixUser);
  // Sandboxes provisioned before 08.10.2026 kept this file at
  // ~/.cc-remote/env, owned by the sandbox. Seed from it once (read AS the
  // sandbox, so a symlink there resolves with the sandbox's rights, not ours),
  // then delete it so nothing keeps pointing at a file the sandbox controls.
  const legacy = path.posix.join(home, '.cc-remote', 'env');
  const current = await readRootFile(file);
  const before = current ?? (await readAsUser(unixUser, legacy)) ?? '';
  let text = before;
  text = upsertEnvLine(text, 'CENTRAL_URL', toWsUrl(job.hub?.centralUrl || cfg.hubUrl));
  text = upsertEnvLine(text, 'MACHINE_NAME', job.sandbox.machineName || unixUser);
  text = upsertEnvLine(text, 'CC_REMOTE_DEFAULT_SOURCE', 'codex');
  text = upsertEnvLine(text, 'CODEX_BIN', cfg.codexBin);
  text = upsertEnvLine(text, 'CC_REMOTE_PROJECTS_ROOT', path.posix.join(home, cfg.projectsDir));
  // `PORT` is what Next and Vite read on their own, so a dev server started
  // with no flags already lands on the tunneled port and the preview URL works.
  if (preview) {
    text = upsertEnvLine(text, 'PORT', String(preview.port));
    text = upsertEnvLine(text, 'HEGAI_PREVIEW_URL', preview.url);
  }
  // A sandbox must never hold the fleet token or replicate memory as the owner.
  for (const forbidden of ['CC_REMOTE_TOKEN', 'CC_REMOTE_MEMORY_SYNC', 'CC_REMOTE_DEVICE_TOKEN']) {
    if (readEnvValue(text, forbidden) !== undefined) {
      log(job, 'env', 'warn', `stripped ${forbidden} from ${file}`);
      text = stripEnvLine(text, forbidden);
    }
  }
  if (enrolled) {
    text = stripEnvLine(text, 'CC_REMOTE_ENROLLMENT_CODE');
  } else {
    const code = job.enrollment?.code;
    if (!code) throw new StepError('enroll', 'no device credential yet and the job carries no enrollment code', true);
    if (job.enrollment?.expiresAt && Date.parse(job.enrollment.expiresAt) < Date.now()) {
      throw new StepError('enroll', 'enrollment code already expired when the job was executed', true);
    }
    text = upsertEnvLine(text, 'CC_REMOTE_ENROLLMENT_CODE', code);
  }
  const changed = current === null || text !== before;
  if (changed) await writeRootFile(file, text);
  if (current === null) await run('runuser', ['-u', unixUser, '--', 'rm', '-f', '--', legacy]);
  return changed ? 'written' : 'unchanged';
}

/**
 * What `~/.codex/config.toml` should contain, as a pure function of what it
 * contains now. Split out of `ensureCodexToml` so the rule can be tested
 * without a filesystem, a unix user or `runuser`.
 *
 * With a key, the managed gateway block is merged in. WITHOUT one the file gets
 * its project-trust table and NO `[model_providers.hegai]` — and that is the
 * case worth naming, because it used to throw ("no gateway key in the job and
 * none installed yet") on the assumption that every sandbox is backed by the
 * community's shared subscription. It is not any more: the hub stopped minting
 * a seat at activation, so a new member's sandbox arrives with no key BY DESIGN
 * and they sign into their own Codex inside it. Left as it was, that throw
 * would have failed every first provisioning run from here on.
 *
 * `requireKey` is `sandbox_rotate_key` and nothing else: a rotation with no key
 * to install is a malformed job, not a configuration choice.
 */
export function codexTomlFor(before, projectsPath, gw, { requireKey = false, defaultModel, defaultBaseUrl = '' } = {}) {
  const trusted = ensureProjectTrust(before, projectsPath);
  if (gw?.apiKey) {
    const baseUrl = gw.baseUrl || defaultBaseUrl;
    // Never guess a host to send a key to: a key with no address is a malformed job.
    if (!baseUrl) throw new StepError('toml', 'job carries gateway.apiKey but no gateway.baseUrl (and SANDBOX_GATEWAY_URL is unset)', false);
    return mergeCodexToml(trusted, {
      model: gw.model || defaultModel,
      baseUrl,
      apiKey: gw.apiKey,
    });
  }
  if (requireKey) throw new StepError('toml', 'job carries no gateway.apiKey', false);
  return trusted;
}

async function ensureCodexToml(cfg, job, unixUser, { requireKey }) {
  const home = homeOf(cfg, unixUser);
  const file = path.posix.join(home, '.codex', 'config.toml');
  const before = (await readAsUser(unixUser, file)) ?? '';
  const text = codexTomlFor(before, path.posix.join(home, cfg.projectsDir), job.gateway, {
    requireKey,
    defaultModel: cfg.defaultModel,
    defaultBaseUrl: cfg.gatewayUrl,
  });
  if (text !== before) await writeAsUser(cfg, unixUser, file, text, 0o600);
  return text !== before ? 'written' : 'unchanged';
}

async function ensureGitIdentity(cfg, job, unixUser) {
  const home = homeOf(cfg, unixUser);
  const env = { HOME: home };
  const git = (args, opts = {}) => run('runuser', ['-u', unixUser, '--', 'git', ...args], { env, ...opts });
  const wanted = { 'user.name': gitNameFor(job.user), 'user.email': String(job.user?.email || `${unixUser}@sandbox.invalid`) };
  const changed = [];
  for (const [key, value] of Object.entries(wanted)) {
    const cur = await git(['config', '--global', '--get', key], { ok: [0, 1] });
    if (cur.code === 0 && cur.stdout.trim()) continue; // the member's own choice wins
    await git(['config', '--global', key, value]);
    changed.push(key);
  }
  const branch = await git(['config', '--global', '--get', 'init.defaultBranch'], { ok: [0, 1] });
  if (branch.code !== 0) { await git(['config', '--global', 'init.defaultBranch', 'main']); changed.push('init.defaultBranch'); }
  return changed.length ? `set ${changed.join(',')}` : 'unchanged';
}

async function ensureProfile(cfg, unixUser, preview = null) {
  const home = homeOf(cfg, unixUser);
  const file = path.posix.join(home, '.profile');
  const before = (await readAsUser(unixUser, file)) ?? '';
  const nodeDir = path.dirname(cfg.node);
  const text = upsertManagedBlock(before, PROFILE_BLOCK_START, PROFILE_BLOCK_END, [
    `export PATH="${nodeDir}:$HOME/.local/bin:$PATH"`,
    `export CODEX_BIN="${cfg.codexBin}"`,
    `export CC_REMOTE_PROJECTS_ROOT="$HOME/${cfg.projectsDir}"`,
    ...(preview ? [`export PORT="${preview.port}"`, `export HEGAI_PREVIEW_URL="${preview.url}"`] : []),
  ]);
  if (text !== before) await writeAsUser(cfg, unixUser, file, text, 0o644);
  await ensureClaudeShim(cfg, unixUser);
  return text !== before ? 'written' : 'unchanged';
}

/**
 * `claude` on the sandbox's own PATH, for the person at the terminal. Sessions
 * and the «Войти» button never need it — the agent runs the binary bundled
 * with its own SDK — but `/usr/local/bin/claude` on the host points into
 * /root, which a sandbox user cannot execute, so `claude auth status` at the
 * prompt answered «permission denied». The shim is a symlink to that same
 * bundled binary; it follows the `current` release on its own.
 */
async function ensureClaudeShim(cfg, unixUser) {
  const target = path.posix.join(cfg.agentDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude');
  try {
    await fs.access(target, fsConstants.X_OK);
  } catch {
    return 'no bundled claude';
  }
  const home = homeOf(cfg, unixUser);
  const bin = path.posix.join(home, '.local', 'bin');
  await mkdirAsUser(unixUser, bin, '755');
  await run('runuser', ['-u', unixUser, '--', 'ln', '-sfn', target, path.posix.join(bin, 'claude')]);
  return 'linked';
}

async function ensureUnit(cfg, unixUser, { restart }) {
  const unit = unitOf(cfg, unixUser);
  const st = await unitState(cfg, unixUser);
  if (!st.enabled || !st.active) {
    await run('systemctl', ['reset-failed', unit], { ok: [0, 1, 5] });
    await run('systemctl', ['enable', '--now', unit]);
    return 'enabled+started';
  }
  if (restart) {
    await run('systemctl', ['restart', unit]);
    return 'restarted';
  }
  return 'already running';
}

async function waitForEnrollment(cfg, unixUser) {
  const deadline = Date.now() + ENROLL_WAIT_MS;
  while (Date.now() < deadline) {
    const agent = await readAgentJson(cfg, unixUser);
    if (agent?.deviceToken) return agent;
    await sleep(ENROLL_POLL_MS);
  }
  return null;
}

async function sandboxCreate(cfg, job) {
  const unixUser = validateUnixUser(job.sandbox?.unixUser);
  const secrets = [job.enrollment?.code, job.gateway?.apiKey];
  try {
    await step(job, 'useradd', () => ensureUser(cfg, job, unixUser));
    await step(job, 'dirs', () => ensureDirs(cfg, unixUser));
    const pw = await passwdEntry(unixUser);
    const preview = pw ? previewFor(cfg, pw.uid) : null;
    if (preview) log(job, 'preview', 'ok', `${preview.url} -> :${preview.port}`);
    else log(job, 'preview', 'ok', 'no slot in the pool — sandbox works, dev server not published');

    const existing = await readAgentJson(cfg, unixUser);
    const enrolled = Boolean(existing?.deviceToken);
    if (existing === null && job.sandbox.machineId) {
      // No agent.json yet: pin the machine id the hub already knows so a retry
      // after a failed exchange does not register a second device.
      await step(job, 'seed', () => writeAsUser(cfg, unixUser,
        path.posix.join(homeOf(cfg, unixUser), '.cc-remote', 'agent.json'),
        JSON.stringify({ machineId: job.sandbox.machineId, name: job.sandbox.machineName || unixUser }, null, 2) + '\n',
        0o600));
    }
    const envResult = await step(job, 'env', () => ensureEnv(cfg, job, unixUser, { enrolled, preview }));
    await step(job, 'toml', () => ensureCodexToml(cfg, job, unixUser, { requireKey: false }));
    await step(job, 'git', () => ensureGitIdentity(cfg, job, unixUser));
    await step(job, 'profile', () => ensureProfile(cfg, unixUser, preview));
    // A fresh enrollment code only takes effect if the agent starts with it.
    await step(job, 'unit', () => ensureUnit(cfg, unixUser, { restart: !enrolled && envResult === 'written' }));

    let agent = existing;
    if (!enrolled) {
      agent = await step(job, 'enroll', async () => {
        const got = await waitForEnrollment(cfg, unixUser);
        if (!got) throw new StepError('enroll', `no deviceToken in agent.json after ${ENROLL_WAIT_MS / 1000}s`, true);
        return `machineId=${got.machineId}`;
      }).then(() => readAgentJson(cfg, unixUser));
      await step(job, 'env-clean', () => ensureEnv(cfg, job, unixUser, { enrolled: true, preview }));
    }
    const base = await baseReport(cfg, unixUser);
    return okResult({ ...base, machineId: agent?.machineId ?? base.machineId, machineName: job.sandbox.machineName || base.machineName || unixUser, ...(preview ? { previewUrl: preview.url, previewPort: preview.port } : {}) });
  } catch (err) {
    return await failure(cfg, job, unixUser, err, secrets);
  }
}

// ------------------------------------------------- suspend / resume / etc.

async function stopAndLock(cfg, job, unixUser) {
  await step(job, 'unit-stop', () => run('systemctl', ['disable', '--now', unitOf(cfg, unixUser)], { ok: [0, 1, 5] }).then(() => 'disabled+stopped'));
  await step(job, 'terminate', () => run('loginctl', ['terminate-user', unixUser], { ok: [0, 1] }).then(() => 'done'));
  await step(job, 'kill', () => run('pkill', ['-KILL', '-u', unixUser], { ok: [0, 1] }).then(() => 'done'));
  await step(job, 'lock', () => run('usermod', ['-L', unixUser]).then(() => 'locked'));
}

async function sandboxSuspend(cfg, job) {
  const unixUser = validateUnixUser(job.sandbox?.unixUser);
  try {
    if (!(await passwdEntry(unixUser))) throw new StepError('validate', `${unixUser} does not exist`, false);
    await stopAndLock(cfg, job, unixUser);
    return okResult(await baseReport(cfg, unixUser));
  } catch (err) {
    return await failure(cfg, job, unixUser, err, []);
  }
}

async function sandboxResume(cfg, job) {
  const unixUser = validateUnixUser(job.sandbox?.unixUser);
  try {
    if (!(await passwdEntry(unixUser))) throw new StepError('validate', `${unixUser} does not exist`, false);
    await step(job, 'unlock', async () => {
      // `usermod -U` refuses when unlocking would leave an empty password; the
      // account never had one, and the unit does not consult it — not fatal.
      const r = await run('usermod', ['-U', unixUser], { ok: [0, 3] });
      return r.code === 0 ? 'unlocked' : 'left locked (no password to unlock)';
    });
    await step(job, 'unit', () => ensureUnit(cfg, unixUser, { restart: false }));
    return okResult(await baseReport(cfg, unixUser));
  } catch (err) {
    return await failure(cfg, job, unixUser, err, []);
  }
}

/** Final disk check also handles a retry after userdel removed the passwd row
 * but failed to remove a home. Never follow a home/backup symlink. */
export async function eraseSandboxFiles(cfg, unixUser) {
  validateUnixUser(unixUser);
  const home = path.join(cfg.homeRoot, unixUser);
  const stat = await fs.lstat(home).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid < cfg.uidMin || stat.uid > cfg.uidMax) {
      throw new StepError('erase', 'remaining home has unexpected ownership or type', false);
    }
    await fs.rm(home, { recursive: true });
  }
  const entries = await fs.readdir(cfg.backupDir, { withFileTypes: true }).catch(e => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const pattern = new RegExp(`^${unixUser}-[0-9]{8}-[0-9]{4}\\.tgz$`);
  for (const entry of entries) {
    if (!pattern.test(entry.name)) continue;
    if (!entry.isFile()) throw new StepError('erase', 'sandbox backup has unexpected type', false);
    await fs.unlink(path.join(cfg.backupDir, entry.name));
  }
  await fs.lstat(home).then(() => {
    throw new StepError('erase', 'home directory still exists', true);
  }, e => { if (e.code !== 'ENOENT') throw e; });
}

async function sandboxDelete(cfg, job) {
  const unixUser = validateUnixUser(job.sandbox?.unixUser);
  try {
    const pw = await passwdEntry(unixUser);
    if (!pw && job.erasePersonalData !== true) throw new StepError('validate', `${unixUser} does not exist`, false);
    if (pw && (pw.uid < cfg.uidMin || pw.uid > cfg.uidMax)) {
      throw new StepError('validate', `${unixUser} uid ${pw.uid} is outside the sandbox range — refusing to delete`, false);
    }
    const report = pw ? await baseReport(cfg, unixUser) : { machineId: job.sandbox.machineId };
    if (pw) await stopAndLock(cfg, job, unixUser);
    if (job.erasePersonalData === true) {
      if (pw) await step(job, 'userdel', () => run('userdel', ['-r', unixUser], { ok: [0] }));
      await eraseSandboxFiles(cfg, unixUser);
      return okResult({ ...report, personalDataErased: true });
    }
    const archive = path.join(cfg.backupDir, backupName(unixUser));
    await step(job, 'archive', async () => {
      await fs.mkdir(cfg.backupDir, { recursive: true, mode: 0o700 });
      await run('tar', ['--exclude=node_modules', '--exclude=.next', '--exclude=.cache', '--warning=no-file-changed',
        '-czf', archive, '-C', cfg.homeRoot, unixUser], { timeoutMs: 20 * 60_000, ok: [0, 1] });
      // The archive is somebody's whole home — code, transcripts, whatever they
      // put there. The directory is 0700, but the file says so too.
      await fs.chmod(archive, 0o600);
      const st = await fs.stat(archive);
      return `${archive} (${Math.round(st.size / 1024)} KiB)`;
    });
    await step(job, 'userdel', () => run('userdel', ['-r', unixUser], { ok: [0, 12] }).then(() => 'removed'));
    return okResult({ ...report, archive });
  } catch (err) {
    return await failure(cfg, job, unixUser, err, []);
  }
}

async function sandboxRotateKey(cfg, job) {
  const unixUser = validateUnixUser(job.sandbox?.unixUser);
  try {
    if (!(await passwdEntry(unixUser))) throw new StepError('validate', `${unixUser} does not exist`, false);
    await step(job, 'toml', () => ensureCodexToml(cfg, job, unixUser, { requireKey: true }));
    await step(job, 'restart', () => run('systemctl', ['try-restart', unitOf(cfg, unixUser)]).then(() => 'done'));
    return okResult(await baseReport(cfg, unixUser));
  } catch (err) {
    return await failure(cfg, job, unixUser, err, [job.gateway?.apiKey]);
  }
}

async function failure(cfg, job, unixUser, err, secrets) {
  const stage = err instanceof StepError ? err.stage : 'unknown';
  const retryable = err instanceof StepError ? err.retryable : true;
  const result = { ok: false, stage, error: redact(String(err.message || err), secrets), retryable };
  if (unixUser && (await passwdEntry(unixUser))) {
    result.journalTail = redact(await journalTail(cfg, unixUser), secrets);
  }
  return result;
}

export async function executeJob(cfg, job) {
  if (!job || typeof job !== 'object') return { ok: false, stage: 'validate', error: 'job is not an object', retryable: false };
  const kind = job.kind;
  log(job, 'start', 'ok', `kind=${kind}`);
  let result;
  switch (kind) {
    case 'sandbox_create': result = await sandboxCreate(cfg, job); break;
    case 'sandbox_suspend': result = await sandboxSuspend(cfg, job); break;
    case 'sandbox_resume': result = await sandboxResume(cfg, job); break;
    case 'sandbox_delete': result = await sandboxDelete(cfg, job); break;
    case 'sandbox_rotate_key': result = await sandboxRotateKey(cfg, job); break;
    default: result = { ok: false, stage: 'validate', error: `unknown job kind ${JSON.stringify(kind)}`, retryable: false };
  }
  log(job, 'done', result.ok ? 'ok' : 'err', result.ok ? `machineId=${result.machineId ?? '-'}` : `stage=${result.stage} retryable=${result.retryable} ${result.error}`);
  return result;
}

// ------------------------------------------------------------ hub client

async function hubPost(cfg, route, body, { timeoutMs = 30_000 } = {}) {
  const headers = { authorization: `Bearer ${cfg.token}`, 'user-agent': `cc-remote-provisioner/${PROVISIONER_VERSION} (${cfg.host})` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${cfg.hubUrl}${route}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new Error(`${route} -> non-JSON body`); }
}

async function capacity(cfg) {
  const out = { active: 0, total: 0, memAvailMb: 0, diskFreeGb: 0, agentVersion: await agentVersion(cfg) };
  try {
    const r = await run('systemctl', ['list-units', `${cfg.unitPrefix}*`, '--no-legend', '--plain', '--state=active'], { ok: [0, 1] });
    out.active = r.stdout.split('\n').filter((l) => l.trim().startsWith(cfg.unitPrefix)).length;
  } catch { /* leave 0 */ }
  try {
    const r = await run('getent', ['passwd'], { ok: [0] });
    out.total = r.stdout.split('\n').filter((l) => {
      const f = l.split(':');
      return f.length > 3 && UNIX_USER_RE.test(f[0]) && Number(f[2]) >= cfg.uidMin && Number(f[2]) <= cfg.uidMax;
    }).length;
  } catch { /* leave 0 */ }
  try {
    const mem = await fs.readFile('/proc/meminfo', 'utf8');
    const m = /MemAvailable:\s+(\d+)\s+kB/.exec(mem);
    if (m) out.memAvailMb = Math.round(Number(m[1]) / 1024);
  } catch { /* leave 0 */ }
  try {
    const st = await fs.statfs(cfg.homeRoot);
    out.diskFreeGb = Math.round((Number(st.bavail) * Number(st.bsize)) / 1024 ** 3);
  } catch { /* leave 0 */ }
  return out;
}

async function claim(cfg) {
  return hubPost(cfg, '/api/provisioning/jobs/claim', { host: cfg.host, capacity: await capacity(cfg) }, { timeoutMs: 60_000 });
}

async function postResult(cfg, job, result) {
  const route = `/api/provisioning/jobs/${encodeURIComponent(job.jobId)}/result`;
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { await hubPost(cfg, route, result); return; } catch (err) { last = err; log(job, 'result', 'err', `attempt ${attempt}: ${err.message}`); await sleep(5_000 * attempt); }
  }
  throw last;
}

function validateClaimedJob(job) {
  if (!job || typeof job !== 'object') throw new Error('claim returned a non-object');
  if (typeof job.jobId !== 'string' || !job.jobId) throw new Error('claimed job has no jobId');
  if (!JOB_KINDS.includes(job.kind)) throw new Error(`claimed job has unknown kind ${JSON.stringify(job.kind)}`);
  return job;
}

async function runClaimedJob(cfg, job) {
  const hbRoute = `/api/provisioning/jobs/${encodeURIComponent(job.jobId)}/heartbeat`;
  const hb = setInterval(() => {
    hubPost(cfg, hbRoute, undefined, { timeoutMs: 15_000 }).catch((err) => log(job, 'heartbeat', 'err', err.message));
  }, HEARTBEAT_MS);
  let result;
  try {
    result = await executeJob(cfg, job);
  } catch (err) {
    result = { ok: false, stage: 'unknown', error: String(err.message || err), retryable: true };
  } finally {
    clearInterval(hb);
  }
  await postResult(cfg, job, result);
}

export async function daemon(cfg) {
  if (!cfg.token || cfg.token.length < 32) {
    console.error('CC_REMOTE_PROVISIONER_TOKEN is missing or shorter than 32 characters — refusing to start');
    process.exit(2);
  }
  console.log(`${new Date().toISOString()} provisioner v${PROVISIONER_VERSION} host=${cfg.host} hub=${cfg.hubUrl} agent=${cfg.agentDir} node=${process.version}`);
  let stopping = false;
  let busy = false;
  const onStop = (sig) => {
    console.log(`${new Date().toISOString()} ${sig}: ${busy ? 'finishing the current job, then exiting' : 'exiting'}`);
    stopping = true;
    if (!busy) process.exit(0);
  };
  process.on('SIGTERM', () => onStop('SIGTERM'));
  process.on('SIGINT', () => onStop('SIGINT'));

  let backoff = BACKOFF_MIN_MS;
  let idle = 0;
  while (!stopping) {
    let job;
    try {
      job = await claim(cfg);
      backoff = BACKOFF_MIN_MS;
    } catch (err) {
      console.log(`${new Date().toISOString()} claim err ${err.message} — retry in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      continue;
    }
    if (!job) {
      if (++idle % IDLE_LOG_EVERY === 0) console.log(`${new Date().toISOString()} idle polls=${idle}`);
      await sleep(IDLE_SLEEP_MS);
      continue;
    }
    idle = 0;
    busy = true;
    try {
      validateClaimedJob(job);
      log(job, 'claim', 'ok', `kind=${job.kind}`);
      await runClaimedJob(cfg, job);
    } catch (err) {
      console.log(`${new Date().toISOString()} job=${job?.jobId ?? '-'} fatal ${err.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    } finally {
      busy = false;
    }
  }
  process.exit(0);
}

export async function local(cfg, file) {
  const raw = await fs.readFile(file, 'utf8');
  const job = JSON.parse(raw);
  if (!job.jobId) job.jobId = `local-${Date.now()}`;
  if (!job.hub) job.hub = { centralUrl: toWsUrl(cfg.hubUrl) };
  const result = await executeJob(cfg, job);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.ok ? 0 : 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  console.error('usage: provisioner.mjs local <job.json> | provisioner.mjs daemon');
  process.exit(2);
}

// ---------------------------------------------------------------- CLI guard

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'daemon') {
    daemon(cfg).catch((err) => { console.error(err); process.exit(1); });
  } else if (mode === 'local' && arg) {
    local(cfg, arg).then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
  } else {
    usage();
  }
}
