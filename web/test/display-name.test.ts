// A person's label on every team/admin surface goes through `displayName`.
// Accounts without an address exist since the identities migration (a
// Telegram-only sign-in): `.email.slice` in the members list and `undefined`
// in admin prompts were the failure this pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName, viewerName } from '../src/lib.js';

test('displayName: name, then address, then a short id — never undefined', () => {
  assert.equal(displayName({ fullName: '  Данис Латыпов ', email: 'd@x', userId: 'u1' }), 'Данис Латыпов');
  assert.equal(displayName({ email: 'd@x', userId: 'u1' }), 'd@x');
  assert.equal(displayName({ fullName: '   ', userId: 'tg-abcdef123' }), 'Участник tg-abc');
  assert.equal(displayName({}), 'Без имени');
  assert.equal(displayName(null, '—'), '—');
});

test('viewerName survives an account with neither name nor address', () => {
  assert.equal(viewerName({}, 'друг'), 'друг');
  assert.equal(viewerName({ email: 'owner@x.test' }), 'owner');
});
