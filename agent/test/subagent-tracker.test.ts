import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUBAGENTS_MAX } from '@cc-remote/shared';
import { SubagentTracker } from '../src/subagent-tracker.js';

const started = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`,
  task_type: 'local_agent', subagent_type: 'general-purpose', description: `задача ${id}`, ...extra,
});

test('progress fills «сейчас» and the counters; it is a tick, not a status', () => {
  const t = new SubagentTracker(() => 10);
  assert.equal(t.receive(started('a')), 'status');
  assert.equal(
    t.receive({ type: 'system', subtype: 'task_progress', task_id: 'a', description: 'Running List directory contents', last_tool_name: 'Bash', usage: { total_tokens: 41_900, tool_uses: 4, duration_ms: 9000 } }),
    'progress',
  );
  const [a] = t.snapshot();
  assert.equal(a!.lastAction, 'Bash · List directory contents');
  assert.equal(a!.toolUses, 4);
  assert.equal(a!.tokens, 41_900);
});

test('a background agent ends on its notification, not on the «launched» result', () => {
  const t = new SubagentTracker(() => 10);
  t.receive(started('bg', { is_backgrounded: true }));
  assert.equal(t.toolResult('toolu_bg', 'Async agent launched successfully.', false, true), false);
  assert.equal(t.snapshot()[0]!.status, 'running');
  t.receive({ type: 'system', subtype: 'task_notification', task_id: 'bg', status: 'completed', summary: 'Нашёл три места.', usage: { total_tokens: 90_000, tool_uses: 30, duration_ms: 1 } });
  const [a] = t.snapshot();
  assert.equal(a!.status, 'completed');
  assert.equal(a!.summary, 'Нашёл три места.');
  assert.equal(a!.lastAction, undefined, 'a finished agent is doing nothing now');
});

test('killed reads as stopped; a failure keeps its error', () => {
  const t = new SubagentTracker(() => 10);
  t.receive(started('k'));
  t.receive(started('f'));
  t.receive({ type: 'system', subtype: 'task_updated', task_id: 'k', patch: { status: 'killed' } });
  t.receive({ type: 'system', subtype: 'task_updated', task_id: 'f', patch: { status: 'failed', error: 'API 529' } });
  const by = Object.fromEntries(t.snapshot().map((a) => [a.id, a]));
  assert.equal(by['k']!.status, 'stopped');
  assert.equal(by['f']!.status, 'failed');
  assert.equal(by['f']!.summary, 'API 529');
});

test('the set is capped: running first, the oldest finished drop and are forgotten', () => {
  let clock = 0;
  const t = new SubagentTracker(() => ++clock);
  for (let i = 0; i < SUBAGENTS_MAX + 5; i++) {
    t.receive(started(`d${i}`));
    t.receive({ type: 'system', subtype: 'task_notification', task_id: `d${i}`, status: 'completed', summary: '' });
  }
  t.receive(started('live'));
  const snap = t.snapshot();
  assert.equal(snap.length, SUBAGENTS_MAX);
  assert.equal(snap[0]!.id, 'live');
  assert.ok(!snap.some((a) => a.id === 'd0'));
  assert.equal(t.has('d0'), false);
});

test('a Stop is final: the trailing «completed» notice does not overwrite it', () => {
  const t = new SubagentTracker(() => 10);
  t.receive(started('s'));
  assert.equal(t.stopped('s'), true);
  t.receive({ type: 'system', subtype: 'task_notification', task_id: 's', status: 'completed', summary: 'частичный отчёт' });
  const [a] = t.snapshot();
  assert.equal(a!.status, 'stopped');
  assert.equal(a!.summary, 'частичный отчёт', 'a report it had none of is still taken');
});

test('past the wire cap a RUNNING agent is still tracked: its end lands', () => {
  const t = new SubagentTracker(() => 10);
  for (let i = 0; i < SUBAGENTS_MAX + 3; i++) t.receive(started(`r${i}`));
  assert.equal(t.snapshot().length, SUBAGENTS_MAX);
  const last = `r${SUBAGENTS_MAX + 2}`;
  assert.equal(t.isRunning(last), true);
  t.receive({ type: 'system', subtype: 'task_notification', task_id: last, status: 'failed', summary: 'x' });
  assert.equal(t.isRunning(last), false);
});

test('«сейчас» moves into the recent steps, and every tick dates the last sign of work', () => {
  let clock = 100;
  const t = new SubagentTracker(() => clock);
  t.receive(started('m'));
  for (const d of ['Running A', 'Running B', 'Running C', 'Running D', 'Running E']) {
    clock += 10;
    t.receive({ type: 'system', subtype: 'task_progress', task_id: 'm', description: d, last_tool_name: 'Bash', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } });
  }
  const [a] = t.snapshot();
  assert.equal(a!.lastAction, 'Bash · E');
  assert.deepEqual(a!.recent, ['Bash · B', 'Bash · C', 'Bash · D']);
  assert.equal(a!.activeAt, 150);
});

test('the model: what the call asked for, else the session\'s, then what the CLI resolved', () => {
  const t = new SubagentTracker(() => 1);
  t.setDefaultModel('claude-opus-5-5');
  t.noteCall('toolu_x', { model: 'haiku' });
  t.receive(started('x'));
  t.receive(started('y'));
  let by = Object.fromEntries(t.snapshot().map((a) => [a.id, a]));
  assert.equal(by['x']!.model, 'haiku');
  assert.equal(by['y']!.model, 'claude-opus-5-5');
  t.toolResult('toolu_y', 'Async agent launched', false, true, 'claude-sonnet-4-6');
  by = Object.fromEntries(t.snapshot().map((a) => [a.id, a]));
  assert.equal(by['y']!.model, 'claude-sonnet-4-6');
  assert.equal(by['y']!.status, 'running', 'a launch result does not end a background agent');
});

test('the trail survives the end: «ход работы» is still there to open', () => {
  const t = new SubagentTracker(() => 1);
  t.receive(started('z'));
  for (const d of ['Running A', 'Running B']) t.receive({ type: 'system', subtype: 'task_progress', task_id: 'z', description: d, last_tool_name: 'Bash', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } });
  t.receive({ type: 'system', subtype: 'task_notification', task_id: 'z', status: 'completed', summary: 'ok' });
  const [a] = t.snapshot();
  assert.deepEqual(a!.steps, ['Bash · A', 'Bash · B']);
  assert.equal(a!.lastAction, undefined);
});

test('a background task knows the sub-agent that started it, past the sub-agent itself', () => {
  const t = new SubagentTracker(() => 10);
  t.receive(started('helper', { description: 'Admin responsive layout' }));
  t.noteSubagentCalls('toolu_helper', [{ type: 'text', text: 'жду' }, { type: 'tool_use', id: 'toolu_mon', name: 'Monitor' }]);
  assert.equal(t.receive({ type: 'system', subtype: 'task_started', task_id: 'mon', tool_use_id: 'toolu_mon', task_type: 'local_bash', description: 'my shots done' }), null);
  assert.deepEqual(t.taskOwner('mon'), { id: 'helper', name: 'Admin responsive layout' });
  t.receive({ type: 'system', subtype: 'task_notification', task_id: 'helper', status: 'completed', summary: 'Готово.' });
  assert.equal(t.taskOwner('mon')?.name, 'Admin responsive layout', 'a watcher outlives whoever armed it');
  t.receive({ type: 'system', subtype: 'task_notification', task_id: 'mon', status: 'completed', summary: '' });
  assert.equal(t.taskOwner('mon'), undefined, 'the link ends with the task: only live ones compete for the cap');
  // The session's own task: its call was never a sub-agent's.
  t.receive({ type: 'system', subtype: 'task_started', task_id: 'own', tool_use_id: 'toolu_own', task_type: 'local_bash', description: 'npm test' });
  assert.equal(t.taskOwner('own'), undefined);
  // A task is not a sub-agent card.
  assert.deepEqual(t.snapshot().map((a) => a.id), ['helper']);
});

test('a sub-agent\'s own plan becomes «done/total · now» on its card', () => {
  const t = new SubagentTracker(() => 10);
  t.receive(started('p'));
  const plan = (statuses: string[]) => [{
    type: 'tool_use', id: `toolu_plan_${statuses.join('')}`, name: 'mcp__hegai__plan',
    input: { todos: statuses.map((status, i) => ({ content: `шаг ${i}`, status, activeForm: `Делаю шаг ${i}` })) },
  }];
  assert.equal(t.noteSubagentCalls('toolu_p', plan(['in_progress', 'pending', 'pending'])), true);
  assert.deepEqual(t.snapshot()[0]!.plan, { done: 0, total: 3, active: 'Делаю шаг 0' });
  assert.equal(t.noteSubagentCalls('toolu_p', plan(['in_progress', 'pending', 'pending'])), false, 'the same count is no news');
  assert.equal(t.noteSubagentCalls('toolu_p', plan(['completed', 'in_progress', 'pending'])), true);
  assert.deepEqual(t.snapshot()[0]!.plan, { done: 1, total: 3, active: 'Делаю шаг 1' });
  // TodoWrite (an older CLI, a model that still has it) reads the same.
  assert.equal(t.noteSubagentCalls('toolu_p', [{ type: 'tool_use', id: 'x', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }] } }]), true);
  assert.deepEqual(t.snapshot()[0]!.plan, { done: 1, total: 1 });
  // Not a card we know, not a plan: nothing.
  assert.equal(t.noteSubagentCalls('toolu_nobody', plan(['pending'])), false);
  assert.equal(t.noteSubagentCalls('toolu_p', [{ type: 'tool_use', id: 'y', name: 'Bash', input: { command: 'ls' } }]), false);
  t.receive({ type: 'system', subtype: 'task_notification', task_id: 'p', status: 'completed', summary: 'ok' });
  assert.deepEqual(t.snapshot()[0]!.plan, { done: 1, total: 1 }, 'the last count stays after the end');
});
