import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppRedirect, nativeHandoffFields, nativeQuery, nativeStartHref, parseNativeSignIn } from '../src/nativeSignIn.js';

/**
 * The query the apps already send to /api/auth/google/start must reach the
 * hub's provider links and the local hand-off unchanged, and the page must
 * navigate only to an app scheme.
 */
const challenge = 'A'.repeat(43);
const state = 'b'.repeat(40);

test('iOS asks with native=1', () => {
  const n = parseNativeSignIn('?native=1');
  assert.deepEqual(n, { mode: 'ios' });
  assert.equal(nativeStartHref('oidc', n!), '/api/auth/oidc/start?native=1');
  assert.equal(nativeStartHref('github', n!), '/api/auth/github/start?native=1');
  assert.deepEqual(nativeHandoffFields(n!), { native: true });
});

test('Android carries its PKCE challenge and state through', () => {
  const n = parseNativeSignIn(`?android=1&code_challenge=${challenge}&client_state=${state}`);
  assert.deepEqual(n, { mode: 'android', codeChallenge: challenge, clientState: state });
  assert.equal(nativeStartHref('google', n!), `/api/auth/google/start?android=1&code_challenge=${challenge}&client_state=${state}`);
  assert.equal(nativeQuery(n!), `android=1&code_challenge=${challenge}&client_state=${state}`);
  assert.deepEqual(nativeHandoffFields(n!), { android: true, code_challenge: challenge, client_state: state });
});

test('a page opened by hand, or with parameters the hub would refuse, is not a request', () => {
  assert.equal(parseNativeSignIn(''), null);
  assert.equal(parseNativeSignIn('?android=1'), null);
  assert.equal(parseNativeSignIn(`?android=1&code_challenge=short&client_state=${state}`), null);
  assert.equal(parseNativeSignIn(`?android=1&code_challenge=${challenge}&client_state=bad state!`), null);
  assert.equal(parseNativeSignIn(`?android=1&native=1&code_challenge=${challenge}&client_state=${state}`), null);
});

test('only the apps\' own schemes are navigated to', () => {
  assert.equal(isAppRedirect('ccremote://auth?session=abc'), true);
  assert.equal(isAppRedirect(`hegai-code://auth?code=${'a'.repeat(64)}&state=${state}`), true);
  assert.equal(isAppRedirect('https://evil.example/?session=abc'), false);
  assert.equal(isAppRedirect('javascript:alert(1)'), false);
  assert.equal(isAppRedirect(undefined), false);
});
