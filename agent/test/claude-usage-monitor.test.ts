import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeUsageMonitor } from '../src/claude-usage-monitor.js';

test('no Claude request before policy, while paused, or after disconnect', async () => {
  let calls = 0;
  const monitor = new ClaudeUsageMonitor(async () => {
    calls++;
    return { updatedAt: 1 };
  }, () => ({ status: 200 }));
  await monitor.poll(); // before the first register_ack
  monitor.configure(false);
  await monitor.poll();
  await monitor.poll(); // periodic poll still does nothing
  assert.equal(calls, 0);
  monitor.configure(); // old hub: absent field enables checks
  assert.deepEqual(await monitor.poll(), { usage: { updatedAt: 1 }, http: { status: 200 } });
  assert.equal(calls, 1);
  monitor.stop();
  await monitor.poll();
  monitor.configure(false); // reconnect to a hub that paused the owner
  await monitor.poll();
  assert.equal(calls, 1);
});

test('a reconnect aborts old HTTP work and discards its result and error evidence', async () => {
  let resolve!: (usage: { updatedAt: number }) => void;
  let sentSignal: AbortSignal | undefined;
  const monitor = new ClaudeUsageMonitor((signal) => {
    sentSignal = signal;
    return new Promise((done) => { resolve = done; });
  }, () => ({ status: 401 }));
  monitor.configure(true);
  const oldPoll = monitor.poll();
  monitor.stop();
  monitor.configure(false);
  assert.equal(sentSignal?.aborted, true);
  resolve({ updatedAt: 1 });
  assert.deepEqual(await oldPoll, { usage: null });
  assert.deepEqual(await monitor.poll(), { usage: null });
});
