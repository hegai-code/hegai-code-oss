import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProbePrompt } from '../src/probe-prompt.js';
import { parseCodexRolloutHead } from '../src/codex.js';

test('a scripted check is caught anywhere in the first prompt', () => {
  assert.ok(isProbePrompt('Проверка выбора модели после правки. Ответь одним словом: ок'));
  assert.ok(isProbePrompt('Проверка выбора модели, третья попытка. Ответь одним словом: ок'));
  assert.ok(isProbePrompt('Smoke. Reply with the single word ok'));
  assert.ok(!isProbePrompt('Проверка выбора модели в композере — почему Sonnet?'));
  assert.ok(!isProbePrompt(undefined));
});

test('a Codex rollout with a probe prompt is marked automated', () => {
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/p' } });
  const user = (text: string) =>
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  assert.equal(parseCodexRolloutHead([meta, user('Проверка. Ответь одним словом: ок')].join('\n'), 1)?.automated, true);
  assert.equal(parseCodexRolloutHead([meta, user('настоящая задача')].join('\n'), 1)?.automated, undefined);
});
