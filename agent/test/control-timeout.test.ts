import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSessionRun, TIMED_OUT, withTimeout, type StreamEvent } from '../src/claude-session.js';

/**
 * A control request the CLI ACCEPTS must read as accepted.
 *
 * `setModel`, `setPermissionMode` and `applyFlagSettings` resolve to
 * `undefined` on success, and so does an older CLI's `interrupt`. The timeout
 * used to be signalled with `false`, and the callers tested truthiness — so
 * every successful switch came back as «the runtime did not answer the model
 * change in 10s», the picker stayed on the old model, and the model changed
 * anyway. These pin the boundary: `undefined` is an answer, only silence is
 * `TIMED_OUT`.
 */

test('withTimeout passes an undefined answer through, not as a timeout', async () => {
  assert.equal(await withTimeout(Promise.resolve(undefined), 50), undefined);
  assert.equal(await withTimeout(Promise.resolve(false), 50), false);
  // The bound's timer is unref'd (it must never keep an agent alive), so hold
  // the loop open ourselves while waiting on a promise that never settles —
  // otherwise node may exit before the timer fires and cancel the test.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    assert.equal(await withTimeout(new Promise(() => {}), 10), TIMED_OUT);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('withTimeout lets a refusal reject — a refusal is an answer', async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error('no such model')), 50), /no such model/);
});

/** A run with just enough state for the control methods, around a fake query. */
function runWith(query: Record<string, unknown>): { run: ClaudeSessionRun; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  const run = Object.create(ClaudeSessionRun.prototype) as ClaudeSessionRun;
  Object.assign(run as unknown as Record<string, unknown>, {
    query,
    handlers: { onEvent: (e: StreamEvent) => events.push(e) },
  });
  return { run, events };
}

test('a model / mode / effort change the CLI accepts resolves, it does not throw', async () => {
  const seen: unknown[] = [];
  const { run } = runWith({
    setModel: async (m?: string) => void seen.push(['model', m]),
    setPermissionMode: async (m: string) => void seen.push(['mode', m]),
    applyFlagSettings: async (s: unknown) => void seen.push(['flags', s]),
  });
  await run.setModel('opus[1m]');
  await run.setModel(undefined);
  await run.setPermissionMode('plan');
  await run.setEffort('high');
  assert.deepEqual(seen.map((s) => (s as unknown[])[0]), ['model', 'model', 'mode', 'flags']);
});

test('a CLI that refuses a model change still surfaces the refusal', async () => {
  const { run } = runWith({
    setModel: async () => {
      throw new Error('model not available');
    },
  });
  await assert.rejects(run.setModel('nope'), /model not available/);
});

test('a Stop answered with an older CLI\'s undefined leaves the run open', async () => {
  let closed = false;
  const { run, events } = runWith({ interrupt: async () => undefined });
  (run as unknown as { close: () => void }).close = () => {
    closed = true;
  };
  await run.interrupt();
  assert.equal(closed, false, 'an answered interrupt must not close the run');
  assert.equal(events.length, 0, 'and must not say it went unanswered');
});
