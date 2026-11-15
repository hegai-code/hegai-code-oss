/** Local-only PKCE HTTP smoke. Start a throwaway Rust hub with the same SSO secret. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mintSsoJwt, randomSmokeUser } from './_harness.js';

const base = process.argv[2] ?? 'http://127.0.0.1:14319';
assert.equal(new URL(base).hostname, '127.0.0.1', 'This smoke creates synthetic users on a local hub only');
const secret = process.env['CC_REMOTE_SSO_SECRET'];
assert.ok(secret && secret.length >= 32);
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const startPath = `/api/auth/sso/start?android=1&code_challenge=${challenge}&client_state=${state}`;
const start = await fetch(base + startPath, { redirect: 'manual' });
assert.equal(start.status, 302);
const serverState = new URL(start.headers.get('location')!).searchParams.get('state')!;
const user = randomSmokeUser('android', 'Android Smoke');
const jwt = mintSsoJwt(secret, user);
const callback = await fetch(`${base}/api/auth/sso/callback?state=${serverState}&token=${jwt}`, { redirect: 'manual' });
assert.equal(callback.status, 302);
const handoff = new URL(callback.headers.get('location')!);
assert.equal(handoff.protocol, 'hegai-code:');
assert.equal(handoff.searchParams.get('state'), state);
assert.equal(handoff.searchParams.has('session'), false);
assert.equal(callback.headers.get('cache-control'), 'no-store');
const code = handoff.searchParams.get('code')!;
async function exchange(codeVerifier: string) {
  return fetch(`${base}/api/auth/android/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: codeVerifier }) });
}
assert.equal((await exchange('z'.repeat(43))).status, 401);
const good = await exchange(verifier);
assert.equal(good.status, 200);
assert.equal(good.headers.get('cache-control'), 'no-store');
const { session } = await good.json() as { session: string };
const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${session}` } });
assert.equal(me.status, 200);
const identity = await me.json() as { userId?: string; viewer?: { userId: string } };
assert.equal(identity.userId ?? identity.viewer?.userId, user.userId);
assert.equal((await exchange(verifier)).status, 401);
assert.equal((await fetch(base + startPath + '&native=1', { redirect: 'manual' })).status, 400);
assert.equal((await fetch(`${base}/api/auth/android/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: 'a'.repeat(5000) }) })).status, 413);
for (let i = 0; i < 12; i++) assert.equal((await fetch(base + startPath, { redirect: 'manual' })).status, 302);
assert.equal((await fetch(base + startPath, { redirect: 'manual' })).status, 400);
console.log('Android PKCE: HTTP handoff, identity, wrong verifier, single use, body bound, conflicting modes and source limit passed');
