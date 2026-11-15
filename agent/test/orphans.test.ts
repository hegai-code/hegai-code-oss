import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { OWN_ENTRYPOINT, sameProcess } from '../src/sessions.js';
import { describeAge, describeOrphan, describeWriter, findOrphanedChildren, selectOrphans } from '../src/orphans.js';

/**
 * Which `~/.claude/sessions/<pid>.json` entries the start-up scan reports as
 * children that outlived a previous agent.
 *
 * The invariant under test is agreement: "orphan" must be exactly the set the
 * single-writer guard already refuses to skip (`isOwnChild` === false, among
 * our own entrypoints, pid alive). If these two ever disagree, the agent either
 * reports a healthy child of its own as an orphan, or stays silent about a pid
 * the inventory is publishing as a live writer.
 */

const AGENT_STARTED = 1_000_000;
const ALL_ALIVE = () => true;
const NONE_ALIVE = () => false;

function rec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 4242,
    sessionId: 'sess-a',
    entrypoint: OWN_ENTRYPOINT,
    startedAt: AGENT_STARTED - 60_000,
    cwd: '/srv/work',
    ...over,
  };
}

test('a live child of a PREVIOUS agent is an orphan', () => {
  const found = selectOrphans([rec()], AGENT_STARTED, ALL_ALIVE);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.pid, 4242);
  assert.equal(found[0]?.sessionId, 'sess-a');
  assert.equal(found[0]?.cwd, '/srv/work');
});

test('the SDK default entrypoint counts as ours too', () => {
  assert.equal(selectOrphans([rec({ entrypoint: 'sdk-ts' })], AGENT_STARTED, ALL_ALIVE).length, 1);
});

test('a live child of THIS agent is never an orphan', () => {
  // The whole point: our own running session must not be reported, or every
  // start would announce the work it is doing as abandoned.
  const mine = rec({ startedAt: AGENT_STARTED + 5_000 });
  assert.deepEqual(selectOrphans([mine], AGENT_STARTED, ALL_ALIVE), []);
  // And the 2s slack `isOwnChild` grants must be honoured identically here.
  const justBefore = rec({ startedAt: AGENT_STARTED - 1_000 });
  assert.deepEqual(selectOrphans([justBefore], AGENT_STARTED, ALL_ALIVE), []);
});

test('a dead pid is not an orphan, however old its liveness file', () => {
  // ~/.claude/sessions is full of files whose process is long gone; reporting
  // those would bury the one line that matters.
  assert.deepEqual(selectOrphans([rec()], AGENT_STARTED, NONE_ALIVE), []);
});

test('an editor or a terminal is never ours to report', () => {
  for (const entrypoint of ['claude-vscode', 'cli', undefined, 42]) {
    assert.deepEqual(
      selectOrphans([rec({ entrypoint })], AGENT_STARTED, ALL_ALIVE),
      [],
      `entrypoint ${String(entrypoint)}`,
    );
  }
});

test('a record without startedAt is not reported', () => {
  // `isOwnChild` reads a missing startedAt as ours. The two judgements must
  // agree — disagreeing here would announce healthy children as orphans on
  // every machine still running an older CLI.
  assert.deepEqual(selectOrphans([rec({ startedAt: undefined })], AGENT_STARTED, ALL_ALIVE), []);
});

test('malformed records are skipped, not fatal', () => {
  const records = [
    {},
    { pid: 'x', sessionId: 'a', entrypoint: OWN_ENTRYPOINT, startedAt: 1 },
    { pid: 1, sessionId: '', entrypoint: OWN_ENTRYPOINT, startedAt: 1 },
    rec({ pid: 99 }),
  ];
  const found = selectOrphans(records, AGENT_STARTED, ALL_ALIVE);
  assert.deepEqual(found.map((o) => o.pid), [99]);
});

test('orphans come back oldest first', () => {
  const found = selectOrphans(
    [
      rec({ pid: 13, sessionId: 'c', startedAt: AGENT_STARTED - 10_000 }),
      rec({ pid: 11, sessionId: 'a', startedAt: AGENT_STARTED - 900_000 }),
      rec({ pid: 12, sessionId: 'b', startedAt: AGENT_STARTED - 100_000 }),
    ],
    AGENT_STARTED,
    ALL_ALIVE,
  );
  assert.deepEqual(found.map((o) => o.pid), [11, 12, 13]);
});

