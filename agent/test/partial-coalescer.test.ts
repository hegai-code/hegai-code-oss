import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentToCentral } from '@cc-remote/shared';
import { PartialCoalescer } from '../src/partial-coalescer.js';

const partial = (text: string, runId = 'r1', sessionId = 's1'): AgentToCentral => ({
  type: 'stream',
  sessionId,
  runId,
  event: { kind: 'partial', text },
});
const stream = (kind: 'assistant' | 'tool_use' | 'status' | 'result' | 'error', text = '', runId = 'r1'): AgentToCentral => ({
  type: 'stream',
  sessionId: 's1',
  runId,
  event: { kind, text },
});

function harness(opts?: { delayMs?: number; maxChars?: number }, accept = true) {
  const out: AgentToCentral[] = [];
  const c = new PartialCoalescer((m) => {
    out.push(m);
    return accept;
  }, opts);
  return { c, out };
}
const kinds = (out: AgentToCentral[]) =>
  out.map((m) => (m.type === 'stream' ? `${m.event.kind}:${m.event.text}` : m.type));

test('adjacent deltas become one partial frame after the delay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, out } = harness({ delayMs: 75 });
  c.send(partial('Hel'));
  c.send(partial('lo, '));
  c.send(partial('world'));
  assert.equal(out.length, 0);
  t.mock.timers.tick(74);
  assert.equal(out.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(kinds(out), ['partial:Hello, world']);
  assert.equal(c.pending, 0);
});

test('the delay is a bound from the first delta, not a debounce', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, out } = harness({ delayMs: 75 });
  c.send(partial('a'));
  t.mock.timers.tick(50);
  c.send(partial('b'));
  t.mock.timers.tick(25);
  assert.deepEqual(kinds(out), ['partial:ab']);
});

test('every other event of the run flushes the buffer first — wire order is unchanged', () => {
  const { c, out } = harness();
  c.send(partial('one '));
  c.send(partial('two'));
  c.send(stream('tool_use', 'Bash {}'));
  c.send(partial('three'));
  c.send({ type: 'run_status', sessionId: 's1', runId: 'r1', state: 'idle' });
  c.send(partial('four'));
  c.send(stream('result', 'done'));
  c.send(partial('five'));
  c.send(stream('assistant', 'five'));
  c.send(partial('six'));
  c.send(stream('error', 'boom'));
  assert.deepEqual(kinds(out), [
    'partial:one two',
    'tool_use:Bash {}',
    'partial:three',
    'run_status',
    'partial:four',
    'result:done',
    'partial:five',
    'assistant:five',
    'partial:six',
    'error:boom',
  ]);
  assert.equal(c.pending, 0);
});

test('a partial with a code or data is not a delta and passes through in order', () => {
  const { c, out } = harness();
  c.send(partial('a'));
  c.send({ type: 'stream', sessionId: 's1', runId: 'r1', event: { kind: 'partial', text: 'x', code: 'c' } });
  assert.equal(out.length, 2);
  assert.deepEqual(kinds(out), ['partial:a', 'partial:x']);
});

test('runs are independent: another run\'s message does not flush this one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, out } = harness();
  c.send(partial('a', 'r1'));
  c.send(partial('b', 'r2'));
  c.send(stream('tool_use', 'x', 'r2'));
  assert.deepEqual(kinds(out), ['partial:b', 'tool_use:x']);
  c.send({ type: 'machine_stats', stats: {} } as unknown as AgentToCentral); // no runId: flushes nothing
  assert.deepEqual(kinds(out), ['partial:b', 'tool_use:x', 'machine_stats']);
  t.mock.timers.tick(75);
  assert.deepEqual(kinds(out), ['partial:b', 'tool_use:x', 'machine_stats', 'partial:a']);
});

test('flushes at the size cap', () => {
  const { c, out } = harness({ maxChars: 10 });
  c.send(partial('12345'));
  assert.equal(out.length, 0);
  c.send(partial('67890'));
  assert.deepEqual(kinds(out), ['partial:1234567890']);
  assert.equal(c.pending, 0);
});

test('a session id change mid-run does not mix the two sessions in one frame', () => {
  const { c, out } = harness();
  c.send(partial('old', 'r1', ''));
  c.send(partial('new', 'r1', 'real'));
  c.flush('r1');
  assert.deepEqual(
    out.map((m) => (m.type === 'stream' ? [m.sessionId, m.event.text] : [])),
    [['', 'old'], ['real', 'new']],
  );
});

test('the frame is an ordinary partial: kind and text only', () => {
  const { c, out } = harness();
  c.send(partial('a'));
  c.send(partial('b'));
  c.flushAll();
  assert.deepEqual(out, [{ type: 'stream', sessionId: 's1', runId: 'r1', event: { kind: 'partial', text: 'ab' } }]);
});

test('clear drops the buffer and its timer: nothing is sent afterwards', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, out } = harness();
  c.send(partial('lost'));
  c.clear();
  t.mock.timers.tick(1000);
  assert.equal(out.length, 0);
  assert.equal(c.pending, 0);
  // and the coalescer is reusable
  c.send(partial('again'));
  t.mock.timers.tick(75);
  assert.deepEqual(kinds(out), ['partial:again']);
});

test('flush after the link is gone is dropped by the sink, no timer is left behind', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, out } = harness({}, false);
  assert.equal(c.send(partial('a')), true);
  t.mock.timers.tick(75);
  assert.equal(out.length, 1); // handed to the sink, which refused it — as before, a frame on a dead socket is lost
  assert.equal(c.pending, 0);
  t.mock.timers.tick(1000);
  assert.equal(out.length, 1);
});

test('a flushed buffer does not fire its timer again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, out } = harness();
  c.send(partial('a'));
  c.send(stream('status', 's'));
  t.mock.timers.tick(1000);
  assert.deepEqual(kinds(out), ['partial:a', 'status:s']);
});
