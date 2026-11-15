import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolloutImageTail } from '../src/codex-rollout-tail.js';

const call = (id: string, extra: Record<string, unknown> = {}, record: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type: 'response_item', payload: { type: 'image_generation_call', id, status: 'completed', result: 'AAAA', ...extra }, ...record })}\n`;

function setup(t: TestContext, initial = '') {
  const dir = mkdtempSync(join(tmpdir(), 'ccr-tail-'));
  const file = join(dir, 'rollout.jsonl');
  if (initial !== '') writeFileSync(file, initial);
  const got: string[] = [];
  const tail = new RolloutImageTail({
    resolve: async () => file,
    onCall: (p) => got.push(String(p['id'])),
    intervalMs: 3_600_000, // only drain() reads: deterministic
  });
  t.after(() => { tail.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { file, got, tail };
}

test('tail: a picture appended during the turn is delivered; one already there is not', async (t) => {
  const { file, got, tail } = setup(t, call('ig_old'));
  await tail.begin();
  appendFileSync(file, '{"type":"event_msg","payload":{"type":"agent_message"}}\n');
  appendFileSync(file, call('ig_new'));
  await tail.drain();
  assert.deepEqual(got, ['ig_new']);
  assert.equal(tail.active, false);
});

test('tail: a line written in two chunks is delivered once it is complete', async (t) => {
  const { file, got, tail } = setup(t, '');
  await tail.begin();
  const line = call('ig_split', { result: 'A'.repeat(3 * 1024 * 1024) });
  const cut = Math.floor(line.length / 2);
  appendFileSync(file, line.slice(0, cut));
  await (tail as unknown as { poll(): Promise<void> }).poll();
  assert.deepEqual(got, []);
  appendFileSync(file, line.slice(cut));
  await tail.drain();
  assert.deepEqual(got, ['ig_split']);
});

test('tail: compaction_output records are ignored', async (t) => {
  const { file, got, tail } = setup(t, '');
  await tail.begin();
  appendFileSync(file, call('ig_scratch', {}, { metadata: { compaction_output: true } }));
  appendFileSync(file, call('ig_real'));
  await tail.drain();
  assert.deepEqual(got, ['ig_real']);
});

test('tail: a file that appears only after the turn started is read from its start', async (t) => {
  const { file, got, tail } = setup(t); // no file yet
  await tail.begin();
  writeFileSync(file, call('ig_first'));
  await tail.drain();
  assert.deepEqual(got, ['ig_first']);
});

test('tail: truncation resets to the current size and announces nothing', async (t) => {
  const { file, got, tail } = setup(t, call('ig_old'));
  await tail.begin();
  truncateSync(file, 10);
  await (tail as unknown as { poll(): Promise<void> }).poll();
  appendFileSync(file, '\n' + call('ig_after'));
  await tail.drain();
  assert.deepEqual(got, ['ig_after']);
});

test('tail: unreadable file is retried, not fatal', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ccr-tail-'));
  const file = join(dir, 'later.jsonl');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const got: string[] = [];
  let known = false;
  const tail = new RolloutImageTail({
    resolve: async () => (known ? file : null),
    onCall: (p) => got.push(String(p['id'])),
    intervalMs: 3_600_000,
  });
  await tail.begin();
  await (tail as unknown as { poll(): Promise<void> }).poll(); // nothing resolvable yet
  known = true;
  await (tail as unknown as { poll(): Promise<void> }).poll(); // a tick finds the path (file not on disk yet)
  writeFileSync(file, call('ig_late'));
  await tail.drain();
  assert.deepEqual(got, ['ig_late']);
});
