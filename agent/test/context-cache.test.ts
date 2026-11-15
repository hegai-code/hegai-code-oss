import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentToCentral } from '@cc-remote/shared';
import { ContextCache } from '../src/context-cache.js';

type Ctx = Extract<AgentToCentral, { type: 'context_usage' }>;
const frame = (runId: string, totalTokens: number, extra: Partial<Ctx> = {}): Ctx => ({
  type: 'context_usage',
  runId,
  sessionId: 's',
  totalTokens,
  maxTokens: 200_000,
  percentage: 1,
  autoCompactEnabled: true,
  ...extra,
});

test('an unchanged reading is not sent twice; a changed one is', () => {
  const cache = new ContextCache();
  const sent: Ctx[] = [];
  const send = (f: Ctx) => (sent.push(f), true);
  assert.equal(cache.sendIfChanged(frame('r', 10), send), true);
  assert.equal(cache.sendIfChanged(frame('r', 10), send), false);
  assert.equal(cache.sendIfChanged(frame('r', 11), send), true);
  assert.equal(cache.sendIfChanged(frame('r', 11, { autoCompactThreshold: 5 }), send), true);
  assert.equal(sent.length, 3);
});

test('runs are cached separately', () => {
  const cache = new ContextCache();
  let n = 0;
  const send = () => (n++, true);
  cache.sendIfChanged(frame('a', 1), send);
  cache.sendIfChanged(frame('b', 1), send);
  assert.equal(n, 2);
});

test('clear (reconnect) makes the next poll resend everything', () => {
  const cache = new ContextCache();
  let n = 0;
  const send = () => (n++, true);
  cache.sendIfChanged(frame('r', 1), send);
  cache.clear();
  cache.sendIfChanged(frame('r', 1), send);
  assert.equal(n, 2);
});

test('a frame the link refused is not remembered, so it is retried', () => {
  const cache = new ContextCache();
  assert.equal(cache.sendIfChanged(frame('r', 1), () => false), false);
  let n = 0;
  cache.sendIfChanged(frame('r', 1), () => (n++, true));
  assert.equal(n, 1);
});

test('prune forgets runs that are gone', () => {
  const cache = new ContextCache();
  let n = 0;
  const send = () => (n++, true);
  cache.sendIfChanged(frame('gone', 1), send);
  cache.prune(['other']);
  cache.sendIfChanged(frame('gone', 1), send);
  assert.equal(n, 2);
});
