import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOOP_WATCHDOG_DEFAULT_SEC, loopWatchdogSeconds, startLoopWatchdog } from '../src/loop-watchdog.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('CC_REMOTE_LOOP_WATCHDOG_SEC: default, explicit, off, garbage', () => {
  assert.equal(loopWatchdogSeconds({}), LOOP_WATCHDOG_DEFAULT_SEC);
  assert.equal(loopWatchdogSeconds({ CC_REMOTE_LOOP_WATCHDOG_SEC: '300' }), 300);
  assert.equal(loopWatchdogSeconds({ CC_REMOTE_LOOP_WATCHDOG_SEC: '0' }), 0);
  assert.equal(loopWatchdogSeconds({ CC_REMOTE_LOOP_WATCHDOG_SEC: 'soon' }), LOOP_WATCHDOG_DEFAULT_SEC);
  assert.equal(loopWatchdogSeconds({ CC_REMOTE_LOOP_WATCHDOG_SEC: '-5' }), LOOP_WATCHDOG_DEFAULT_SEC);
  assert.equal(startLoopWatchdog({ stallSec: 0 }), undefined);
});

test('a healthy loop is left alone', async () => {
  const stalls: number[] = [];
  const wd = startLoopWatchdog({ stallSec: 0.3, beatMs: 20, checkMs: 20, onStall: (ms) => stalls.push(ms) });
  try {
    await sleep(900);
    assert.deepEqual(stalls, []);
  } finally {
    wd?.stop();
  }
});

test('a loop stuck past the threshold is reported by the other thread', { timeout: 10_000 }, async () => {
  const stalls: number[] = [];
  let ready!: () => void;
  let reported!: () => void;
  const workerReady = new Promise<void>((resolve) => { ready = resolve; });
  const stallReported = new Promise<void>((resolve) => { reported = resolve; });
  let deadlineTimer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('watchdog did not become ready and report the stall')), 7000);
  });
  const wd = startLoopWatchdog({
    stallSec: 0.3, beatMs: 20, checkMs: 100, onReady: ready,
    onStall: (ms) => { stalls.push(ms); reported(); },
  });
  try {
    assert.ok(wd);
    // Worker startup can exceed 100ms on a busy CI host. Start the freeze only
    // when its timer exists; block the main loop without competing for CPU
    // with the worker (whose suspension guard correctly ignores starvation).
    await Promise.race([workerReady, deadline]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    await Promise.race([stallReported, deadline]);
    assert.equal(stalls.length, 1);
    assert.ok(stalls[0]! >= 300);
  } finally {
    clearTimeout(deadlineTimer);
    wd?.stop();
  }
});

test('for real: a process whose loop freezes is killed, and says why on stderr', { timeout: 20_000, skip: process.platform === 'win32' }, async () => {
  const mod = fileURLToPath(new URL('../src/loop-watchdog.ts', import.meta.url));
  const code = `
    const { startLoopWatchdog } = await import(${JSON.stringify(mod)});
    startLoopWatchdog({ stallSec: 1, beatMs: 50, checkMs: 100 });
    setTimeout(() => { for (;;) {} }, 200);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const started = Date.now();
  // If the watchdog did NOT fire, the child spins forever; stop it ourselves,
  // and remember that it was us, so a SIGKILL from here cannot pass the test.
  let rescued = false;
  const rescue = setTimeout(() => {
    rescued = true;
    child.kill('SIGKILL');
  }, 12_000);
  const { signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  clearTimeout(rescue);
  assert.equal(rescued, false, 'the watchdog never fired; the test had to kill the child');
  assert.equal(signal, 'SIGKILL');
  assert.ok(Date.now() - started < 10_000);
  assert.match(stderr, /loop-watchdog: event loop stuck for \d+s/);
});
