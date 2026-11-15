import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { RuntimeJob } from '@cc-remote/shared';
import { CodexNotFound, invalidateCodexBin, resolveClaudeBin, spawnCodex } from './runtime-locate.js';
import { childEnv } from './child-env.js';

/**
 * The two buttons on the «Начало» screen, done on the machine: install Codex,
 * log into Codex or Claude. Each is a JOB — started by one RPC that returns
 * within seconds, watched by `runtime.job.status` polls, because an RPC
 * answer has 30 s and a login has as long as the person takes to type a code.
 *
 * Codex logs in through its own app-server, the same one sessions run on:
 * `account/login/start {type:'chatgptDeviceCode'}` answers with a page and a
 * code (probed on 0.154: `{loginId, verificationUrl, userCode}`), and the
 * server says `account/login/completed` when the person has typed it. Claude
 * logs in with `claude auth login`: it prints a page to open and then waits
 * on stdin for the code that page hands back — so the browser pastes it
 * through `runtime.login.input`. When either finishes, `onChanged` fires and
 * the client re-reads the runtimes at once, so the chip turns green now and
 * not at the next three-minute poll.
 */

const LOGIN_TTL_MS = 15 * 60_000;
const INSTALL_TTL_MS = 10 * 60_000;
/** Finished jobs stay answerable this long, then are forgotten. */
const KEEP_DONE_MS = 10 * 60_000;
const TAIL_MAX = 600;

interface Job extends RuntimeJob {
  startedAt: number;
  finishedAt?: number;
  child?: ChildProcess;
  /** Codex: the app-server login id, for `account/login/cancel`. */
  codexLoginId?: string;
  timer?: NodeJS.Timeout;
}

const jobs = new Map<string, Job>();
let onChanged: () => void = () => {};

/** Called when a job finishes with a change on disk (a login, an install). */
export function setRuntimeChangedHook(fn: () => void): void {
  onChanged = fn;
}

function publicView(j: Job): RuntimeJob {
  return {
    id: j.id,
    kind: j.kind,
    runtime: j.runtime,
    state: j.state,
    ...(j.url ? { url: j.url } : {}),
    ...(j.userCode ? { userCode: j.userCode } : {}),
    ...(j.needsInput ? { needsInput: true } : {}),
    ...(j.expiresAt ? { expiresAt: j.expiresAt } : {}),
    ...(j.tail ? { tail: j.tail.slice(-TAIL_MAX) } : {}),
  };
}

function finish(j: Job, state: 'done' | 'failed', why?: string): void {
  if (j.state !== 'running') return;
  j.state = state;
  j.finishedAt = Date.now();
  if (why) j.tail = `${j.tail ? `${j.tail}\n` : ''}${why}`.slice(-TAIL_MAX);
  if (j.timer) clearTimeout(j.timer);
  if (j.child && j.child.exitCode === null) j.child.kill();
  console.log(`[agent] runtime ${j.kind} ${j.runtime}: ${state}${why ? ` — ${why}` : ''}`);
  if (state === 'done') onChanged();
  sweep();
}

function sweep(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.state !== 'running' && j.finishedAt && now - j.finishedAt > KEEP_DONE_MS) jobs.delete(id);
  }
}

function newJob(kind: Job['kind'], runtime: Job['runtime'], ttl: number): Job {
  const j: Job = { id: randomUUID(), kind, runtime, state: 'running', startedAt: Date.now() };
  j.timer = setTimeout(() => finish(j, 'failed', 'время вышло'), ttl);
  j.timer.unref?.();
  jobs.set(j.id, j);
  return j;
}

function appendTail(j: Job, chunk: string): void {
  // Strip ANSI so the tail reads as text in the browser.
  const clean = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  j.tail = `${j.tail ?? ''}${clean}`.slice(-TAIL_MAX);
}

export function jobStatus(id: string): RuntimeJob {
  const j = jobs.get(id);
  if (!j) return { id, kind: 'login', runtime: 'codex', state: 'failed', tail: 'задание не найдено — возможно, агент перезапускался' };
  return publicView(j);
}

// ------------------------------------------------------------------ install

/** The npm beside the agent's own node: the portable runtime ships one, and
 *  the machine's own node (when that is what runs the agent) does too. */
