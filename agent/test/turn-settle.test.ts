import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnSettle } from '../src/turn-settle.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness() {
  let fired = 0;
  const s = new TurnSettle(() => fired++, 20);
  return { s, fired: () => fired };
}

test('a finished turn with nothing in the background settles once', async () => {
  const { s, fired } = harness();
  s.sessionState('running');
  s.result();
  s.sessionState('idle');
  await tick(40);
  assert.equal(fired(), 1);
  s.sessionState('idle'); // a repeat heartbeat is not a second turn
  await tick(40);
  assert.equal(fired(), 1);
});

test('«запустил агента, жду»: idle with a background task is not settled', async () => {
  const { s, fired } = harness();
  s.sessionState('running');
  s.backgroundTasks(1);
  s.result();
  s.sessionState('idle');
  await tick(40);
  assert.equal(fired(), 0, 'the work is still running in the background');

  // The task finishes; the CLI wakes on its notification a beat later.
  s.backgroundTasks(0);
  await tick(5);
  s.sessionState('running');
  await tick(40);
  assert.equal(fired(), 0, 'the gap before `running` must not read as settled');

  s.result();
  s.sessionState('idle');
  await tick(40);
  assert.equal(fired(), 1, 'the turn that follows the task is the handoff');
});

test('a CLI that never reports its state settles on result alone', async () => {
  const { s, fired } = harness();
  s.result();
  await tick(40);
  assert.equal(fired(), 1);
});

test('the person speaking first cancels a pending settle', async () => {
  const { s, fired } = harness();
  s.result();
  s.input();
  await tick(40);
  assert.equal(fired(), 0);
});

test('waiting on the person (requires_action) is not settled', async () => {
  const { s, fired } = harness();
  s.result();
  s.sessionState('requires_action');
  await tick(40);
  assert.equal(fired(), 0);
});
