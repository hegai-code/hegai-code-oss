import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserCommandResponse, BrowserInfo, BrowserProfile, BrowserStatus } from '../src/browser.js';

test('browser contract accepts the real shapes and rejects drift', () => {
  assert.ok(BrowserInfo.safeParse({ enabled: true, egress: false, down: true }).success);
  assert.ok(BrowserInfo.safeParse({ enabled: true, egress: true }).success);
  assert.ok(!BrowserInfo.safeParse({ enabled: true }).success);
  const p = { id: 'abcdef0123456789', name: 'x', created_at: 1, last_used_at: 2, running: false };
  assert.ok(BrowserProfile.safeParse(p).success);
  assert.ok(!BrowserProfile.safeParse({ ...p, id: 'ABC' }).success);
  assert.ok(BrowserStatus.safeParse({ url: '', title: '', tabs: [], egress_ok: true }).success);
  assert.ok(!BrowserStatus.safeParse({ url: '', title: '', tabs: [] }).success);
  assert.ok(BrowserCommandResponse.safeParse({ ok: true, result: null }).success);
  assert.ok(BrowserCommandResponse.safeParse({ ok: false, error: 'e' }).success);
  assert.ok(!BrowserCommandResponse.safeParse({ ok: false }).success);
});
