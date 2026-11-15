import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claudeTitleIsDerived } from '../src/claude-title.js';

function transcript(name: string, ...records: unknown[]): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'claude-title-')), `${name}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('no title at all is derived', async () => {
  assert.equal(await claudeTitleIsDerived(undefined, undefined, 1), true);
});

test('the CLI ai-title, which the SDK reports as customTitle, is derived', async () => {
  const file = transcript('ai', { type: 'ai-title', aiTitle: 'Вопрос о новости' });
  assert.equal(await claudeTitleIsDerived('Вопрос о новости', file, 1), true);
});

test('a rename is not derived, whatever follows it', async () => {
  const file = transcript(
    'renamed',
    { type: 'ai-title', aiTitle: 'Вопрос о новости' },
    { type: 'custom-title', customTitle: 'Моё имя' },
    { type: 'ai-title', aiTitle: 'Вопрос о новости' },
  );
  assert.equal(await claudeTitleIsDerived('Моё имя', file, 1), false);
});

test('the word customTitle inside a tool result is not a rename', async () => {
  const file = transcript(
    'quoted',
    { type: 'ai-title', aiTitle: 'Разбор' },
    { type: 'user', text: JSON.stringify({ customTitle: 'из вывода команды' }) },
  );
  assert.equal(await claudeTitleIsDerived('Разбор', file, 1), true);
});

test('a customTitle key in a tool input is not a rename', async () => {
  const file = transcript(
    'tool-input',
    { type: 'ai-title', aiTitle: 'Разбор' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { customTitle: 'x' } }] } },
  );
  assert.equal(await claudeTitleIsDerived('Разбор', file, 1), true);
});

test('a title with an unreadable transcript is left alone', async () => {
  assert.equal(await claudeTitleIsDerived('Имя', '/nonexistent/x.jsonl', 1), false);
  assert.equal(await claudeTitleIsDerived('Имя', undefined, 1), false);
});

test('a rename after the cached mtime is seen', async () => {
  const file = transcript('later', { type: 'ai-title', aiTitle: 'Разбор' });
  assert.equal(await claudeTitleIsDerived('Разбор', file, 1), true);
  writeFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Новое' }) + '\n');
  assert.equal(await claudeTitleIsDerived('Новое', file, 2), false);
});
