import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlanTool, planItems, planProgress } from '../src/plan.js';

test('our tool and TodoWrite are plans; the CLI\'s task tools are not', () => {
  assert.equal(isPlanTool('mcp__hegai__plan'), true);
  assert.equal(isPlanTool('TodoWrite'), true);
  assert.equal(isPlanTool('TaskCreate'), false);
  assert.equal(isPlanTool(undefined), false);
});

test('malformed rows drop, the list survives', () => {
  const items = planItems({
    todos: [
      { content: 'Поменять API', status: 'completed', activeForm: 'Меняю API' },
      { content: '', status: 'pending' },
      null,
      { content: 42 },
      { content: 'Выкатить', status: 'weird', activeForm: '  ' },
    ],
  });
  assert.deepEqual(items, [
    { content: 'Поменять API', status: 'completed', activeForm: 'Меняю API' },
    { content: 'Выкатить', status: 'pending' },
  ]);
  assert.equal(planItems({ command: 'ls' }), null);
  assert.equal(planItems(null), null);
});

test('progress counts completed and names the step in progress', () => {
  assert.deepEqual(planProgress([]), { done: 0, total: 0 });
  assert.deepEqual(
    planProgress([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress', activeForm: 'Делаю b' },
      { content: 'c', status: 'pending' },
    ]),
    { done: 1, total: 3, active: 'Делаю b' },
  );
  assert.deepEqual(planProgress([{ content: 'без формы', status: 'in_progress' }]), { done: 0, total: 1, active: 'без формы' });
  const long = planProgress([{ content: 'x'.repeat(300), status: 'in_progress' }]);
  assert.equal(long.active?.length, 160);
  assert.ok(long.active?.endsWith('…'));
});

test('clipping never leaves half an emoji', () => {
  const p = planProgress([{ content: `${'a'.repeat(158)}😀x`, status: 'in_progress' }]);
  assert.ok(p.active!.length <= 160);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p.active!), 'no lone high surrogate');
  assert.ok(p.active!.endsWith('…'));
});

test('steps: opt-in, trimmed, clipped, windowed around the active step', () => {
  assert.equal(planProgress([{ content: 'a', status: 'pending' }]).steps, undefined);
  assert.equal(planProgress([], true).steps, undefined);
  const p = planProgress([{ content: `  ${'я'.repeat(100)} `, status: 'in_progress' }, { content: 'b', status: 'pending' }], true);
  assert.equal(p.steps?.[0]?.text.length, 80);
  assert.ok(p.steps?.[0]?.text.endsWith('…'));
  assert.deepEqual(p.steps?.[1], { text: 'b', status: 'pending' });
  const many = Array.from({ length: 20 }, (_, i) => ({ content: `s${i}`, status: i < 9 ? 'completed' : i === 9 ? 'in_progress' : 'pending' }) as const);
  const w = planProgress([...many], true);
  assert.equal(w.steps?.length, 12);
  assert.equal(w.steps?.[0]?.text, 's6');
  assert.equal(w.steps?.[3]?.status, 'in_progress');
  assert.equal(w.total, 20);
  const tail = Array.from({ length: 20 }, (_, i) => ({ content: `s${i}`, status: i === 19 ? 'in_progress' : 'completed' }) as const);
  assert.equal(planProgress([...tail], true).steps?.[0]?.text, 's8');
  const top = Array.from({ length: 20 }, (_, i) => ({ content: `s${i}`, status: 'pending' }) as const);
  assert.equal(planProgress([...top], true).steps?.[0]?.text, 's0');
});
