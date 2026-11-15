import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundTaskLabel, backgroundTaskRepeatKey, collapseRepeats, parseBackgroundTasks } from '../src/sessionChannel.js';

/**
 * The agent's `background_tasks` status is what tells the pane that a turn
 * which ended on «запустил в фоне, жду» is not a finished job. It is relayed
 * opaquely by the hub, so the web is the one that has to survive a malformed
 * row rather than drop the whole list.
 */
test('background tasks: the list survives a bad row and keeps each start', () => {
  const tasks = parseBackgroundTasks({
    tasks: [
      { id: 'b1', type: 'local_bash', description: 'Score all batches', since: 1_000 },
      { type: 'local_bash' },
      null,
      { id: 'a2', description: 'Research' },
    ],
  });
  assert.deepEqual(tasks.map((t) => t.id), ['b1', 'a2']);
  assert.equal(tasks[0]!.since, 1_000);
  assert.equal(tasks[1]!.type, '');
});

test('background tasks: the empty set and a missing payload both mean none', () => {
  assert.deepEqual(parseBackgroundTasks({ tasks: [] }), []);
  assert.deepEqual(parseBackgroundTasks(undefined), []);
});

test('background tasks: a raw shell command is worded, never shown', () => {
  const bash = (description: string) => backgroundTaskLabel({ type: 'local_bash', description });
  // The line that prompted this, verbatim from the pane.
  assert.equal(
    bash('for i in $(seq 1 55); do if git ls-remote origin "refs/ci-ok/7de54047" | grep -q .; then echo ok; fi; sleep 20; done'),
    'Жду зелёный CI',
  );
  assert.equal(bash('npm test 2>&1 | tail -5'), 'Прогоняю тесты');
  assert.equal(bash('cd /srv/x && make'), 'Собираю');
  assert.equal(bash("ssh stage 'journalctl -u hub -f' | grep -m1 ready"), 'Читаю лог hub на stage');
  assert.equal(bash('-x; y'), 'команда');
  assert.equal(bash('sleep 30'), 'Жду 30 с');
  assert.equal(bash('npm test'), 'Прогоняю тесты');
  assert.equal(bash(''), 'команда');
  assert.equal(backgroundTaskLabel({ type: 'local_agent', description: '' }), 'агент');
  // What a person wrote passes through untouched.
  assert.equal(bash('Жду зелёный CI на 24b61bc'), 'Жду зелёный CI на 24b61bc');
  assert.equal(bash('Score all batches'), 'Score all batches');
  assert.equal(backgroundTaskLabel({ type: 'local_agent', description: 'Research the SDK' }), 'Research the SDK');
});

test('background tasks: owner passes through, absent when the wire has none', () => {
  const [own, helper] = parseBackgroundTasks({ tasks: [{ id: 'a', description: 'x', owner: '' }, { id: 'b', description: 'y', owner: 'Admin layout', ownerId: 'h1' }] });
  assert.ok(!('owner' in own!));
  assert.equal(helper!.owner, 'Admin layout');
  assert.equal(helper!.ownerId, 'h1');
});

test('background tasks: no repeat key for a sub-agent or a description that may be cut', () => {
  assert.equal(backgroundTaskRepeatKey({ type: 'local_agent', description: 'Fix layout' }), undefined);
  assert.equal(backgroundTaskRepeatKey({ type: 'local_bash', description: 'x'.repeat(200) }), undefined);
  assert.notEqual(backgroundTaskRepeatKey({ type: 'local_bash', description: 'x'.repeat(199) }), undefined);
});

test('background tasks: repeats fold per owner, keeping every id and the oldest start', () => {
  const row = (id: string, since: number, description: string, ownerId?: string, type = 'local_bash') => ({
    id, since, repeatKey: backgroundTaskRepeatKey({ type, description, ownerId }),
  } as { id: string; since: number; repeatKey?: string; ids?: string[] });
  const rows = collapseRepeats([
    row('m1', 300, 'my shots done', 'h1'),
    row('o1', 100, 'npm test'),
    row('m2', 200, 'my shots done', 'h1'),
    row('r1', 50, 'my shots done', 'h2'),
    row('m3', 400, ' my shots done ', 'h1'),
    row('e1', 10, ''),
    row('e2', 20, ''),
    row('k1', 30, 'my shots done', 'h1', 'other_kind'),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['m1', 'o1', 'r1', 'e1', 'e2', 'k1']);
  assert.deepEqual(rows[0]!.ids, ['m1', 'm2', 'm3']);
  assert.equal(rows[0]!.since, 200);
  assert.equal(rows[1]!.ids, undefined);
});
