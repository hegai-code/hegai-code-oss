import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeActivityFromTail, claudeActivityMs } from '../src/claude-activity.js';

const rec = (o: Record<string, unknown>) => JSON.stringify(o);
let n = 0;
const uuid = () => `u${++n}`;
const user = (ts: string) => rec({ type: 'user', uuid: uuid(), timestamp: ts, message: { role: 'user', content: 'go' } });
const assistant = (ts: string) =>
  rec({ type: 'assistant', uuid: uuid(), timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
const stopHook = (ts: string) => rec({ type: 'system', subtype: 'stop_hook_summary', uuid: uuid(), timestamp: ts });
const compact = (ts: string) => rec({ type: 'system', subtype: 'compact_boundary', uuid: uuid(), timestamp: ts });
const queued = (ts: string) =>
  rec({ type: 'attachment', uuid: uuid(), timestamp: ts, attachment: { type: 'queued_command', prompt: 'ещё одно' } });
const lastPrompt = rec({ type: 'last-prompt', lastPrompt: 'go', sessionId: 's' });
const aiTitle = rec({ type: 'ai-title', aiTitle: 'Иконка PWA', sessionId: 's' });
const latch = rec({ type: 'atis-latch', sessionId: 's' });
const costState = rec({ type: 'cost-state', sessionId: 's', totalCostUSD: 1.66, modelUsage: { 'claude-opus-5-5': { inputTokens: 1 } } });

const exitTs = Date.parse('2026-10-11T17:36:36.264Z'); // the self-update that ended 25 runs
const answered = '2026-10-11T13:02:11.500Z';

test('bookkeeping after the last message does not count as activity', () => {
  const tail = [user('2026-10-11T13:00:00Z'), assistant(answered), stopHook('2026-10-11T13:02:12Z'), lastPrompt, aiTitle, latch, costState];
  assert.equal(claudeActivityFromTail(tail.join('\n') + '\n', exitTs), Date.parse(answered));
});

test('an ordinary session keeps its mtime exactly — the replica compares it', () => {
  assert.equal(claudeActivityFromTail([user('2026-10-11T13:00:00Z'), assistant(answered)].join('\n'), exitTs), exitTs);
});

test('a record mid-write is activity', () => {
  assert.equal(claudeActivityFromTail(`${assistant(answered)}\n${costState}\n{"type":"assist`, exitTs), exitTs);
});

test('rendered non-message records count: a queued prompt, a compaction', () => {
  const q = '2026-10-11T13:05:00Z';
  assert.equal(claudeActivityFromTail([assistant(answered), queued(q), costState].join('\n'), exitTs), Date.parse(q));
  const c = '2026-10-11T13:06:00Z';
  assert.equal(claudeActivityFromTail([assistant(answered), compact(c), lastPrompt].join('\n'), exitTs), Date.parse(c));
});

test('never later than the mtime; no timestamp keeps the mtime; only bookkeeping reads further', () => {
  const future = '2026-10-12T00:00:00Z';
  assert.equal(claudeActivityFromTail([assistant(future), costState].join('\n'), exitTs), exitTs);
  assert.equal(claudeActivityFromTail([rec({ type: 'assistant', uuid: 'x', message: { content: [{ type: 'text', text: 'hi' }] } }), costState].join('\n'), exitTs), exitTs);
  assert.equal(claudeActivityFromTail([lastPrompt, costState].join('\n'), exitTs), undefined);
});

test('a queued prompt stamped at send time does not pull activity back', () => {
  // The prompt was sent at 13:01:55 while the reply was being written; the CLI
  // absorbed it after the reply, so it sits later in the file with an earlier stamp.
  const tail = [assistant('2026-10-11T13:02:00Z'), queued('2026-10-11T13:01:55Z'), lastPrompt, costState];
  assert.equal(claudeActivityFromTail(tail.join('\n'), exitTs), Date.parse('2026-10-11T13:02:00Z'));
});

test('a damaged older line is skipped, not taken for a write in progress', () => {
  const tail = [assistant(answered), '{"type":"user","mess', lastPrompt, costState];
  assert.equal(claudeActivityFromTail(tail.join('\n'), exitTs), Date.parse(answered));
});

test('what history does not render is not activity: CLI injections, empty replies', () => {
  const meta = rec({ type: 'user', uuid: uuid(), isMeta: true, timestamp: '2026-10-11T16:00:00Z', message: { role: 'user', content: 'Base directory for this skill' } });
  const empty = rec({ type: 'assistant', uuid: uuid(), timestamp: '2026-10-11T16:00:01Z', message: { role: 'assistant', content: [] } });
  const hookNote = rec({ type: 'attachment', uuid: uuid(), timestamp: '2026-10-11T16:00:02Z', attachment: { type: 'hook_additional_context', content: 'x' } });
  const tail = [assistant(answered), meta, empty, hookNote, lastPrompt, costState];
  assert.equal(claudeActivityFromTail(tail.join('\n'), exitTs), Date.parse(answered));
});

test('a background task notification counts — it changes a rendered result', () => {
  const notice = '<task-notification><task-id>t1</task-id><tool-use-id>toolu_1</tool-use-id><status>completed</status><result>ok</result></task-notification>';
  const ts = '2026-10-11T14:00:00Z';
  const folded = rec({ type: 'attachment', uuid: uuid(), timestamp: ts, attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notice } });
  assert.equal(claudeActivityFromTail([assistant(answered), folded, costState].join('\n'), exitTs), Date.parse(ts));
  const ts2 = '2026-10-11T14:05:00Z';
  const asUser = rec({ type: 'user', uuid: uuid(), timestamp: ts2, message: { role: 'user', content: notice } });
  assert.equal(claudeActivityFromTail([assistant(answered), asUser, lastPrompt, costState].join('\n'), exitTs), Date.parse(ts2));
});

test('a megabyte of progress is a live run; a huge last-prompt is still bookkeeping', () => {
  const progress = rec({ type: 'progress', data: { type: 'agent_progress', message: 'x'.repeat(200_000) } });
  assert.equal(claudeActivityFromTail([assistant(answered), ...Array(6).fill(progress)].join('\n'), exitTs), exitTs);
  assert.equal(
    claudeActivityFromTail([assistant(answered), ...Array(6).fill(progress), costState].join('\n'), exitTs),
    Date.parse(answered),
    'progress then exit: the run ended, walk through it',
  );
  const hugePrompt = rec({ type: 'last-prompt', lastPrompt: 'x'.repeat(2_000_000) });
  assert.equal(claudeActivityFromTail([assistant(answered), hugePrompt, costState].join('\n'), exitTs), Date.parse(answered));
});

const stamp = async (file: string, ms: number) => utimes(file, new Date(ms), new Date(ms));

test('reads past a long last-prompt and caches by mtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-activity-test-'));
  const file = join(dir, 's.jsonl');
  const longPrompt = rec({ type: 'last-prompt', lastPrompt: 'я'.repeat(40_000) });
  await writeFile(file, [user('2026-10-11T13:00:00Z'), assistant(answered), longPrompt, costState].join('\n') + '\n');
  await stamp(file, exitTs);
  assert.equal(await claudeActivityMs(file, exitTs), Date.parse(answered));
  // A real message appended later moves it; the cache is keyed by mtime.
  const later = Date.parse('2026-10-11T18:00:00Z');
  await appendFile(file, user('2026-10-11T17:59:59Z') + '\n');
  await stamp(file, later);
  assert.equal(await claudeActivityMs(file, later), later);
});

