import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// memory.ts freezes STATE_DIR from os.homedir() at import, so point the home at
// a scratch directory first. node --test runs each file in its own process.
const home = await mkdtemp(path.join(os.tmpdir(), 'ccr-memstate-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
const { readSyncState, writeSyncState, serialJobRunner } = await import('../src/memory.js');

const stateDir = path.join(home, '.cc-remote');
const stateFile = path.join(stateDir, 'memory-state.json');
const rec = (n: number) => ({ sha: `sha-${n}`, revision: n });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

after(() => rm(home, { recursive: true, force: true }));

// The shape of both client call sites: read, wait on disk, mutate, write.
async function readModifyWrite(key: string, n: number): Promise<void> {
  const state = await readSyncState();
  await tick(10);
  state[key] = rec(n);
  await writeSyncState(state);
}

test('writeSyncState round-trips through readSyncState', async () => {
  await writeSyncState({ a: rec(1) });
  assert.deepEqual(await readSyncState(), { a: rec(1) });
});

test('writeSyncState rethrows a failed save and leaves no tmp file behind', async () => {
  await rm(stateFile, { force: true });
  // A directory where the file belongs makes the final rename fail.
  await mkdir(stateFile, { recursive: true });
  await assert.rejects(writeSyncState({ a: rec(1) }));
  const leftovers = (await readdir(stateDir)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  await rm(stateFile, { recursive: true, force: true });
  await writeSyncState({ b: rec(2) });
  assert.deepEqual(await readSyncState(), { b: rec(2) });
});

test('control: interleaved read-modify-write loses an update (the bug)', async () => {
  await writeSyncState({});
  await Promise.all([readModifyWrite('first', 1), readModifyWrite('second', 2)]);
  assert.equal(Object.keys(await readSyncState()).length, 1);
});

test('serialJobRunner: interleaved batches both persist', async () => {
  await writeSyncState({});
  const run = serialJobRunner();
  await Promise.all([
    run(() => readModifyWrite('first', 1)),
    run(() => readModifyWrite('second', 2)),
    run(() => readModifyWrite('third', 3)),
  ]);
  assert.deepEqual(await readSyncState(), { first: rec(1), second: rec(2), third: rec(3) });
});

test('serialJobRunner: jobs run in arrival order, one at a time', async () => {
  const run = serialJobRunner();
  const log: string[] = [];
  let active = 0;
  let maxActive = 0;
  const job = (name: string, ms: number) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    log.push(`start ${name}`);
    await tick(ms);
    log.push(`end ${name}`);
    active--;
    return name;
  };
  const results = await Promise.all([run(job('a', 20)), run(job('b', 1)), run(job('c', 1))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(maxActive, 1);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('serialJobRunner: a failing job reaches its own caller and does not stall the queue', async () => {
  const run = serialJobRunner();
  const failing = run(async () => {
    throw new Error('disk full');
  });
  const after = run(async () => 'still ran');
  await assert.rejects(failing, /disk full/);
  assert.equal(await after, 'still ran');
});
