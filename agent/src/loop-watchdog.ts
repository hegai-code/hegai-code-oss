import { Worker } from 'node:worker_threads';

/**
 * Restart the agent when its event loop stops turning.
 *
 * Twice in two days (23 and 24.09.2026) dev-mac-mini-001 went offline with its
 * agent ALIVE: once a replication loop that never yielded, once a pty write
 * spinning in libuv. Both times the process sat at 100% CPU, `agent.log`
 * stopped growing, the hub socket died, and nothing on the machine could notice
 * — the reconnect logic, the keepalive, the self-update all run ON the frozen
 * loop, and launchd/systemd see a live process and do nothing. It took a person
 * with a Tailscale approval and `launchctl kickstart -k` to bring it back.
 *
 * The one thing that still runs when the main loop is stuck is another thread.
 * The main thread bumps a shared counter every second; a worker checks it, and
 * if the counter has not moved for `stallSec` it writes one line to stderr
 * (synchronously, straight to fd 2 — the main thread's console is dead) and
 * kills the process. Every supervisor in the fleet restarts a dead agent:
 * launchd `KeepAlive`, systemd `Restart=always`, and on Windows the Scheduled
 * Task's repetition trigger plus the desktop app — the same path a self-update
 * exit already takes. A frozen agent is offline anyway; its held runs are
 * already past saving.
 *
 * A sleeping laptop is not a stall: when the worker itself was not scheduled
 * for several of its own periods, the machine (or the whole process) was
 * suspended, and it re-baselines instead of judging the main thread for it.
 */

/** Default threshold. Long enough that no legitimate synchronous work (the
 *  largest transcript parse is seconds) comes near it; short enough that a
 *  wedged machine is back before anyone has to go looking. */
export const LOOP_WATCHDOG_DEFAULT_SEC = 120;

/** `CC_REMOTE_LOOP_WATCHDOG_SEC`: seconds, `0` turns it off. */
export function loopWatchdogSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['CC_REMOTE_LOOP_WATCHDOG_SEC'];
  if (raw === undefined || raw.trim() === '') return LOOP_WATCHDOG_DEFAULT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return LOOP_WATCHDOG_DEFAULT_SEC;
  return n;
}

export interface LoopWatchdogOptions {
  stallSec: number;
  beatMs?: number;
  checkMs?: number;
  /** Tests: report the stall instead of killing the process. */
  onStall?: (stuckMs: number) => void;
  /** Signals that the worker has installed its timer (used by lifecycle tests). */
  onReady?: () => void;
}

export interface LoopWatchdog {
  stop(): void;
}

// The worker's code, loaded from a data: URL — the agent ships as ONE bundled
// file, so the worker cannot be a module of its own, and a data: URL is always
// an ES module (an \`eval: true\` worker is CommonJS or ESM depending on how the
// parent was loaded, and guessing wrong killed it with «require is not defined»).
const WORKER_SRC = `
import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';
const beats = new Int32Array(workerData.sab);
const { stallMs, checkMs, report } = workerData;
let last = Atomics.load(beats, 0);
let lastChange = Date.now();
let lastTick = Date.now();
let fired = false;
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > checkMs * 3) lastChange = now; // we were suspended too: not a stall
  lastTick = now;
  const b = Atomics.load(beats, 0);
  if (b !== last) { last = b; lastChange = now; fired = false; return; }
  const stuck = now - lastChange;
  if (stuck < stallMs || fired) return;
  fired = true;
  if (report) { parentPort.postMessage(stuck); return; }
  try {
    fs.writeSync(2, '[agent] loop-watchdog: event loop stuck for ' + Math.round(stuck / 1000) +
      's — exiting so the supervisor restarts the agent\\n');
  } catch {}
  process.kill(process.pid, 'SIGKILL');
}, checkMs);
parentPort.postMessage("ready");
`;

export function startLoopWatchdog(opts: LoopWatchdogOptions): LoopWatchdog | undefined {
  if (!(opts.stallSec > 0)) return undefined;
  const beatMs = opts.beatMs ?? 1000;
  const checkMs = opts.checkMs ?? 5000;
  const sab = new SharedArrayBuffer(4);
  const beats = new Int32Array(sab);
  const beat = setInterval(() => Atomics.add(beats, 0, 1), beatMs);
  beat.unref();
  let worker: Worker;
  try {
    worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SRC)}`), {
      // Not the parent's --import/--require preloads: the worker is plain JS
      // and must not inherit whatever the parent's startup might hang on.
      execArgv: [],
      workerData: { sab, stallMs: opts.stallSec * 1000, checkMs, report: !!opts.onStall },
    });
  } catch (err) {
    clearInterval(beat);
    console.warn(`[agent] loop-watchdog unavailable: ${(err as Error).message}`);
    return undefined;
  }
  worker.unref();
  worker.on('error', (err) => console.warn(`[agent] loop-watchdog failed: ${err.message}`));
  if (opts.onStall || opts.onReady) worker.on('message', (message: number | 'ready') => {
    if (message === 'ready') opts.onReady?.();
    else opts.onStall?.(message);
  });
  return {
    stop() {
      clearInterval(beat);
      void worker.terminate();
    },
  };
}
