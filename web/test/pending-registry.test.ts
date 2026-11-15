import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingRegistry } from '../src/pending-registry.js';

test('resolve settles the matching request and clears it', async () => {
  const registry = new PendingRegistry<string, { label: string }>(50);
  const pending = registry.wait('a', { label: 'A' }, 'timed out');
  assert.deepEqual(registry.context('a'), { label: 'A' });
  assert.equal(registry.resolve('a', 'done'), true);
  assert.equal(await pending, 'done');
  assert.equal(registry.size, 0);
});

test('rejectAll rejects every request and runs cleanup hooks', async () => {
  const registry = new PendingRegistry<void, undefined>(50);
  let cleanups = 0;
  const first = registry.wait('a', undefined, 'timed out', () => cleanups++);
  const second = registry.wait('b', undefined, 'timed out', () => cleanups++);
  registry.rejectAll(new Error('connection closed'));
  await assert.rejects(first, /connection closed/);
  await assert.rejects(second, /connection closed/);
  assert.equal(cleanups, 2);
  assert.equal(registry.size, 0);
});

test('timeout removes the request and runs its cleanup hook', async () => {
  const registry = new PendingRegistry<void, undefined>(5);
  let cleaned = false;
  const pending = registry.wait('a', undefined, 'operation timed out', () => {
    cleaned = true;
  });
  await assert.rejects(pending, /operation timed out/);
  assert.equal(cleaned, true);
  assert.equal(registry.size, 0);
});
