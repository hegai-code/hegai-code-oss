import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childNice, deprioritizeDescendants, type ProcFs } from '../src/child-nice.js';

function fakeFs(tree: Record<number, { tasks: number[]; kids: number[] }>, nice: Record<number, number>): ProcFs & { set: number[] } {
  const set: number[] = [];
  return {
    set,
    tasks: (pid) => {
      if (!tree[pid]) throw new Error('ENOENT');
      return tree[pid]!.tasks;
    },
    // children are reported on the main thread only
    children: (pid, tid) => (tid === pid ? tree[pid]!.kids : []),
    getPriority: (tid) => nice[tid] ?? 0,
    setPriority: (tid, n) => {
      nice[tid] = n;
      set.push(tid);
    },
  };
}

test('every descendant thread is raised, the root is not', () => {
  const nice: Record<number, number> = {};
  const fs = fakeFs(
    {
      1: { tasks: [1, 11], kids: [2, 3] },
      2: { tasks: [2, 21, 22], kids: [4] },
      3: { tasks: [3], kids: [] },
      4: { tasks: [4], kids: [] },
    },
    nice,
  );
  assert.equal(deprioritizeDescendants(1, 10, fs), 5);
  assert.deepEqual(fs.set.sort((a, b) => a - b), [2, 3, 4, 21, 22]);
  assert.equal(nice[1], undefined);
  assert.equal(nice[11], undefined);
});

test('never lowers a niceness someone raised further, and a second pass changes nothing', () => {
  const nice: Record<number, number> = { 3: 15 };
  const fs = fakeFs({ 1: { tasks: [1], kids: [2, 3] }, 2: { tasks: [2], kids: [] }, 3: { tasks: [3], kids: [] } }, nice);
  assert.equal(deprioritizeDescendants(1, 10, fs), 1);
  assert.equal(nice[3], 15);
  assert.equal(deprioritizeDescendants(1, 10, fs), 0);
});

test('a process that exits mid-walk is skipped', () => {
  const fs = fakeFs({ 1: { tasks: [1], kids: [2, 9] }, 2: { tasks: [2], kids: [] } }, {});
  assert.equal(deprioritizeDescendants(1, 10, fs), 1);
});

test('CC_REMOTE_CHILD_NICE parsing', () => {
  assert.equal(childNice({}), 10);
  assert.equal(childNice({ CC_REMOTE_CHILD_NICE: '0' }), 0);
  assert.equal(childNice({ CC_REMOTE_CHILD_NICE: '5' }), 5);
  assert.equal(childNice({ CC_REMOTE_CHILD_NICE: '40' }), 19);
  assert.equal(childNice({ CC_REMOTE_CHILD_NICE: 'x' }), 10);
  assert.equal(childNice({ CC_REMOTE_CHILD_NICE: '0.5' }), 10);
});

test('a refused renice is reported, a vanished thread is not', () => {
  const denied: string[] = [];
  const sysErr = (code: string) => Object.assign(new Error(code), { code: 'ERR_SYSTEM_ERROR', info: { code } });
  const fs: ProcFs = {
    tasks: (pid) => [pid],
    children: (pid) => (pid === 1 ? [2, 3] : []),
    getPriority: () => 0,
    setPriority: (tid) => {
      throw sysErr(tid === 2 ? 'EPERM' : 'ESRCH');
    },
  };
  assert.equal(deprioritizeDescendants(1, 10, fs, (e) => denied.push(e.message)), 0);
  assert.deepEqual(denied, ['EPERM']);
});
