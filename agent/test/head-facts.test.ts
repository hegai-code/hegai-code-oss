import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHeadFacts } from '../src/sessions.js';

// Shape of a real `claude -p` transcript (CLI 2.1.318): the prompt comes twice,
// in `queue-operation` and in the first record, whose `entrypoint` follows it.
function transcript(promptChars: number, extra: object = {}): string {
  const prompt = 'Технический специалист '.repeat(Math.ceil(promptChars / 23)).slice(0, promptChars);
  return [
    { type: 'session-owner', sessionId: 's' },
    { type: 'queue-operation', operation: 'enqueue', content: prompt, sessionId: 's' },
    { type: 'queue-operation', operation: 'dequeue', sessionId: 's' },
    { type: 'user', message: { role: 'user', content: prompt }, isSidechain: false, entrypoint: 'sdk-cli', ...extra },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');
}

function withFile(content: string, check: (file: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'head-facts-'));
    try {
      const file = path.join(dir, 's.jsonl');
      writeFileSync(file, content);
      await check(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  'a short prompt keeps its mark',
  withFile(transcript(1_000), async (file) => {
    assert.equal((await readHeadFacts(file)).entrypoint, 'sdk-cli');
  }),
);

test(
  'a cron prompt that pushes the first record past 64 KB keeps its mark',
  withFile(transcript(23_000), async (file) => {
    assert.ok(Buffer.byteLength(transcript(23_000)) > 64 * 1024, 'the fixture must cross the first read');
    assert.equal((await readHeadFacts(file)).entrypoint, 'sdk-cli');
  }),
);

test(
  'a background session past 64 KB is still recognised',
  withFile(transcript(23_000, { entrypoint: 'cli', sessionKind: 'bg' }), async (file) => {
    const facts = await readHeadFacts(file);
    assert.equal(facts.entrypoint, 'cli');
    assert.equal(facts.background, true);
  }),
);

test(
  'a first record larger than the longest read stays unmarked instead of failing',
  withFile(transcript(1_500_000), async (file) => {
    assert.equal((await readHeadFacts(file)).entrypoint, undefined);
  }),
);
