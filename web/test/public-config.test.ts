import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicConfig } from '@cc-remote/shared';
import { isExternal } from '../src/publicConfig.js';

/**
 * `/api/public-config` is what decides whether a visitor sees the community
 * landing or a customer's own sign-in screen, so its shape — and what «no
 * answer» means — is pinned here.
 */

const base = {
  edition: 'external',
  brandName: 'Acme Code',
  publicUrl: 'https://code.acme.test',
  auth: { local: true, google: false, telegram: false, apple: false, hegaiSso: false },
};

test('oidc is optional and absent, never null', () => {
  assert.equal(PublicConfig.safeParse(base).success, true);
  assert.equal(PublicConfig.safeParse({ ...base, auth: { ...base.auth, oidc: { name: 'Acme SSO' } } }).success, true);
  assert.equal(PublicConfig.safeParse({ ...base, auth: { ...base.auth, oidc: null } }).success, false);
});

test('an unknown edition or a missing flag is refused', () => {
  assert.equal(PublicConfig.safeParse({ ...base, edition: 'enterprise' }).success, false);
  const { local: _local, ...rest } = base.auth;
  assert.equal(PublicConfig.safeParse({ ...base, auth: rest }).success, false);
});

test('only an answered external config switches the UI; no answer is the internal edition', () => {
  assert.equal(isExternal(undefined), false);
  assert.equal(isExternal(null), false);
  assert.equal(isExternal(PublicConfig.parse({ ...base, edition: 'internal' })), false);
  assert.equal(isExternal(PublicConfig.parse(base)), true);
});

test('the sidebar wordmark follows the hub brand name', async () => {
  const { brandWordmark } = await import('../src/publicConfig.js');
  assert.deepEqual(brandWordmark(undefined), { head: 'hegai', tail: 'code' });
  assert.deepEqual(brandWordmark(null), { head: 'hegai', tail: 'code' });
  assert.deepEqual(brandWordmark('  '), { head: 'hegai', tail: 'code' });
  assert.deepEqual(brandWordmark('Hegai Code'), { head: 'hegai', tail: 'code' });
  assert.deepEqual(brandWordmark('Anomaly Code'), { head: 'anomaly', tail: 'code' });
  assert.deepEqual(brandWordmark('clientco.code'), { head: 'clientco', tail: 'code' });
  assert.deepEqual(brandWordmark('AI Surfers Code'), { head: 'aisurfers', tail: 'code' });
  assert.deepEqual(brandWordmark('Acme'), { head: 'Acme' });
  assert.deepEqual(brandWordmark('Code'), { head: 'Code' });
});
