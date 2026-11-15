import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileHead, readFileTail, readJsonlLines, readBoundedJsonlLines } from '../src/file-range.js';

test('bounded file readers preserve complete JSONL edges', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-remote-range-'));
  const file = path.join(dir, 'sample.jsonl');
  try {
    await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');
    assert.equal(await readFileHead(file, 5), 'alpha');
    assert.equal(await readFileTail(file, 9), 'gamma\n');
    assert.equal(await readFileTail(file, 12), 'beta\ngamma\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('streamed JSONL preserves giant UTF-8 records and final unterminated lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-jsonl-stream-'));
  const file = path.join(dir, 'large.jsonl');
  try {
    const expected = ['first', 'я'.repeat(3 * 1024 * 1024), 'last'];
    await writeFile(file, expected.join('\r\n'));
    const actual = [];
    for await (const line of readJsonlLines(file)) actual.push(line);
    assert.deepEqual(actual, expected);
    await writeFile(file, '');
    for await (const _ of readJsonlLines(file)) assert.fail('empty file');
    await assert.rejects(async () => {
      for await (const _ of readJsonlLines(path.join(dir, 'missing'))) {}
    }, { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('bounded background reader caps lines across chunks and closes on early return', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bounded-lines-'));
  try {
    const file = path.join(dir, 'records.jsonl');
    await writeFile(file, 'first\n' + 'x'.repeat(150000) + '\nlast');
    let skipped = 0;
    const limits = { maxBytes: 200000, maxLineBytes: 32, onOversizedLine: () => { skipped++; } };
    const lines: string[] = [];
    for await (const line of readBoundedJsonlLines(file, limits)) lines.push(line);
    assert.deepEqual(lines, ['first', 'last']);
    assert.equal(skipped, 1);
    for await (const line of readBoundedJsonlLines(file, limits)) {
      assert.equal(line, 'first');
      break;
    }
    await assert.rejects(async () => {
      for await (const _ of readBoundedJsonlLines(file, { ...limits, maxBytes: 1 })) assert.fail('overlarge file');
    }, /read limit/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
