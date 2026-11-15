/**
 * Shared helpers for the dev/test CLIs in this directory. Keeps the smokes off
 * `any` by reusing the protocol types from `@cc-remote/shared`, and centralizes
 * what they all repeat: dialing the hub's /ui socket, the "find a machine + a
 * session matching a predicate" pick, the `[name] title` step banner, one RPC
 * round trip, and (for the browser smokes) finding and launching Chrome.
 */
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { Browser, Page } from 'puppeteer-core';
import {
  decodeCentralToAgent,
  decodeCentralToBrowser,
  type BrowserToCentral,
  type CentralToAgent,
  type CentralToBrowser,
  type MachineSnapshot,
  type RpcMethod,
  type SessionSummary,
} from '@cc-remote/shared';

export interface UiConnection {
  ws: WebSocket;
  /** Type-checked send: everything that crosses the wire is BrowserToCentral. */
  send: (msg: BrowserToCentral) => void;
  base: string;
  token: string;
}

/**
 * Connect to the hub's /ui endpoint. Resolution order lets the same command
 * line run against dev and prod without shuffling argv:
 *   base  : argv[2]  -> $CC_SMOKE_URL     -> ws://127.0.0.1:4319
 *   token : argv[3]  -> $CC_REMOTE_TOKEN  -> dev-token
 */
export function connectUi(argv: string[]): UiConnection {
  const base = argv[2] ?? process.env['CC_SMOKE_URL'] ?? 'ws://127.0.0.1:4319';
  const token = argv[3] ?? process.env['CC_REMOTE_TOKEN'] ?? 'dev-token';
  const ws = new WebSocket(`${base}/ui?token=${encodeURIComponent(token)}`);
  return { ws, send: (msg) => ws.send(JSON.stringify(msg)), base, token };
}

/**
 * Machine-name filter for smokes that pick a session:
 *   argv[4] -> $CC_SMOKE_MACHINE -> `fallback` (undefined = any machine).
 * Against a prod hub, always set one so a smoke never resumes an arbitrary
 * session on an arbitrary machine.
 */
export function machineFilterArg(argv: string[], fallback: string): string;
export function machineFilterArg(argv: string[], fallback?: string): string | undefined;
export function machineFilterArg(argv: string[], fallback?: string): string | undefined {
  return argv[4] ?? process.env['CC_SMOKE_MACHINE'] ?? fallback;
}

export interface Picked {
  machine: MachineSnapshot;
  session: SessionSummary;
}

/**
 * First machine whose name matches `filter` (or any machine, if `filter` is
 * undefined) that has a session passing `pred`, together with that session.
 */
export function pickSession(
  machines: MachineSnapshot[],
  filter: string | undefined,
  pred: (s: SessionSummary) => boolean,
): Picked | undefined {
  const nameOk = (m: MachineSnapshot) => !filter || m.machine.name.toLowerCase().includes(filter.toLowerCase());
  for (const m of machines) {
    if (!nameOk(m)) continue;
    const session = m.sessions.find(pred);
    if (session) return { machine: m, session };
  }
  return undefined;
}

/** Common session predicates. */
export const dormantWithCwd = (s: SessionSummary): boolean => !!s.cwd && !s.livePid;
export const liveWithCwd = (s: SessionSummary): boolean => !!s.cwd && !!s.livePid;

/**
 * Write a fake `~/.claude/sessions/<pid>.json` liveness record claiming
 * `sessionId` — the exact shape `readLiveSessions()` honors (numeric pid,
 * string sessionId, non-`sdk-*` entrypoint). Used by yield-smoke and
 * takeover-force-smoke to simulate an editor writer; returns the file path so
 * the caller can rmSync it on cleanup.
 */
export function writeFakeLiveSession(pid: number, sessionId: string): string {
  const file = path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid, sessionId, cwd: '', kind: 'interactive', entrypoint: 'claude-vscode' }));
  return file;
}

