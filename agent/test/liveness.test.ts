import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findLivePidForSession,
  isOwnChild,
  liveStatusOf,
  OWN_ENTRYPOINT,
  readLiveSessions,
  sameProcess,
  stillSameProcess,
  type LivenessRecord,
  type ProcessProbe,
  type SameProcessCheck,
} from '../src/sessions.js';
import { processStartToken } from '../src/proc-start.js';

/**
 * Which `~/.claude/sessions/<pid>.json` entries the single-writer guard may
 * ignore. "Our own child" means a child of THIS process: one carrying our
 * stamp but started before this agent did belongs to a previous incarnation
 * that died without taking it down, and it is still writing.
 */

const AGENT_STARTED = 1_000_000;

test('a child this process spawned is ours', () => {
  assert.equal(isOwnChild(OWN_ENTRYPOINT, AGENT_STARTED + 5_000, AGENT_STARTED), true);
  assert.equal(isOwnChild('sdk-ts', AGENT_STARTED + 5_000, AGENT_STARTED), true);
});

test('a child from a previous agent process is a live writer, not ours', () => {
  assert.equal(isOwnChild(OWN_ENTRYPOINT, AGENT_STARTED - 60_000, AGENT_STARTED), false);
  assert.equal(isOwnChild('sdk-ts', AGENT_STARTED - 1, AGENT_STARTED - 2_001), true, 'inside the 2s slack');
  assert.equal(isOwnChild('sdk-ts', AGENT_STARTED - 3_000, AGENT_STARTED), false, 'outside it');
});

test('an editor or a terminal is never ours, whenever it started', () => {
  assert.equal(isOwnChild('claude-vscode', AGENT_STARTED + 5_000, AGENT_STARTED), false);
  assert.equal(isOwnChild('cli', AGENT_STARTED + 5_000, AGENT_STARTED), false);
  assert.equal(isOwnChild(undefined, AGENT_STARTED + 5_000, AGENT_STARTED), false);
});

test('a liveness file without startedAt keeps the old reading', () => {
  // An older CLI wrote no `startedAt`. Guessing strict here would make every
  // resume yield against its own child, which is the worse failure.
  assert.equal(isOwnChild(OWN_ENTRYPOINT, undefined, AGENT_STARTED), true);
});

/**
 * `liveStatus` is what lets the web tell a held-open session from a working
 * one. Only the three values the CLI writes pass; anything else — an older CLI
 * with no field, a value this build does not know — is left out, because the
 * web's enum would otherwise refuse the frame and «absent» already means «not
 * known to be working».
 */
test('liveStatusOf passes the three CLI states through and drops everything else', () => {
  assert.equal(liveStatusOf('busy'), 'busy');
  assert.equal(liveStatusOf('waiting'), 'waiting');
  assert.equal(liveStatusOf('idle'), 'idle');
  assert.equal(liveStatusOf(undefined), undefined);
  assert.equal(liveStatusOf('running'), undefined);
  assert.equal(liveStatusOf(1), undefined);
});

/**
 * PID reuse. A liveness file outlives its process, and the kernel hands the
 * number out again; `kill(pid, 0)` then reads a stranger as the session's
 * writer. `sameProcess` is the second question — «is it still the process that
 * wrote this record» — and its «cannot tell» answers must all be «yes»: the
 * opposite mistake judges a live editor a stranger and opens a second writer.
 */

const probeOf = (token: string | undefined): ProcessProbe => ({
  token: async () => token,
});

test('a procStart that differs from the OS token is another process', async () => {
  const record: LivenessRecord = { pid: 10, procStart: '1000' };
  assert.equal(await sameProcess(record, probeOf('1000')), true);
  assert.equal(await sameProcess(record, probeOf('2000')), false);
  // The token is decisive whatever startedAt says.
  assert.equal(await sameProcess({ ...record, startedAt: 5_000 }, probeOf('2000')), false);
  assert.equal(await sameProcess({ ...record, startedAt: 5_000 }, probeOf('1000')), true);
});

test('without procStart there is no fingerprint, and no fingerprint means «same»', async () => {
  // An older CLI's record carries only a wall-clock `startedAt`; judging it
  // against the OS start time compares two clocks that can disagree, and a
  // live editor judged a stranger opens a second writer. So: no verdict.
  const record: LivenessRecord = { pid: 10, startedAt: 1_000_000 };
  assert.equal(await sameProcess(record, probeOf('7')), true);
  assert.equal(await sameProcess({ ...record, procStart: '  ' }, probeOf('7')), true, 'blank = none');
  assert.equal(await sameProcess({ pid: 10 }, probeOf('7')), true);
});

test('whatever cannot be told is kept as the same process', async () => {
  // The OS gives no token (Windows, a read error, the process just exited).
  assert.equal(await sameProcess({ pid: 10, procStart: '1', startedAt: 1 }, probeOf(undefined, 9_999_999)), true);
  // A token, but neither procStart nor startedAt on the record (an older CLI).
  assert.equal(await sameProcess({ pid: 10 }, probeOf('7', 9_999_999)), true);
  // A startedAt, but no start time from the OS.
  assert.equal(await sameProcess({ pid: 10, startedAt: 1 }, probeOf('7', undefined)), true);
  // Not a record about a pid at all.
  assert.equal(await sameProcess({ procStart: '1' }, probeOf('2')), true);
});

