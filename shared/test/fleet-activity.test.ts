import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCentralToBrowser } from '../src/index.js';

// One fleet-origin run used to invalidate the entire snapshot/activity frame,
// hiding unrelated working sessions and leaving their composers detached.
for (const type of ['snapshot', 'activity'] as const) {
  test(`${type} retains all runs when a fleet API run is present`, () => {
    const runs = ['web', 'fleet', 'app'].map((origin, i) => ({
      runId: `run-${i}`, machineId: 'machine', sessionId: `session-${i}`,
      state: 'working', since: 1_790_000_000_000, origin,
    }));
    const frame = type === 'snapshot'
      ? { type, machines: [], activeRuns: runs }
      : { type, runs };
    const decoded = decodeCentralToBrowser(JSON.stringify(frame));
    assert.deepEqual(decoded.type === 'snapshot' ? decoded.activeRuns
      : decoded.type === 'activity' ? decoded.runs : undefined, runs);
  });

  // 20.10.2026: a backend-request run (hub, since 25.08) dropped every frame
  // again. Known values pass; an origin from a newer hub reads as absent.
  test(`${type} survives a backend-request run and an origin it does not know`, () => {
    const runs = ['backend-request', 'some-future-origin'].map((origin, i) => ({
      runId: `run-${i}`, machineId: 'machine', sessionId: `session-${i}`,
      state: 'idle', since: 1_790_000_000_000, origin,
    }));
    const frame = type === 'snapshot'
      ? { type, machines: [], activeRuns: runs }
      : { type, runs };
    const decoded = decodeCentralToBrowser(JSON.stringify(frame));
    const got = decoded.type === 'snapshot' ? decoded.activeRuns
      : decoded.type === 'activity' ? decoded.runs : undefined;
    assert.equal(got?.length, 2);
    assert.equal(got?.[0]?.origin, 'backend-request');
    assert.equal(got?.[1]?.origin, undefined);
  });
}