// ---------------------------------------------------------------------------
// Community-rollout helpers (wave-smoke, team-smoke, projects-smoke): HegAI
// SSO logins minted locally, the hub's JSON API, cookie-authenticated /ui
// sockets, and a fake agent enrolled with a device code.
// ---------------------------------------------------------------------------

/** `ws://host:port` -> `http://host:port` (and `wss` -> `https`). */
export function httpBase(wsBase: string): string {
  return wsBase.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
}

export interface SmokeTarget {
  /** WebSocket origin, e.g. ws://127.0.0.1:4319. */
  ws: string;
  /** Same origin over HTTP, for the JSON API. */
  http: string;
  /** The hub's fleet token (`CC_REMOTE_TOKEN`); `dev-token` on a dev hub. */
  token: string;
  /** `CC_REMOTE_SSO_SECRET` — the smokes mint HegAI SSO tokens with it. */
  ssoSecret: string | undefined;
}

/**
 * Same resolution order as `connectUi`, plus the SSO secret:
 *   base   : argv[2] -> $CC_SMOKE_URL        -> ws://127.0.0.1:4319
 *   token  : argv[3] -> $CC_REMOTE_TOKEN     -> dev-token
 *   secret : $CC_REMOTE_SSO_SECRET (must match the hub's)
 */
export function smokeTarget(argv: string[]): SmokeTarget {
  const ws = argv[2] ?? process.env['CC_SMOKE_URL'] ?? 'ws://127.0.0.1:4319';
  const token = argv[3] ?? process.env['CC_REMOTE_TOKEN'] ?? 'dev-token';
  const ssoSecret = process.env['CC_REMOTE_SSO_SECRET']?.trim() || undefined;
  return { ws, http: httpBase(ws), token, ssoSecret };
}

