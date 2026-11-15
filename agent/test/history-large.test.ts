import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeHistory } from '../src/history.js';

test('Claude history preserves old speech across huge tool records, with a bounded message window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-history-large-'));
  const file = join(dir, 'session.jsonl');
  const rows = [
    { type: 'user', uuid: 'old-u', message: { content: 'Старый вопрос' } },
    { type: 'assistant', uuid: 'old-a', message: { content: 'Старый ответ' } },
    { type: 'user', uuid: 'large', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(5 * 1024 * 1024) }] } },
    { type: 'assistant', uuid: 'new-a', message: { content: 'Новый ответ' } },
  ];
  try {
    await writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n{partial');
    const all = await readClaudeHistory(file, 1000, 1000);
    assert.deepEqual(all.map(m => m.uuid), ['old-u', 'old-a', 'large', 'new-a']);
    assert.ok(JSON.stringify(all).length < 2000);
    assert.deepEqual((await readClaudeHistory(file, 2, 1000)).map(m => m.uuid), ['large', 'new-a']);
    await assert.rejects(readClaudeHistory(join(dir, 'missing'), 1000), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
