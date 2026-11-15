import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnsentGuard, nothingWasDelivered } from '../src/central-reducers.js';

/**
 * The net under `sendInput`: a frame leaving the browser is not delivery, so
 * the text is held until the hub either proves the run got it or says it did
 * not. Every case below is a way that went wrong in the product.
 */

test('a refused send comes back', () => {
  const g = createUnsentGuard();
  g.sent('раскатывай');
  assert.equal(g.recover('run_gone', 'Run not found'), 'раскатывай');
});

test('the same refusal cannot hand the text back twice', () => {
  const g = createUnsentGuard();
  g.sent('раскатывай');
  g.recover('machine_offline', 'machine offline');
  assert.equal(g.recover('machine_offline', 'machine offline'), null);
});

/** The one that shipped: the guard had no «delivered» branch at all, so it kept
 *  the last DELIVERED message forever. A machine dropping and reconnecting
 *  answers `machine_offline`, and that stale text was pasted into the composer
 *  while its turn was pulled back out of the transcript. */
test('a message the run answered is not handed back when the machine reconnects', () => {
  const g = createUnsentGuard();
  g.sent('посмотри, почему распознавание глотает конец фразы');
  g.delivered(); // the run streamed — it is alive and it got this
  assert.equal(
    g.recover('machine_offline', 'machine offline'),
    null,
    'a delivered message must not reappear in the composer',
  );
});

/** One guard serves the whole app, so leaving a session has to empty it: a
 *  refusal in the session you arrive at must not hand you what you wrote in
 *  the one you left, into a composer where sending it is wrong. */
test('text does not follow you into another session', () => {
  const g = createUnsentGuard();
  g.sent('в этой сессии');
  g.left();
  assert.equal(g.recover('run_gone', 'Run not found'), null);
});

test('an unrelated error is not a reason to take anything back', () => {
  const g = createUnsentGuard();
  g.sent('раскатывай');
  assert.equal(g.recover('attachments_dropped', 'три файла не поместились'), null);
  assert.equal(g.recover('run_gone', 'Run not found'), 'раскатывай', 'still held');
});

/** The codes are the contract; the sentence keeps a hub that predates them
 *  working, and that fallback is easy to drop by accident. */
test('a hub too old to send codes is still understood', () => {
  assert.equal(nothingWasDelivered(undefined, 'Run not found'), true);
  assert.equal(nothingWasDelivered(undefined, 'что-то другое'), false);
});