/** A function DECLARATION so `never` narrows control flow at call sites. */
export function fail(why: string): never {
  console.error(`FAIL: ${why}`);
  process.exit(1);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A banner line for the next phase of a smoke: a blank line, then
 * `[<script name>] <title>`. The tag is the entry script's file name
 * (`tsx server/src/cli/team-smoke.ts` -> `[team-smoke]`), which is what every
 * smoke used to hard-code by hand.
 */
export function step(title: string): void {
  const script = path.basename(process.argv[1] ?? 'smoke').replace(/\.[cm]?[jt]s$/, '');
  console.log(`\n[${script}] ${title}`);
}

/** The claims `verify_sso_claims` (server-rs/src/main.rs) decodes. */
export interface SsoClaims {
  userId: string;
  email: string;
  fullName?: string;
  /** Seconds since the epoch; default one hour from now. */
  exp?: number;
}

/**
 * HS256 JWT exactly as admin.acme.test would mint it for `client=cc-remote`:
 * camelCase claims, `iss` acme.test, `aud` cc-remote, a required `exp`.
 */
export function mintSsoJwt(secret: string, claims: SsoClaims): string {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: Record<string, unknown> = {
    userId: claims.userId,
    email: claims.email,
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + 3600,
    iss: 'acme.test',
    aud: 'cc-remote',
  };
  if (claims.fullName !== undefined) payload['fullName'] = claims.fullName;
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** A throwaway community member: unique per run so re-runs never collide. */
export function randomSmokeUser(prefix: string, fullName?: string): SsoClaims {
  const id = randomUUID().slice(0, 8);
  return {
    userId: `${prefix}-${id}`,
    email: `${prefix}-${id}@smoke.invalid`,
    ...(fullName ? { fullName } : {}),
  };
}

export interface SsoSession {
  userId: string;
  email: string;
  /** The opaque workspace session token (the value of the auth cookie). */
  session: string;
  /** `cc-remote-auth=<session>` — ready for a Cookie header. */
  cookie: string;
}

const AUTH_COOKIE = 'cc-remote-auth';
const SSO_STATE_COOKIE = 'cc-remote-sso-state';
/** An https hub names its cookies `__Host-…`; a plain-http smoke hub keeps the bare names. */
const HOST_PREFIX = '__Host-';

function cookieFromSetCookie(headers: Headers, name: string): string | undefined {
  for (const line of headers.getSetCookie()) {
    const [pair] = line.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

function cookieEither(headers: Headers, base: string): { name: string; value: string } | undefined {
  for (const name of [HOST_PREFIX + base, base]) {
    const value = cookieFromSetCookie(headers, name);
    if (value) return { name, value };
  }
  return undefined;
}

/**
 * Drive the browser SSO handshake end-to-end without a browser:
 *   GET /api/auth/sso/start      -> 302 + the state cookie (state also in Location)
 *   GET /api/auth/sso/callback   -> 302 + the auth cookie
 * The JWT is minted locally with the hub's own secret, standing in for
 * admin.acme.test. Returns the session the browser would hold in its cookie.
 */
export async function ssoLogin(http: string, secret: string, claims: SsoClaims): Promise<SsoSession> {
  const start = await fetch(`${http}/api/auth/sso/start`, { redirect: 'manual' });
  if (start.status === 503) fail('hub has no CC_REMOTE_SSO_SECRET (>=32 chars) — SSO is disabled');
  if (start.status !== 302) fail(`sso/start answered ${start.status}, expected 302`);
  const stateSet = cookieEither(start.headers, SSO_STATE_COOKIE);
  if (!stateSet) fail('sso/start did not set the cc-remote-sso-state cookie');
  const stateCookie = stateSet.value;
  const location = start.headers.get('location') ?? '';
  const state = new URL(location).searchParams.get('state');
  if (!state) fail(`sso/start Location carries no state: ${location}`);
  if (state !== stateCookie) fail('sso/start state in Location differs from the cookie');

  const token = mintSsoJwt(secret, claims);
  const callback = await fetch(
    `${http}/api/auth/sso/callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: { cookie: `${stateSet.name}=${stateCookie}` } },
  );
  if (callback.status !== 302) {
    fail(`sso/callback answered ${callback.status} (${await callback.text()}) — wrong CC_REMOTE_SSO_SECRET?`);
  }
  const authSet = cookieEither(callback.headers, AUTH_COOKIE);
  if (!authSet) fail('sso/callback did not set the cc-remote-auth cookie');
  const session = authSet.value;
  return { userId: claims.userId, email: claims.email, session, cookie: `${authSet.name}=${session}` };
}

export interface ApiResponse {
  status: number;
  /** Parsed JSON body, or `{}` when the body is not JSON. */
  body: Record<string, unknown>;
  text: string;
  headers: Headers;
}

/**
 * One JSON call against the hub. `cookie` is the `SsoSession.cookie` (or
 * undefined for the dev-token bootstrap fallback / a public route). Always
 * sends `sec-fetch-site: same-origin`, which is what the hub's mutation gate
 * checks; `extraHeaders` is for bearer-authenticated routes.
 */
export async function api(
  http: string,
  cookie: string | undefined,
  method: string,
  route: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', ...extraHeaders };
  if (cookie) headers['cookie'] = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${http}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    /* not JSON (the SPA fallback, an empty 204) */
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

/** Log one API step and assert its status in one line. */
export function expectStatus(step: string, res: ApiResponse, ...allowed: number[]): ApiResponse {
  if (!allowed.includes(res.status)) {
    fail(`${step}: HTTP ${res.status}, expected ${allowed.join('|')} — ${res.text.slice(0, 300)}`);
  }
  console.log(`  ✓ ${step} -> ${res.status}`);
  return res;
}

/**
 * A platform-admin session. Logs in through SSO as `CC_SMOKE_ADMIN_ID`
 * (default `legacy-owner`, the hub's bootstrap id, which is a platform admin
 * unless `CC_REMOTE_PLATFORM_ADMIN_IDS` says otherwise). The email defaults to
 * the hub's own bootstrap email so the login does not rename that row.
 */
export async function adminLogin(http: string, secret: string | undefined, opts: { exp?: number } = {}): Promise<SsoSession> {
  const userId = process.env['CC_SMOKE_ADMIN_ID'] ?? 'legacy-owner';
  const email = process.env['CC_SMOKE_ADMIN_EMAIL'] ?? 'owner@localhost';
  // A hub that holds its admins to a second factor (`CC_REMOTE_ADMIN_MFA=required`)
  // leaves an SSO-minted session pending. Root on the hub box prints a satisfied
  // one — `cc-remote-server mint-tool-session --user <id> --ttl 2h --note <name>` —
  // and `CC_SMOKE_SESSION` hands it in instead of the SSO secret.
  const given = process.env['CC_SMOKE_SESSION']?.trim();
  if (!given && !secret) fail('neither CC_SMOKE_SESSION nor CC_REMOTE_SSO_SECRET is set');
  const admin: SsoSession = given
    ? { userId, email, session: given, cookie: `${http.startsWith('https:') ? HOST_PREFIX : ''}${AUTH_COOKIE}=${given}` }
    : await ssoLogin(http, secret!, { userId, email, ...(opts.exp === undefined ? {} : { exp: opts.exp }) });
  const me = await api(http, admin.cookie, 'GET', '/api/me');
  if (me.status !== 200) fail(`admin /api/me answered ${me.status}`);
  if (me.body['platformAdmin'] !== true) {
    fail(`${userId} is not a platform admin on this hub — set CC_REMOTE_PLATFORM_ADMIN_IDS=${userId} (or CC_SMOKE_ADMIN_ID)`);
  }
  return admin;
}

/** `POST /api/admin/access/grant {email}` → the parsed answer, whatever it is
 *  (`activated` | `pending` | `skipped`); the caller asserts on `status`. */
export async function adminGrant(http: string, admin: SsoSession, email: string): Promise<Record<string, unknown>> {
  const res = expectStatus(`admin grant ${email}`, await api(http, admin.cookie, 'POST', '/api/admin/access/grant', { email }), 200);
  return res.body;
}

/** Open access for people who have already signed in. One `grant` per address:
 *  the hub takes one at a time now, which is also what the admin tab does. */
export async function adminActivate(http: string, admin: SsoSession, emails: string[]): Promise<void> {
  for (const email of emails) {
    const body = await adminGrant(http, admin, email);
    if (body['status'] !== 'activated') {
      fail(`grant did not activate ${email}: ${JSON.stringify(body)}`);
    }
  }
}

/** `POST /api/admin/access/revoke {email}` → whether a waiting promise was taken back. */
export async function adminRevoke(http: string, admin: SsoSession, email: string): Promise<boolean> {
  const res = expectStatus(`admin revoke ${email}`, await api(http, admin.cookie, 'POST', '/api/admin/access/revoke', { email }), 200);
  return res.body['removed'] === true;
}

/** Open a socket and resolve once the handshake completes (reject on error). */
export function openSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`handshake ${res.statusCode}`)));
  });
}

/**
 * `/ui` as a signed-in person: the same `cc-remote-auth` cookie the browser
 * carries, sent on the upgrade request (`ui_user` reads it before `?token=`).
 * `workspaceId` selects the team the way the web's `?workspaceId=` does.
 */
export function connectUiAs(wsBase: string, session: SsoSession, workspaceId?: string): Promise<WebSocket> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  return openSocket(`${wsBase}/ui${query}`, { cookie: session.cookie });
}

/** `/agent?token=` — the fleet token or a device token from an enrollment. */
export function connectAgentWs(wsBase: string, token: string): Promise<WebSocket> {
  return openSocket(`${wsBase}/agent?token=${encodeURIComponent(token)}`);
}

type BrowserFrame<T extends CentralToBrowser['type']> = Extract<CentralToBrowser, { type: T }>;
type AgentFrame<T extends CentralToAgent['type']> = Extract<CentralToAgent, { type: T }>;

/**
 * Next hub->browser frame of `type` (optionally passing `pred`), decoded
 * through the real zod schema so a hub payload that drifts from `shared/`
 * fails here rather than silently in the UI. Frames this test does not model
 * are skipped, as the UI skips them.
 */
export function nextBrowserFrame<T extends CentralToBrowser['type']>(
  ws: WebSocket,
  type: T,
  pred: (msg: BrowserFrame<T>) => boolean = () => true,
  timeoutMs = 10_000,
): Promise<BrowserFrame<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timed out waiting for a '${type}' frame from the hub`));
    }, timeoutMs);
    const onMsg = (raw: Buffer) => {
      let msg: CentralToBrowser;
      try {
        msg = decodeCentralToBrowser(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== type) return;
      const narrowed = msg as BrowserFrame<T>;
      if (!pred(narrowed)) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(narrowed);
    };
    ws.on('message', onMsg);
  });
}

