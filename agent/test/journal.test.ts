import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CODEX_TRANSCRIPT_MAX_BYTES, MAX_LINE_BYTES } from '../src/codex.js';
import { consolidate, dayBounds, harvestDay, journalFileFor, parseSections, renderBrief } from '../src/journal.js';

const day = '2026-09-30';
const timestamp = new Date(dayBounds(day).start + 3600000).toISOString();
const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r)).join('\n');

test('harvest mixes runtimes, filters dates/child sessions and deduplicates Codex copies', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'journal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claude = path.join(root, 'claude');
  await mkdir(path.join(claude, 'project'), { recursive: true });
  const record = { type: 'user', sessionId: 'same-id', cwd: '/work/repo', timestamp, message: { content: 'human request' } };
  await writeFile(path.join(claude, 'project', 's.jsonl'), jsonl([record,
    { ...record, isSidechain: true, message: { content: 'child secret' } },
    { ...record, timestamp: new Date(dayBounds(day).end).toISOString(), message: { content: 'tomorrow' } },
    { ...record, type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(100000) },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/work/file.ts' } }] } },
  ]));
  const meta = { type: 'session_meta', payload: { id: 'same-id', cwd: '/work/repo', source: 'cli' } };
  const user = { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex human request' }] } };
  const codex = path.join(root, 'codex.jsonl');
  const child = path.join(root, 'child.jsonl');
  const partial = path.join(root, 'partial.jsonl');
  const older = path.join(root, 'older.jsonl');
  await writeFile(codex, jsonl([meta, user, { ...user, payload: { ...user.payload, content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }] } }]));
  await writeFile(child, jsonl([{ ...meta, payload: { ...meta.payload, id: 'child', source: 'exec' } }, user]));
  await writeFile(partial, jsonl([meta]));
  await writeFile(older, jsonl([meta, user, { ...user, payload: { ...user.payload,
    content: [{ type: 'input_text', text: 'present only in older complete copy' }] } }]));
  const harvest = await harvestDay(day, { claudeProjectsDir: claude, codexFiles: [partial, codex, older, codex, child] });
  assert.equal(harvest.sessions.length, 2);
  assert.deepEqual(harvest.sessions.map(s => s.source).sort(), ['claude', 'codex']);
  assert.deepEqual(harvest.sessions.find(s => s.source === 'codex')?.userTurns, ['Codex human request', 'present only in older complete copy']);
  const brief = renderBrief(harvest);
  assert.ok(brief.includes('Edit×1'));
  assert.ok(brief.includes('file.ts'));
  assert.ok(brief.length < 2000);
  assert.ok(!/child secret|tomorrow|injected/.test(brief));

  const memory = path.join(root, 'memory');
  await mkdir(memory);
  let calls = 0;
  const dependencies = { memoryDir: memory, harvest: async () => harvest, complete: async () => {
    calls++;
    return '<<<JOURNAL>>>\nentry\n<<<STATE>>>\nstate\n<<<END>>>';
  } };
  const opts = { day, home: root };
  await assert.rejects(consolidate(opts, { ...dependencies, complete: async () => 'bad sentinel-secret' }), /invalid journal/);
  await assert.rejects(consolidate(opts, { ...dependencies, complete: async () => { throw new Error('gateway unavailable'); } }), /unavailable/);
  assert.deepEqual(await readdir(memory), []);
  await consolidate({ ...opts, dryRun: true }, dependencies);
  assert.deepEqual(await readdir(memory), []);
  const result = await consolidate(opts, dependencies);
  assert.ok(result.written);
  const contents = await readFile(path.join(memory, journalFileFor(day)), 'utf8');
  assert.ok(contents.includes('## 2026-09-30\n\nentry'));
  assert.equal((await consolidate(opts, dependencies)).skipped, 'already-written');
  assert.equal(calls, 2);
});

test('journal validates calendar dates and the full output contract', () => {
  for (const day of ['../secret', '2026-02-30', '2026-13-01', '2026-1-01']) assert.throws(() => dayBounds(day));
  assert.ok(dayBounds('2024-02-29').end > dayBounds('2024-02-29').start);
  assert.equal(parseSections('prefix <<<JOURNAL>>>a<<<STATE>>>b<<<END>>>'), null);
  assert.equal(parseSections('<<<JOURNAL>>>a<<<STATE>>>b'), null);
  assert.deepEqual(parseSections('<<<JOURNAL>>>a<<<STATE>>>b<<<END>>>'), { journal: 'a', state: 'b' });
});


test('journal skips huge records and files before parsing, and reports the incomplete harvest', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'journal-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout.jsonl');
  const handle = await open(file, 'w');
  try {
    await handle.writeFile(JSON.stringify({ type: 'session_meta', payload: { id: 'bounded', cwd: '/work', source: 'cli' } }) + '\n');
    await handle.writeFile('{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"');
    const block = Buffer.alloc(1024 * 1024, 0x78);
    for (let n = 0; n <= MAX_LINE_BYTES / block.length; n++) await handle.writeFile(block);
    await handle.writeFile('"}]},"timestamp":' + JSON.stringify(timestamp) + '}\n');
    await handle.writeFile(JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'after oversized record' }] } }) + '\n');
  } finally { await handle.close(); }
  const huge = path.join(root, 'too-large.jsonl');
  const sparse = await open(huge, 'w');
  try { await sparse.truncate(CODEX_TRANSCRIPT_MAX_BYTES + 1); } finally { await sparse.close(); }
  const harvest = await harvestDay(day, { claudeProjectsDir: path.join(root, 'absent'), codexFiles: [huge, file] });
  assert.equal(harvest.readWarnings, 2);
  assert.equal(harvest.sessions.length, 1);
  assert.deepEqual(harvest.sessions[0]?.userTurns, ['after oversized record']);
  assert.ok(renderBrief(harvest).includes('бриф неполный'));
});
