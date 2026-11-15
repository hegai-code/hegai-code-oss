/**
 * Second-factor smoke: a first factor alone (an SSO token minted with the
 * shared secret) must not give a platform admin a working hub session.
 *
 *   1. The admin signs in through SSO: the session is PENDING — `/api/me` and
 *      the `/ui` upgrade are refused, `/api/auth/mfa/state` says `blocked`, and
 *      enrolling from it is refused too.
 *   2. A 2 h tool session may not enrol; the operator's one-time link
 *      (`mfa-enroll-link`) opens a `tool:enrol` session that does (begin ->
 *      secret, confirm with a code -> recovery codes); `/api/me` answers,
 *      `/ui` opens. Enrolling demotes the person's other sessions.
 *   3. A second SSO sign-in is pending again (`verify`); a wrong code is
 *      refused and changes nothing; the right one opens THAT session; another
 *      pending one opens with a recovery code, and only once.
 *   4. A member (not an admin, no authenticator) is not asked for anything.
 *   5. The admin cannot turn the factor off while the hub requires it.
 *
 * Start a LOCAL hub with the flag, SSO and a fresh database. Not the dev token:
 * on `dev-token` every anonymous request is the owner and nothing is refused.
 *
 *   CC_REMOTE_TOKEN=smoke-fleet-token-0123456789 \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_ADMIN_MFA=required CC_REMOTE_PLATFORM_ADMIN_IDS=legacy-owner \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4398 PORT=4398 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-mfa.sqlite3 \
 *   cargo run --manifest-path server-rs/Cargo.toml
 *
 * Then, with the SAME secrets: `CC_REMOTE_SSO_SECRET=<same> CC_REMOTE_TOKEN=<same>
 * CC_REMOTE_DB_PATH=<the hub's> tsx server/src/cli/mfa-smoke.ts ws://127.0.0.1:4398`
 * (`CC_REMOTE_SERVER_BIN` defaults to the debug binary).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { adminActivate, api, connectUiAs, expectStatus, fail, randomSmokeUser, smokeTarget, ssoLogin, step } from './_harness.js';

const target = smokeTarget(process.argv);
if (!target.ssoSecret || target.ssoSecret.length < 32) fail('CC_REMOTE_SSO_SECRET (>=32 chars) must match the hub');
if (target.token === 'dev-token') fail('start the hub with a real CC_REMOTE_TOKEN: on dev-token every request is the owner');
const secret = target.ssoSecret;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secretB32: string, atSecs: number): string {
  let bits = '';
  for (const c of secretB32.replace(/[ =-]/g, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atSecs / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

/** The upgrade's HTTP status when the hub refuses `/ui`, or 101 when it opens. */
function uiUpgradeStatus(cookie: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${target.ws}/ui`, { headers: { cookie } });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => undefined);
  });
}

const adminId = process.env['CC_SMOKE_ADMIN_ID'] ?? 'legacy-owner';
const adminEmail = process.env['CC_SMOKE_ADMIN_EMAIL'] ?? 'owner@localhost';
const adminClaims = { userId: adminId, email: adminEmail };

async function main(): Promise<void> {
  step('SSO sign-in of the admin is pending, and may not enrol');
  const first = await ssoLogin(target.http, secret, adminClaims);
  expectStatus('/api/me with a pending session', await api(target.http, first.cookie, 'GET', '/api/me'), 401);
  const state = expectStatus('mfa state', await api(target.http, first.cookie, 'GET', '/api/auth/mfa/state'), 200);
  assert.equal(state.body['mfa'], 'blocked');
  assert.equal(await uiUpgradeStatus(first.cookie), 401, '/ui must refuse a pending session');
  console.log('  ✓ /ui upgrade refused (401)');
  expectStatus('pending begin refused', await api(target.http, first.cookie, 'POST', '/api/auth/totp/begin', {}), 403);

  step('the admin enrols only through the operator link (mfa-enroll-link)');
  const dbPath = process.env['CC_REMOTE_DB_PATH'];
  if (!dbPath) fail('set CC_REMOTE_DB_PATH to the throwaway hub database and CC_REMOTE_SERVER_BIN to its binary');
  const bin = process.env['CC_REMOTE_SERVER_BIN'] ?? 'server-rs/target/debug/cc-remote-server';
  const cli = (...args: string[]) =>
    execFileSync(bin, args, { env: { ...process.env, CC_REMOTE_DB_PATH: dbPath, CC_REMOTE_PUBLIC_URL: target.http } }).toString().trim();
  // A 2 h tool session (term.sh's kind) must NOT enrol.
  const termToken = cli('mint-tool-session', '--user', adminId, '--ttl', '10m', '--note', 'term-sh');
  expectStatus('a term-sh tool session may not enrol', await api(target.http, `cc-remote-auth=${termToken}`, 'POST', '/api/auth/totp/begin', {}), 403);
  const url = cli('mfa-enroll-link', '--email', adminEmail);
  const linkToken = url.split('#token=')[1];
  assert.ok(linkToken, `unexpected link: ${url}`);
  const opened = await fetch(`${target.http}/api/auth/mfa/enroll-link/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ token: linkToken }),
  });
  assert.equal(opened.status, 200);
  const setCookie = opened.headers.get('set-cookie') ?? '';
  const enrolToken = /cc-remote-auth=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(enrolToken, 'the link must set the session cookie');
  const tool = { userId: adminId, email: adminEmail, session: enrolToken, cookie: `cc-remote-auth=${enrolToken}` };
  const again = await fetch(`${target.http}/api/auth/mfa/enroll-link/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ token: linkToken }),
  });
  assert.equal(again.status, 410, 'the link is single use');
  const begun = expectStatus('totp begin', await api(target.http, tool.cookie, 'POST', '/api/auth/totp/begin', {}), 200);
  const key = String(begun.body['secret']);
  assert.ok(String(begun.body['otpauthUri']).startsWith('otpauth://totp/'));
  const now = Math.floor(Date.now() / 1000);
  expectStatus('confirm with a wrong code', await api(target.http, tool.cookie, 'POST', '/api/auth/totp/confirm', { code: '000000' }), 400);
  const done = expectStatus('confirm', await api(target.http, tool.cookie, 'POST', '/api/auth/totp/confirm', { code: totp(key, now) }), 200);
  const recovery = done.body['recoveryCodes'] as string[];
  assert.equal(recovery.length, 10);
  expectStatus('/api/me with the enrolment session', await api(target.http, tool.cookie, 'GET', '/api/me'), 200);
  assert.equal(await uiUpgradeStatus(tool.cookie), 101, '/ui must open for the enrolment session');
  const live = await connectUiAs(target.ws, tool);
  live.close();
  console.log('  ✓ /ui opens');

  step('enrolling demotes the person\'s other sessions');
  const m1 = await ssoLogin(target.http, secret, randomSmokeUser('mfa-demote'));
  const m2 = await ssoLogin(target.http, secret, { userId: m1.userId, email: m1.email });
  // Sign-ups wait for activation; the admin's enrolment session (satisfied) opens the door.
  await adminActivate(target.http, tool, [m1.email]);
  expectStatus('member session 2 works', await api(target.http, m2.cookie, 'GET', '/api/me'), 200);
  const mb = expectStatus('member begin', await api(target.http, m1.cookie, 'POST', '/api/auth/totp/begin', {}), 200);
  expectStatus('member confirm', await api(target.http, m1.cookie, 'POST', '/api/auth/totp/confirm', { code: totp(String(mb.body['secret']), Math.floor(Date.now() / 1000)) }), 200);
  expectStatus('member session 1 still works', await api(target.http, m1.cookie, 'GET', '/api/me'), 200);
  expectStatus('member session 2 now owes the code', await api(target.http, m2.cookie, 'GET', '/api/me'), 401);

  step('a later sign-in owes the code; verify opens only its own session');
  const a = await ssoLogin(target.http, secret, adminClaims);
  const b = await ssoLogin(target.http, secret, adminClaims);
  assert.equal((await api(target.http, a.cookie, 'GET', '/api/auth/mfa/state')).body['mfa'], 'verify');
  expectStatus('/api/me pending', await api(target.http, a.cookie, 'GET', '/api/me'), 401);
  assert.equal(await uiUpgradeStatus(a.cookie), 401);
  expectStatus('wrong code', await api(target.http, a.cookie, 'POST', '/api/auth/mfa/verify', { code: '000000' }), 400);
  expectStatus('/api/me still pending', await api(target.http, a.cookie, 'GET', '/api/me'), 401);
  // The confirming step is spent (replay guard): the next one is accepted.
  expectStatus('right code', await api(target.http, a.cookie, 'POST', '/api/auth/mfa/verify', { code: totp(key, now + 30) }), 200);
  expectStatus('/api/me after verify', await api(target.http, a.cookie, 'GET', '/api/me'), 200);
  assert.equal(await uiUpgradeStatus(a.cookie), 101);
  expectStatus('the OTHER pending session stays pending', await api(target.http, b.cookie, 'GET', '/api/me'), 401);
  expectStatus('recovery code', await api(target.http, b.cookie, 'POST', '/api/auth/mfa/verify', { code: recovery[0]! }), 200);
  expectStatus('/api/me via recovery', await api(target.http, b.cookie, 'GET', '/api/me'), 200);
  const c = await ssoLogin(target.http, secret, adminClaims);
  expectStatus('a spent recovery code', await api(target.http, c.cookie, 'POST', '/api/auth/mfa/verify', { code: recovery[0]! }), 400);

  step('a member with no authenticator is not asked');
  const member = await ssoLogin(target.http, secret, randomSmokeUser('mfa-member'));
  expectStatus('member /api/me', await api(target.http, member.cookie, 'GET', '/api/me'), 200);
  assert.equal((await api(target.http, member.cookie, 'GET', '/api/auth/mfa/state')).body['mfa'], 'none');

  step('the admin cannot turn it off while the hub requires it');
  expectStatus('disable', await api(target.http, a.cookie, 'POST', '/api/auth/totp/disable', { code: totp(key, now + 60) }), 403);

  console.log('\nmfa-smoke: OK');
}

main().then(
  () => process.exit(0),
  (err) => fail(String(err instanceof Error ? err.stack : err)),
);
