/**
 * Getting a hub session without a browser.
 *
 * The hub has no bot credential — every identity is a person holding an opaque
 * workspace session (see `server-rs/src/main.rs` `authenticated_user`). So the
 * bot either carries one that was handed to it (`CC_REMOTE_TG_SESSION`) or,
 * running on the hub box where the SSO secret already lives, mints one by
 * driving the same two-request handshake a browser performs. This mirrors
 * `server/src/cli/_harness.ts` — the smokes' path, kept identical on purpose so
 * there is one description of the flow to keep true.
 *
 * Sessions slide their own expiry forward on use, so a bot that stays connected
 * never expires; `reauth()` exists for the case where it does (hub DB reset,
 * revoked session) and is called on a 401 upgrade rather than on a timer.
 */
import { createHmac } from 'node:crypto';

import type { Config } from './config.js';

// An https hub sets these under the `__Host-` prefix and ONLY honours that
// name; a plain-http hub (the bot talking to 127.0.0.1 on the hub box) cannot
// store such a cookie and keeps the bare names. A pre-issued session
// (`CC_REMOTE_TG_SESSION`) goes to the hub as a Bearer, which needs no cookie. Read whichever comes back and send the state back under the name
// it arrived with.
const AUTH_COOKIE = 'cc-remote-auth';
const SSO_STATE_COOKIE = 'cc-remote-sso-state';
const HOST_PREFIX = '__Host-';

export interface HubIdentity {
  session: string;
  userId?: string;
  email?: string;
  fullName?: string;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** HS256 JWT exactly as admin.acme.test mints it for `client=cc-remote`. */
function mintSsoJwt(secret: string, userId: string, email: string): string {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(
    JSON.stringify({
      userId,
      email,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: 'acme.test',
      aud: 'cc-remote',
    }),
  );
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

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

/** Drive `/api/auth/sso/start` → `/api/auth/sso/callback` and keep the cookie. */
export async function mintSession(cfg: Config): Promise<string> {
  const sso = cfg.sso;
  if (!sso) throw new Error('cannot mint a session: no CC_REMOTE_SSO_SECRET identity configured');

  const start = await fetch(`${cfg.http}/api/auth/sso/start`, { redirect: 'manual' });
  if (start.status === 503) {
    throw new Error('hub has no CC_REMOTE_SSO_SECRET (>=32 chars) — SSO is disabled there');
  }
  if (start.status !== 302) throw new Error(`sso/start answered ${start.status}, expected 302`);

  const stateCookie = cookieEither(start.headers, SSO_STATE_COOKIE);
  const location = start.headers.get('location') ?? '';
  const state = location ? new URL(location).searchParams.get('state') : null;
  if (!stateCookie || !state) throw new Error('sso/start did not hand back a usable state');

  const token = mintSsoJwt(sso.secret, sso.userId, sso.email);
  const callback = await fetch(
    `${cfg.http}/api/auth/sso/callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: { cookie: `${stateCookie.name}=${stateCookie.value}` } },
  );
  if (callback.status !== 302) {
    throw new Error(
      `sso/callback answered ${callback.status} — wrong CC_REMOTE_SSO_SECRET? ${(await callback.text()).slice(0, 200)}`,
    );
  }
  const session = cookieEither(callback.headers, AUTH_COOKIE)?.value;
  if (!session) throw new Error('sso/callback did not set the auth cookie');
  return session;
}

/** Confirm a session is live and learn who it is. `undefined` = not usable. */
export async function whoami(cfg: Config, session: string): Promise<HubIdentity | undefined> {
  const res = await fetch(`${cfg.http}/api/me`, {
    headers: { authorization: `Bearer ${session}`, 'sec-fetch-site': 'same-origin' },
  });
  if (!res.ok) return undefined;
  const body = (await res.json().catch(() => ({}))) as {
    userId?: string;
    email?: string;
    fullName?: string;
  };
  return { session, userId: body.userId, email: body.email, fullName: body.fullName };
}

/**
 * The session to use, in preference order: the configured one, the one cached
 * from a previous run, then a freshly minted one. Anything that fails `/api/me`
 * is discarded rather than carried forward into a confusing 401 on the socket.
 */
export async function resolveSession(
  cfg: Config,
  cached: string | undefined,
): Promise<HubIdentity> {
  const candidates = [cfg.session, cached].filter((s): s is string => !!s);
  for (const candidate of candidates) {
    const who = await whoami(cfg, candidate);
    if (who) return who;
    console.warn('[auth] a stored session is no longer valid; discarding it');
  }
  if (!cfg.sso) {
    throw new Error(
      'CC_REMOTE_TG_SESSION is not accepted by the hub and there is no SSO secret to mint a new one',
    );
  }
  const minted = await mintSession(cfg);
  const who = await whoami(cfg, minted);
  if (!who) throw new Error('minted a session the hub then refused — check the hub logs');
  return who;
}