async function npmBin(): Promise<string> {
  const dir = path.dirname(process.execPath);
  const candidates =
    process.platform === 'win32'
      ? [path.join(dir, 'npm.cmd'), path.join(dir, 'npm')]
      : [path.join(dir, 'npm'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const c of candidates) {
    try {
      await access(c, constants.F_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** `npm install -g` arguments per runtime. Claude goes into the user's own
 *  prefix (`~/.local`, where `resolveClaudeBin` looks) so it never needs sudo;
 *  Codex keeps the node's own prefix, as before. */
export function installArgs(runtime: 'claude' | 'codex', platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string[] {
  if (runtime === 'codex') return ['install', '-g', '@openai/codex'];
  return ['install', '-g', ...(platform === 'win32' ? [] : ['--prefix', path.join(home, '.local')]), '@anthropic-ai/claude-code'];
}

export async function startInstall(runtime: 'claude' | 'codex'): Promise<{ jobId: string }> {
  const j = newJob('install', runtime, INSTALL_TTL_MS);
  const npm = await npmBin();
  const viaNode = npm.endsWith('.js');
  let child: ChildProcess;
  try {
    child = spawn(viaNode ? process.execPath : npm, [...(viaNode ? [npm] : []), ...installArgs(runtime)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
      windowsHide: true,
      shell: process.platform === 'win32' && !viaNode,
    });
  } catch (error) {
    finish(j, 'failed', `npm не запустился: ${(error as Error).message}`);
    return { jobId: j.id };
  }
  j.child = child;
  child.stdout?.on('data', (d: Buffer) => appendTail(j, d.toString()));
  child.stderr?.on('data', (d: Buffer) => appendTail(j, d.toString()));
  child.on('error', (e) => finish(j, 'failed', e.message));
  child.on('close', (code) => {
    invalidateCodexBin();
    if (code === 0) finish(j, 'done');
    else finish(j, 'failed', `npm завершился с кодом ${code ?? '?'}`);
  });
  return { jobId: j.id };
}

// -------------------------------------------------------------------- login

export async function startLogin(runtime: 'claude' | 'codex'): Promise<RuntimeJob> {
  return runtime === 'codex' ? startCodexLogin() : startClaudeLogin();
}

/** Codex: one app-server per login, kept alive until the server reports
 *  completion, the person cancels, or the code expires. */
async function startCodexLogin(): Promise<RuntimeJob> {
  const j = newJob('login', 'codex', LOGIN_TTL_MS);
  let child: ChildProcessWithoutNullStreams;
  try {
    ({ child } = await spawnCodex(['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch (error) {
    const why = error instanceof CodexNotFound ? 'codex не найден на машине — сначала «Установить»' : (error as Error).message;
    finish(j, 'failed', why);
    return publicView(j);
  }
  j.child = child;
  child.stderr.on('data', (d: Buffer) => appendTail(j, d.toString()));
  child.on('error', (e) => finish(j, 'failed', e.message));
  child.on('close', (code) => {
    if (j.state === 'running') finish(j, 'failed', `app-server завершился (${code ?? '?'})`);
  });
  const send = (frame: unknown) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(frame)}\n`);
  };

  const started = new Promise<void>((resolve) => {
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (f['id'] === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/login/start', params: { type: 'chatgptDeviceCode' } });
        return;
      }
      if (f['id'] === 2) {
        const r = f['result'] as { loginId?: string; verificationUrl?: string; userCode?: string } | undefined;
        if (!r || typeof r.userCode !== 'string') {
          const e = f['error'] as { message?: string } | undefined;
          finish(j, 'failed', e?.message ?? 'app-server не выдал код');
        } else {
          j.codexLoginId = r.loginId;
          j.url = r.verificationUrl ?? 'https://auth.openai.com/codex/device';
          j.userCode = r.userCode;
          j.expiresAt = Date.now() + LOGIN_TTL_MS;
        }
        resolve();
        return;
      }
      if (f['method'] === 'account/login/completed') {
        const p = (f['params'] ?? {}) as { loginId?: string; success?: boolean; error?: string };
        if (p.loginId && j.codexLoginId && p.loginId !== j.codexLoginId) return;
        if (p.success === false || p.error) finish(j, 'failed', p.error ?? 'вход отклонён');
        else finish(j, 'done');
      }
    });
  });
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cc-remote-agent', version: '1.0.0' }, capabilities: {} } });
  await Promise.race([started, new Promise<void>((r) => setTimeout(r, 15_000))]);
  if (j.state === 'running' && !j.userCode) finish(j, 'failed', 'app-server не ответил за 15 с');
  return publicView(j);
}

/** The page `claude auth login` prints, e.g. «If the browser didn't open,
 *  visit: https://claude.com/cai/oauth/authorize?…». */
export function claudeLoginUrl(output: string): string | undefined {
  const m = /(https:\/\/[^\s'"<>]+oauth[^\s'"<>]*)/i.exec(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  return m?.[1];
}

/** Claude: the CLI opens a browser when it can, prints the page either way,
 *  and waits on stdin for the code that page shows at the end. */
async function startClaudeLogin(): Promise<RuntimeJob> {
  const j = newJob('login', 'claude', LOGIN_TTL_MS);
  const bin = await resolveClaudeBin();
  if (!bin) {
    finish(j, 'failed', 'claude не найден на машине');
    return publicView(j);
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, ['auth', 'login', '--claudeai'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({ FORCE_COLOR: '0', NO_COLOR: '1' }),
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin),
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    finish(j, 'failed', `claude не запустился: ${(error as Error).message}`);
    return publicView(j);
  }
  j.child = child;
  j.needsInput = true;
  const urlSeen = new Promise<void>((resolve) => {
    const onData = (d: Buffer) => {
      appendTail(j, d.toString());
      if (!j.url) {
        const u = claudeLoginUrl(j.tail ?? '');
        if (u) {
          j.url = u;
          resolve();
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
  child.on('error', (e) => finish(j, 'failed', e.message));
  child.on('close', (code) => {
    if (code === 0) finish(j, 'done');
    else finish(j, 'failed', `claude завершился с кодом ${code ?? '?'}`);
  });
  await Promise.race([urlSeen, new Promise<void>((r) => setTimeout(r, 15_000))]);
  if (j.state === 'running' && !j.url) finish(j, 'failed', 'claude не показал ссылку для входа за 15 с');
  return publicView(j);
}

export function loginInput(loginId: string, code: string): { ok: boolean } {
  const j = jobs.get(loginId);
  if (!j || j.state !== 'running' || !j.child?.stdin?.writable) return { ok: false };
  j.child.stdin.write(`${code.trim()}\n`);
  return { ok: true };
}

export function cancelLogin(loginId: string): { ok: boolean } {
  const j = jobs.get(loginId);
  if (!j) return { ok: false };
  if (j.state === 'running') {
    if (j.runtime === 'codex' && j.codexLoginId && j.child?.stdin?.writable) {
      j.child.stdin.write(`${JSON.stringify({ id: 3, method: 'account/login/cancel', params: { loginId: j.codexLoginId } })}\n`);
    }
    finish(j, 'failed', 'отменено');
  }
  return { ok: true };
}