/** Next hub->agent frame of `type`, decoded through the agent's own schema. */
export function nextAgentFrame<T extends CentralToAgent['type']>(
  ws: WebSocket,
  type: T,
  timeoutMs = 10_000,
): Promise<AgentFrame<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timed out waiting for a '${type}' frame at the agent`));
    }, timeoutMs);
    const onMsg = (raw: Buffer) => {
      let msg: CentralToAgent;
      try {
        msg = decodeCentralToAgent(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg as AgentFrame<T>);
    };
    ws.on('message', onMsg);
  });
}

/** Type-checked send on a browser socket (everything crossing is BrowserToCentral). */
export function sendUi(ws: WebSocket, msg: BrowserToCentral): void {
  ws.send(JSON.stringify(msg));
}

/** A synthetic dormant session for a fake agent's inventory. */
export function fakeSession(cwd: string, title = path.basename(cwd)): SessionSummary {
  return {
    sessionId: randomUUID(),
    title,
    cwd,
    project: path.basename(cwd),
    lastModified: Date.now(),
    createdAt: Date.now(),
    entrypoint: 'cli',
  };
}

export interface FakeAgent {
  ws: WebSocket;
  machineId: string;
  name: string;
  deviceToken: string;
}

/**
 * Enroll and connect a fake agent the way `agent/src/client.ts` does:
 *   POST /api/enrollments (as `owner`)      -> {code}
 *   POST /api/enrollments/exchange {code, machine} -> {deviceToken}
 *   /agent?token=<deviceToken>  ->  register  ->  inventory (if `sessions`)
 * The machine ends up owned by `owner` as a personal device.
 */
export async function enrollFakeAgent(
  target: SmokeTarget,
  owner: SsoSession,
  opts: { machineId?: string; name?: string; os?: 'mac' | 'windows' | 'linux'; sessions?: SessionSummary[] } = {},
): Promise<FakeAgent> {
  const machineId = opts.machineId ?? `smoke-machine-${randomUUID().slice(0, 8)}`;
  const name = opts.name ?? machineId;
  const enrollment = expectStatus('POST /api/enrollments', await api(target.http, owner.cookie, 'POST', '/api/enrollments'), 201);
  const code = enrollment.body['code'];
  if (typeof code !== 'string' || !code) fail(`enrollment carries no code: ${enrollment.text}`);
  const exchange = expectStatus(
    'POST /api/enrollments/exchange',
    await api(target.http, undefined, 'POST', '/api/enrollments/exchange', {
      code,
      machine: { machineId, name, os: opts.os ?? 'linux', agentVersion: 'smoke' },
    }),
    200,
  );
  const deviceToken = exchange.body['deviceToken'];
  if (typeof deviceToken !== 'string' || !deviceToken) fail(`exchange carries no deviceToken: ${exchange.text}`);
  if (exchange.body['ownerUserId'] !== owner.userId) fail(`device owner drifted: ${String(exchange.body['ownerUserId'])}`);

  const ws = await connectAgentWs(target.ws, deviceToken);
  // `agentInstanceId` is what makes the hub answer with `register_ack` — the
  // precise "you are registered" signal, so the inventory below cannot race it.
  const ack = nextAgentFrame(ws, 'register_ack');
  ws.send(
    JSON.stringify({
      type: 'register',
      protocol: 1,
      machine: { machineId, name, os: opts.os ?? 'linux', agentVersion: 'smoke' },
      agentInstanceId: randomUUID(),
    }),
  );
  await ack;
  if (opts.sessions) {
    ws.send(JSON.stringify({ type: 'inventory', sessions: opts.sessions, complete: true }));
    // The hub loop is serial, so the inventory lands right behind the ack;
    // a short pause lets it be recorded before a snapshot is requested.
    await sleep(300);
  }
  console.log(`  ✓ fake agent ${name} (${machineId}) registered with its device token`);
  return { ws, machineId, name, deviceToken };
}

// ---------------------------------------------------------------------------
// RPC over a /ui socket (files-smoke, projects-smoke, policy-smoke, rpc-smoke,
// fetch-file).
// ---------------------------------------------------------------------------

export interface RpcOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * One RPC over a /ui socket, correlated by requestId; resolves with the hub's
 * answer whether it is ok or an error. Rejects only when no answer comes in
 * `timeoutMs`.
 */
export async function rpc(
  ws: WebSocket,
  machineId: string,
  method: RpcMethod,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<RpcOutcome> {
  const requestId = randomUUID();
  const reply = nextBrowserFrame(ws, 'rpc_response', (m) => m.requestId === requestId, timeoutMs);
  sendUi(ws, { type: 'rpc_request', requestId, machineId, method, params });
  const msg = await reply;
  return { ok: msg.ok, result: msg.result, error: msg.error };
}

/** The outcome's result, or `fail()` naming `what` when the RPC was refused. */
export function mustOk<T>(what: string, outcome: RpcOutcome): T {
  if (!outcome.ok) fail(`${what}: rpc error — ${outcome.error ?? 'unknown'}`);
  return outcome.result as T;
}

// ---------------------------------------------------------------------------
// Browser smokes: one Chrome lookup and one launch, instead of a pinned path
// and a copy of `puppeteer.launch` in every file.
// ---------------------------------------------------------------------------

/** The Chrome the puppeteer cache on the dev box holds; the last resort. */
const CHROME_PINNED = '/root/.cache/puppeteer/chrome/linux-144.0.7559.96/chrome-linux64/chrome';

/**
 * Which Chrome to drive: `$CHROME_PATH`, else the first of the usual places
 * that exists (same lookup as web/scripts/shot.mjs — one machine, one
 * browser), else the pinned puppeteer-cache path so a missing Chrome fails
 * inside puppeteer with its own "not found at <path>" message.
 */
export function chromePath(): string {
  const fromEnv = process.env['CHROME_PATH'];
  if (fromEnv) return fromEnv;
  const candidates = [
    CHROME_PINNED,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => existsSync(p)) ?? CHROME_PINNED;
}

/**
 * Headless Chrome the way every smoke launches it. `args` are appended to the
 * common `--no-sandbox --disable-dev-shm-usage` pair. puppeteer is imported on
 * demand so the many smokes that never touch a browser do not load it.
 */
export async function launchBrowser(opts: { args?: string[] } = {}): Promise<Browser> {
  const { default: puppeteer } = await import('puppeteer-core');
  return puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(opts.args ?? [])],
  });
}

/**
 * `page.evaluate` of a source string. puppeteer types a string evaluation's
 * result as `unknown`; the caller names the shape the page-side expression
 * returns (a smoke's `*_JS` constant) here, once, instead of with an
 * assertion at every call.
 */
export async function evalJs<T>(page: Page, source: string): Promise<T> {
  return (await page.evaluate(source)) as T;
}
