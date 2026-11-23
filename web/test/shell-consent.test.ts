import { test } from 'node:test';
import assert from 'node:assert/strict';

// The helpers read `window` lazily, so a fake one per test is enough.
const g = globalThis as { window?: unknown };

test('connect/decline are safe without the shell bridge (old shells, browsers)', async () => {
  g.window = {};
  const { connectShellAgent, declineShellAgent } = await import('../src/components/useMachinePick.js');
  assert.equal(await connectShellAgent(), false);
  await declineShellAgent();
});

test('connect/decline call the shell bridge when it exists', async () => {
  const calls: string[] = [];
  g.window = { __HEGAI_AGENT_API__: { connect: async () => { calls.push('c'); }, decline: async () => { calls.push('d'); } } };
  const { connectShellAgent, declineShellAgent } = await import('../src/components/useMachinePick.js');
  assert.equal(await connectShellAgent(), true);
  await declineShellAgent();
  assert.deepEqual(calls, ['c', 'd']);
});
