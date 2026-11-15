import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { terminatePid, terminatePidOutcome, type PidControls } from '../src/kill-pid.js';
import { parseEtime } from '../src/orphans.js';

/**
 * The kill half of force-takeover, now shared with the `orphans` CLI. What is
 * under test is the PROOF, not the signal: "we sent SIGTERM" must never be
 * reported as "the writer is gone".
 *
 * The clock is virtual. The loop is defined in seconds, and a test that waited
 * them out would spend six seconds asserting one branch.
 */
function harness(diesAfterMs: number | null) {
  const signals: NodeJS.Signals[] = [];
  let clock = 0;
  const c: PidControls = {
    killProcess: (_pid, signal) => void signals.push(signal),
    pidIsAlive: () => diesAfterMs === null || clock < diesAfterMs,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
  return { signals, c };
}

test('SIGTERM alone is enough when the process goes', async () => {
  const { signals, c } = harness(0);
  assert.equal(await terminatePid(1234, c), true);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('a process that ignores SIGTERM gets SIGKILL, and death is still confirmed', async () => {
  const { signals, c } = harness(5_000);
  assert.equal(await terminatePid(1234, c), true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('ESRCH on SIGTERM means it was already gone', async () => {
  const c: PidControls = {
    killProcess: () => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    },
    pidIsAlive: () => {
      throw new Error('must not be consulted — ESRCH already answered');
    },
    sleep: async () => {},
  };
  assert.equal(await terminatePid(1234, c), true);
});

test('a pid that survives everything reports failure, not success', async () => {
  // The single-writer invariant hangs off this branch: a caller that reads
  // `false` as "probably fine" launches a second writer into a live transcript.
  const { signals, c } = harness(null);
  assert.equal(await terminatePid(1234, c), false);
  assert.ok(signals.includes('SIGKILL'), 'it must at least have insisted');
});

/**
 * PID reuse inside the kill loop. SIGKILL goes out four seconds after SIGTERM;
 * a pid the kernel hands to another process in that gap would be killed by a
 * loop that only asks «is the pid alive». With an `expectedStart` the token is
 * re-read before EVERY signal.
 */
function guarded(diesAfterMs: number | null, tokenAt: (clock: number) => string | undefined) {
  const h = harness(diesAfterMs);
  const reads: number[] = [];
  // `harness` owns the virtual clock through `now`; read it back from there.
  const clock = (): number => (h.c.now as () => number)();
  const c: PidControls = {
    ...h.c,
    processStart: async () => {
      reads.push(clock());
      return tokenAt(clock());
    },
  };
  return { ...h, c, reads };
}

test('the escalation stops when the start token changes between signals', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    // Same process for the SIGTERM; by the time SIGKILL is due the pid has been
    // handed to somebody else.
    const { signals, c } = guarded(null, (clock) => (clock < 4_000 ? '1000' : '2000'));
    assert.equal(await terminatePidOutcome(1234, c, '1000'), 'reused');
    assert.deepEqual(signals, ['SIGTERM'], 'SIGKILL must not reach the stranger');
    assert.equal(warn.mock.callCount(), 1, 'the log says why');
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /pid 1234.*another process/);
  } finally {
    warn.mock.restore();
  }
});

test('a pid that is already someone else when we start is not signalled at all', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const { signals, c } = guarded(null, () => '2000');
    assert.equal(await terminatePidOutcome(1234, c, '1000'), 'reused');
    assert.deepEqual(signals, []);
    // The boolean form refuses too: it never claims the writer was proven dead.
    assert.equal(await terminatePid(1234, c, '1000'), false);
  } finally {
    warn.mock.restore();
  }
});

test('a matching or unreadable token does not get in the way of the kill', async () => {
  const same = guarded(5_000, () => ' 1000\n');
  assert.equal(await terminatePid(1234, same.c, '1000'), true);
  assert.deepEqual(same.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(same.reads.length, 2, 'once before each signal');

  // «Cannot tell» is not «different»: the pid-alive proof still decides.
  const blind = guarded(5_000, () => undefined);
  assert.equal(await terminatePidOutcome(1234, blind.c, '1000'), 'gone');
  assert.deepEqual(blind.signals, ['SIGTERM', 'SIGKILL']);
});

test('without an expectedStart the token is never read', async () => {
  const { signals, c } = harness(5_000);
  c.processStart = async () => {
    throw new Error('must not be consulted');
  };
  assert.equal(await terminatePid(1234, c), true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('the outcome tells «still there» from «gone»', async () => {
  assert.equal(await terminatePidOutcome(1234, harness(0).c), 'gone');
  assert.equal(await terminatePidOutcome(1234, harness(null).c), 'survived');
});

/** `ps -o etime=` is how a tool outside the agent dates the running agent. */
test('etime parses in every shape both ps implementations emit', () => {
  assert.equal(parseEtime('  01:30'), 90_000);
  assert.equal(parseEtime('03:12:45'), 3 * 3_600_000 + 12 * 60_000 + 45_000);
  assert.equal(parseEtime('2-03:00:00'), (2 * 24 + 3) * 3_600_000);
  assert.equal(parseEtime('\n 00:07 \n'), 7_000);
});

test('an unparseable etime is undefined, never a guess', () => {
  // A guess low here dates the agent as young, and every healthy child it is
  // driving is then reported as abandoned work.
  for (const raw of ['', 'n/a', '???', 'ps: no such process', '12']) {
    assert.equal(parseEtime(raw), undefined, JSON.stringify(raw));
  }
});

// A liveness record is a file any process of the user can write. `"pid":-1`
// would make `process.kill` signal EVERY process of the user, `0` our own
// group; neither may ever be signalled, whatever the record says.
test('pids that are not a process id are never signalled', async () => {
  const { terminatePidOutcome } = await import('../src/kill-pid.js');
  for (const pid of [-1, 0, 1, 1.5, Number.NaN]) {
    let signalled = false;
    const outcome = await terminatePidOutcome(pid as number, {
      killProcess: () => {
        signalled = true;
      },
      pidIsAlive: () => true,
      sleep: async () => {},
    });
    assert.equal(signalled, false, `pid ${pid} must not be signalled`);
    assert.equal(outcome, 'survived');
  }
});
