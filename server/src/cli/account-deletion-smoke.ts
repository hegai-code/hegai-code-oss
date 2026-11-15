/** Local-only real HTTP smoke. Never point account-erasure testing at real users. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api, ssoLogin, adminLogin, adminGrant, randomSmokeUser, sleep } from './_harness.js';

const base = process.argv[2] ?? 'http://127.0.0.1:18841';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'throwaway local hub only');
const secret = process.env['CC_REMOTE_SSO_SECRET'];
assert.ok(secret, 'set the throwaway hub SSO secret');
const admin = await adminLogin(base, secret);
const alice = await ssoLogin(base, secret, randomSmokeUser('erase'));
const bob = await ssoLogin(base, secret, randomSmokeUser('preserve'));
await adminGrant(base, admin, alice.email);
await adminGrant(base, admin, bob.email);
const preview = await api(base, alice.cookie, 'GET', '/api/account/deletion');
assert.equal(preview.status, 200);
assert.equal(preview.body['userId'], alice.userId);
const receipt = randomBytes(32).toString('hex');
const body = { userId: alice.userId, transfers: preview.body['transfers'], confirm: 'DELETE', receipt };
assert.equal((await api(base, bob.cookie, 'POST', '/api/account/deletion', body)).status, 400);
assert.equal((await api(base, alice.cookie, 'POST', '/api/account/deletion', { ...body, confirm: '' })).status, 400);
assert.equal((await api(base, alice.cookie, 'POST', '/api/account/deletion', body, { origin: 'https://foreign.invalid', 'sec-fetch-site': 'cross-site' })).status, 403);
assert.equal((await api(base, undefined, 'POST', '/api/account/deletion/status', { receipt })).status, 404);
assert.equal((await api(base, alice.cookie, 'POST', '/api/account/deletion', body)).status, 202);
assert.equal((await api(base, alice.cookie, 'GET', '/api/me')).status, 401);
assert.equal((await api(base, bob.cookie, 'GET', '/api/me')).status, 200);
let deleted = false;
for (let attempt = 0; attempt < 40; attempt++) {
  const response = await api(base, undefined, 'POST', '/api/account/deletion/status', { receipt });
  assert.equal(response.status, 200);
  if (response.body['status'] === 'deleted') { deleted = true; break; }
  assert.equal(response.body['status'], 'pending');
  await sleep(500);
}
assert.ok(deleted, 'reconciler must finish this account with no hosted data');
assert.equal((await api(base, bob.cookie, 'GET', '/api/me')).body['userId'], bob.userId);
console.log('PASS: exact-account authorization, origin/confirmation guards, immediate revocation, saved receipt recovery and reconciled deletion; other account preserved.');