test('a reused pid is reported once per pid, then stays quiet', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const gone: SameProcessCheck = async () => false;
    const record: LivenessRecord = { pid: 424_242, sessionId: 'sess-reuse' };
    assert.equal(await stillSameProcess(record, gone), false);
    assert.equal(await stillSameProcess(record, gone), false);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(
      warn.mock.calls[0]?.arguments[0],
      '[agent] liveness record for pid 424242 belongs to another process now (session sess-reuse) — ignored',
    );
    assert.equal(await stillSameProcess({ pid: 424_243 }, async () => true), true);
    assert.equal(warn.mock.callCount(), 1, 'a record that passes logs nothing');
  } finally {
    warn.mock.restore();
  }
});

/** A directory of `<pid>.json` files, as the CLI writes them. */
async function withRecords<T>(
  records: Record<string, unknown>[],
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'liveness-'));
  try {
    for (const [i, record] of records.entries()) {
      await writeFile(path.join(dir, `${i}.json`), JSON.stringify(record));
    }
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A writer from a PREVIOUS agent / an editor: alive (it is this very process), never ours. */
const editor = (over: Record<string, unknown> = {}) => ({
  pid: process.pid,
  sessionId: 'sess-editor',
  entrypoint: 'claude-vscode',
  cwd: '/srv/work',
  startedAt: Date.now() - 3_600_000,
  ...over,
});

test('readers skip a record whose procStart no longer matches the pid', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const probe = probeOf('1000');
    const check: SameProcessCheck = (record) => sameProcess(record, probe);
    await withRecords(
      [
        editor({ sessionId: 'sess-same', procStart: '1000' }),
        editor({ sessionId: 'sess-reused', procStart: '2000' }),
      ],
      async (dir) => {
        const live = await readLiveSessions({ dir, sameProcess: check });
        assert.deepEqual([...live.keys()], ['sess-same']);
        assert.equal(await findLivePidForSession('sess-reused', { dir, sameProcess: check }), undefined);
        const hit = await findLivePidForSession('sess-same', { dir, sameProcess: check });
        assert.equal(hit?.pid, process.pid);
        assert.equal(hit?.procStart, '1000', 'the fingerprint rides along for the kill');
      },
    );
  } finally {
    warn.mock.restore();
  }
});

test('readers keep a record with no procStart whatever its startedAt says', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const startedAt = Date.now() - 3_600_000;
    const check: SameProcessCheck = (record) => sameProcess(record, probeOf('7'));
    await withRecords([editor({ sessionId: 'sess-old', startedAt })], async (dir) => {
      assert.equal((await readLiveSessions({ dir, sameProcess: check })).size, 1);
      assert.equal((await findLivePidForSession('sess-old', { dir, sameProcess: check }))?.pid, process.pid);
    });
  } finally {
    warn.mock.restore();
  }
});

test('readers keep a record when the OS token is unknown', async () => {
  const check: SameProcessCheck = (record) => sameProcess(record, probeOf(undefined));
  await withRecords([editor({ sessionId: 'sess-blind', procStart: '2000' })], async (dir) => {
    assert.deepEqual([...(await readLiveSessions({ dir, sameProcess: check })).keys()], ['sess-blind']);
    assert.equal((await findLivePidForSession('sess-blind', { dir, sameProcess: check }))?.pid, process.pid);
  });
});

test('our own children are never probed', async () => {
  const check: SameProcessCheck = async (record) => {
    throw new Error(`probed pid ${String(record.pid)} — an own child must never reach the check`);
  };
  const own = { pid: process.pid, sessionId: 'sess-own', entrypoint: OWN_ENTRYPOINT, startedAt: Date.now() };
  const sdk = { pid: process.pid, sessionId: 'sess-sdk', entrypoint: 'sdk-ts', startedAt: Date.now() };
  await withRecords([own, sdk], async (dir) => {
    assert.equal((await readLiveSessions({ dir, sameProcess: check })).size, 0);
    assert.equal(await findLivePidForSession('sess-own', { dir, sameProcess: check }), undefined);
    assert.equal(await findLivePidForSession('sess-sdk', { dir, sameProcess: check }), undefined);
  });
  // ...whereas a child of a PREVIOUS agent is a candidate writer, and is probed.
  const leftover = { ...own, startedAt: Date.now() - 3_600_000 };
  await withRecords([leftover], async (dir) => {
    await assert.rejects(readLiveSessions({ dir, sameProcess: check }), /must never reach the check/);
  });
});

test('a dead pid is not probed either', async () => {
  const check: SameProcessCheck = async () => {
    throw new Error('probed a dead pid');
  };
  await withRecords([editor({ pid: 2_000_000_000 })], async (dir) => {
    assert.equal((await readLiveSessions({ dir, sameProcess: check })).size, 0);
  });
});

test('against the real OS this process is its own record (no false «reused»)', async () => {
  // The default probe, no injection: a record that describes the running
  // process must read as the same process — the failure that matters most.
  const procStart = await processStartToken(process.pid);
  await withRecords(
    [
      editor({ sessionId: 'sess-clock', startedAt: Date.now() }),
      editor({ sessionId: 'sess-token', ...(procStart === undefined ? {} : { procStart }) }),
    ],
    async (dir) => {
      assert.deepEqual([...(await readLiveSessions({ dir })).keys()].sort(), ['sess-clock', 'sess-token']);
    },
  );
});
