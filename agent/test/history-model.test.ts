import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord } from '../src/history.js';

const base = { uuid: 'u1', timestamp: '2026-09-27T10:00:00Z' };

test('ответ агента несёт модель, которая его написала', () => {
  const m = parseRecord({ ...base, type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'готово' }] } });
  assert.equal(m?.model, 'claude-opus-5-5');
});

test('<synthetic> и реплика человека модели не несут', () => {
  const s = parseRecord({ ...base, type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'x' }] } });
  assert.equal(s?.model, undefined);
  const u = parseRecord({ ...base, type: 'user', message: { role: 'user', content: 'привет' } });
  assert.equal(u?.model, undefined);
});
