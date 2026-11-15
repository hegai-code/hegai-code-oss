import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryMessage } from '@cc-remote/shared';
import { currentPlan } from '../src/planProgress.js';
import type { TranscriptLine } from '../src/central-reducers.js';

const todos = (...rows: Array<[string, string]>) => ({ todos: rows.map(([content, status]) => ({ content, status, activeForm: `${content}…` })) });
const planCall = (id: string, input: unknown, name = 'mcp__hegai__plan'): HistoryMessage => ({
  type: 'assistant', uuid: id, blocks: [{ kind: 'tool_use', id, name, input }],
}) as HistoryMessage;
const human = (text: string): HistoryMessage => ({ type: 'user', uuid: `u-${text}`, blocks: [{ kind: 'text', text }] }) as HistoryMessage;
const planLine = (id: number, input: unknown, name = 'mcp__hegai__plan'): TranscriptLine => ({ id, kind: 'tool_use', text: `${name} ${JSON.stringify(input)}` });
const userLine = (id: number, text: string): TranscriptLine => ({ id, kind: 'user', text });

test('no plan call: null', () => {
  assert.equal(currentPlan([], []), null);
  assert.equal(currentPlan([human('привет')], [{ id: 1, kind: 'assistant', text: 'ok' }]), null);
});

test('the latest plan call wins', () => {
  const h = [human('сделай'), planCall('a', todos(['x', 'pending'], ['y', 'pending'])), planCall('b', todos(['x', 'completed'], ['y', 'in_progress']))];
  const p = currentPlan(h, [])!;
  assert.equal(p.done, 1);
  assert.equal(p.total, 2);
  assert.equal(p.active, 'y…');
  assert.equal(p.items.length, 2);
});

test('a plan from before the last human message is ignored', () => {
  const h = [human('раз'), planCall('a', todos(['x', 'pending'])), human('два')];
  assert.equal(currentPlan(h, []), null);
  assert.equal(currentPlan(h, [userLine(1, 'три')]), null);
});

test('a live line beats the history', () => {
  const h = [human('сделай'), planCall('a', todos(['x', 'pending'], ['y', 'pending']))];
  const p = currentPlan(h, [planLine(1, todos(['x', 'completed'], ['y', 'completed']))])!;
  assert.equal(p.done, 2);
});

test('a live human line ends the search before the file, even when the text matches', () => {
  // A repeated «продолжай» must not inherit the previous task's plan.
  const h = [human('продолжай'), planCall('a', todos(['x', 'completed'], ['y', 'completed']))];
  assert.equal(currentPlan(h, [userLine(1, 'продолжай'), { id: 2, kind: 'assistant', text: 'начинаю' }]), null);
  // a live plan before the live human line does not count
  assert.equal(currentPlan([], [planLine(1, todos(['x', 'pending'])), userLine(2, 'новое')]), null);
});

test('malformed rows are dropped, a non-plan input is skipped', () => {
  const h = [human('a'), planCall('a', { todos: [{ content: 'ok', status: 'completed' }, { status: 'pending' }, null, { content: '  ', status: 'pending' }, { content: 'bad status', status: 'weird' }] })];
  const p = currentPlan(h, [{ id: 1, kind: 'tool_use', text: 'mcp__hegai__plan {"todos":[{"content":"cut' }])!;
  assert.deepEqual(p.items.map((i) => i.content), ['ok', 'bad status']);
  assert.equal(p.done, 1);
  assert.equal(currentPlan([human('a'), planCall('b', { nope: 1 })], []), null);
});

test('TodoWrite counts as a plan', () => {
  assert.equal(currentPlan([human('a'), planCall('t', todos(['x', 'in_progress']), 'TodoWrite')], [])!.total, 1);
  assert.equal(currentPlan([], [planLine(1, todos(['x', 'pending']), 'TodoWrite')])!.total, 1);
});

test('a picture alone is the person\'s turn: the previous task\'s plan stays behind it', () => {
  const history = [
    { type: 'user', uuid: 'u1', blocks: [{ kind: 'text', text: 'сделай' }] },
    { type: 'assistant', uuid: 'a1', blocks: [{ kind: 'tool_use', id: 't', name: 'mcp__hegai__plan', input: { todos: [{ content: 'A', status: 'completed', activeForm: 'A' }] } }] },
    { type: 'user', uuid: 'u2', blocks: [{ kind: 'image' }] },
  ] as unknown as HistoryMessage[];
  assert.equal(currentPlan(history, []), null);
});
