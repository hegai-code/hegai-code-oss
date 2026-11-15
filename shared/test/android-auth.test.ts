import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AndroidCodeExchange, AndroidSignInStart } from '../src/android-auth.js';
import { BrowserToCentral } from '../src/web-protocol.js';

test('Android uses S256-sized URL-safe challenge and a bounded verifier', () => {
  assert.equal(AndroidSignInStart.safeParse({ android: '1', code_challenge: 'a'.repeat(43), client_state: 'b'.repeat(43) }).success, true);
  assert.equal(AndroidSignInStart.safeParse({ android: '1', code_challenge: 'plain', client_state: 'short' }).success, false);
  assert.equal(AndroidCodeExchange.safeParse({ code: 'a'.repeat(64), code_verifier: 'x'.repeat(42) }).success, false);
});
test('mobile push keeps iOS compatibility and identifies Android independently', () => {
  for (const platform of ['ios', 'android']) {
    assert.equal(BrowserToCentral.safeParse({ type: 'register_push', deviceToken: 'test', platform }).success, true);
    assert.equal(BrowserToCentral.safeParse({ type: 'unregister_push', deviceToken: 'test', platform }).success, true);
  }
  assert.equal(BrowserToCentral.safeParse({ type: 'unregister_push', deviceToken: 'test' }).success, true);
  assert.equal(BrowserToCentral.safeParse({ type: 'register_push', deviceToken: 'test', platform: 'unknown' }).success, false);
});