test('a real record bigger than any tail window is still found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-activity-test-'));
  const file = join(dir, 's.jsonl');
  // A pasted screenshot: one user record of ~3 MB, then the exit bookkeeping.
  const shot = rec({ type: 'user', uuid: 'shot', timestamp: answered, message: { role: 'user', content: [{ type: 'image', source: { data: 'A'.repeat(3_000_000) } }] } });
  await writeFile(file, [assistant('2026-10-11T12:00:00Z'), shot, lastPrompt, costState].join('\n') + '\n');
  await stamp(file, exitTs);
  assert.equal(await claudeActivityMs(file, exitTs), Date.parse(answered));
});

test('a file written mid-record keeps its mtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-activity-test-'));
  const file = join(dir, 's.jsonl');
  await writeFile(file, `${assistant(answered)}\n${costState}\n{"type":"assist`);
  await stamp(file, exitTs);
  assert.equal(await claudeActivityMs(file, exitTs), exitTs);
});

test('another copy or a vanished file is not judged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-activity-test-'));
  const file = join(dir, 's.jsonl');
  await writeFile(file, [assistant(answered), costState].join('\n') + '\n');
  await stamp(file, exitTs);
  // The SDK reported a different mtime: this is not the file it looked at.
  assert.equal(await claudeActivityMs(file, exitTs - 60_000), undefined);
  assert.equal(await claudeActivityMs(join(dir, 'gone.jsonl'), 42), undefined);
});
