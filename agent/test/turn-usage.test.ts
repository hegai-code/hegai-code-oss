import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTurnUsage, CodexTurnUsage } from '../src/turn-usage.js';

test('Claude counts cache once, replaces repeated message snapshots and resets each turn', () => {
  const meter = new ClaudeTurnUsage();
  const message = { id: 'm1', usage: { input_tokens: 20, output_tokens: 10,
    cache_read_input_tokens: 1000, cache_creation_input_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: 200 } } };
  assert.equal(meter.receive(message), 1230);
  assert.equal(meter.receive(message), 1230);
  assert.equal(meter.receive({ ...message, usage: { ...message.usage, output_tokens: 30 } }), 1250);
  assert.equal(meter.receive({ id: 'm2', usage: { input_tokens: 50, output_tokens: 10 } }), 1310);
  assert.equal(meter.receive({ id: 'bad', usage: { input_tokens: -10, output_tokens: 1 } }), undefined);
  meter.reset();
  assert.equal(meter.receive(message), 1230);
});

test('Codex excludes lifetime usage and does not double count cache/reasoning', () => {
  const meter = new CodexTurnUsage();
  const usage = (total: number, last: number) => ({ total: { totalTokens: total, cachedInputTokens: 20, reasoningOutputTokens: 30 }, last: { totalTokens: last } });
  meter.reset();
  assert.equal(meter.receive(usage(10000, 100)), 100);
  assert.equal(meter.receive(usage(10000, 100)), 100);
  assert.equal(meter.receive(usage(10400, 400)), 500);
  meter.reset();
  assert.equal(meter.receive(usage(10700, 300)), 300);
  meter.reset(); // compaction can reset lifetime usage
  assert.equal(meter.receive(usage(200, 50)), 50);
  assert.equal(meter.receive({ total: { totalTokens: -10 } }), undefined);
});
