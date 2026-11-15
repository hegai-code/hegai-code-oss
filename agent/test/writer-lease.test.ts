import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITER_DEADLINE_MS, writerGraceLeft } from '../src/client.js';

/**
 * How long live runs are held while the hub is unreachable.
 *
 * This file used to assert the opposite property — that the writer is dead
 * within 45s, before the hub's 60s lock release — on the theory that a
 * surviving writer could collide with a second one the hub hands the session
 * to. There is no such second writer: a session lives on one machine, every
 * `open` for it routes to this agent, and on reconnect the agent declares its
 * runs before any command can reach it. What the short deadline did in
 * practice was end every live run in the fleet whenever a hub restart took
 * longer than 45s (2026-09-19 08:00, six runs). The hold is now a safety net
 * against a hub that never comes back, and these tests state that.
 */

/** Longer than any hub deploy has ever taken, including the slow ones. */
const LONGEST_DEPLOY_SEEN_MS = 3 * 60_000;

/** The hub's own lock release (server-rs `RUN_GRACE_SECS`). Mirrored, not
 *  imported. The hold is deliberately LONGER than it: the hub freeing the
 *  lock while we hold the run is safe (see above), and re-adoption on
 *  reconnect rebuilds it. */
const HUB_LOCK_RELEASE_MS = 60_000;

test('a hub outage the length of a deploy costs no run', () => {
  for (const outage of [200, 21_000, 63_000, LONGEST_DEPLOY_SEEN_MS]) {
    const left = writerGraceLeft(1_000_000, 1_000_000 + outage);
    assert.ok(left > 0, `still holding after a ${outage}ms outage`);
  }
});

test('the hold outlives the hub lock release on purpose', () => {
  assert.ok(WRITER_DEADLINE_MS > HUB_LOCK_RELEASE_MS);
  // A half-open link is noticed only after KEEPALIVE_MS * KEEPALIVE_MAX_MISSES
  // = 30s; even anchored that far back, almost all of the hold remains.
  assert.ok(writerGraceLeft(1_000_000, 1_030_000) > WRITER_DEADLINE_MS - 31_000);
});

test('the hold is absolute, not cumulative, and eventually expires', () => {
  // A subprocess nobody can reach for half an hour is torn down rather than
  // kept for nobody.
  assert.equal(writerGraceLeft(1_000_000, 1_000_000 + WRITER_DEADLINE_MS), 0);
  assert.equal(writerGraceLeft(1_000_000, 9_000_000), 0);
  assert.equal(writerGraceLeft(1_000_000, 1_000_000 + 5_000), WRITER_DEADLINE_MS - 5_000);
});