test('the log line carries pid, session, age and cwd', () => {
  // These four are what a person needs to find the process and decide; an
  // orphan that appears without them is the silence this feature exists to end.
  const line = describeOrphan(
    { pid: 777, sessionId: 'sess-z', cwd: '/srv/tree', entrypoint: OWN_ENTRYPOINT, startedAt: 0 },
    3 * 3_600_000 + 12 * 60_000,
  );
  assert.match(line, /pid 777/);
  assert.match(line, /sess-z/);
  assert.match(line, /3h 12m/);
  assert.match(line, /\/srv\/tree/);
});

test('a refusal names an orphan as one, not as "cc-remote"', () => {
  // «session is live in cc-remote (pid 41203)» read as the control plane
  // fighting itself and told nobody what to do about it.
  const text = describeWriter(
    { pid: 41203, entrypoint: OWN_ENTRYPOINT, startedAt: AGENT_STARTED - 3_600_000 },
    AGENT_STARTED,
    AGENT_STARTED,
  );
  assert.match(text, /leftover/);
  assert.match(text, /previous agent/);
  assert.match(text, /pid 41203/);
  assert.match(text, /1h 0m/);
});

test('a refusal still names an editor as an editor', () => {
  // Only an orphan may be described as unattended; a `claude-vscode` pid has a
  // person behind it and killing it is a different conversation.
  assert.equal(
    describeWriter({ pid: 7, entrypoint: 'claude-vscode', startedAt: AGENT_STARTED - 60_000 }, AGENT_STARTED),
    'claude-vscode (pid 7)',
  );
  assert.equal(describeWriter({ pid: 7 }, AGENT_STARTED), 'an editor (pid 7)');
  // Our own live child is not an orphan here either — same predicate as above.
  assert.equal(
    describeWriter({ pid: 7, entrypoint: 'sdk-ts', startedAt: AGENT_STARTED + 10 }, AGENT_STARTED),
    'sdk-ts (pid 7)',
  );
});

test('age reads in the unit a person thinks in', () => {
  assert.equal(describeAge(19_000), '19s');
  assert.equal(describeAge(47 * 60_000), '47m');
  assert.equal(describeAge(3 * 3_600_000 + 12 * 60_000), '3h 12m');
  assert.equal(describeAge(-5), '0s');
});

test('the CLI fingerprint rides along on an orphan, so --release can guard its signals', () => {
  const [found] = selectOrphans([rec({ procStart: '123456' })], AGENT_STARTED, ALL_ALIVE);
  assert.equal(found?.procStart, '123456');
  const [bare] = selectOrphans([rec({ procStart: 42 })], AGENT_STARTED, ALL_ALIVE);
  assert.equal('procStart' in (bare ?? {}), false, 'a non-string is no fingerprint');
});

/**
 * A pid the kernel has reused is not an orphan — it is a stranger. The scan
 * must drop it exactly as the single-writer guard does, or the log announces a
 * `claude` child that no longer exists and `--release` offers up somebody's
 * unrelated process to be killed.
 */
test('an orphan whose pid was reused by another process is not reported', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orphans-'));
  try {
    const old = Date.now() - 3_600_000;
    // This very process is the «live pid» behind both records.
    const base = { pid: process.pid, entrypoint: OWN_ENTRYPOINT, cwd: '/srv/work', startedAt: old };
    await writeFile(path.join(dir, 'a.json'), JSON.stringify({ ...base, sessionId: 'sess-kept', procStart: '1000' }));
    await writeFile(path.join(dir, 'b.json'), JSON.stringify({ ...base, sessionId: 'sess-reused', procStart: '2000' }));
    const probe = { token: async () => '1000', startMs: async () => undefined };
    const found = await findOrphanedChildren(Date.now(), {
      dir,
      sameProcess: (record) => sameProcess(record, probe),
    });
    assert.deepEqual(found.map((o) => o.sessionId), ['sess-kept']);
    assert.equal(found[0]?.procStart, '1000');
  } finally {
    warn.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});
