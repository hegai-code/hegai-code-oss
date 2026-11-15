/**
 * Ending a writer and PROVING it ended.
 *
 * This is the kill half of force-takeover, and the proof is the whole point:
 * the single-writer invariant is not «we asked the other writer to stop», it is
 * «the other writer is gone». SIGTERM asks. Only the pid disappearing answers.
 *
 * It lives in its own file because there must be exactly one of it. `takeover`
 * (`run-manager.ts`) drives it for a session the hub is taking back; the
 * `orphans` CLI drives it for a child of a dead agent that no board row reaches
 * any more. A second copy written for the second caller is how the two would
 * drift apart on the one behaviour neither may get wrong.
 */

import { processStartToken, sameStartToken } from './proc-start.js';
import { isValidPid } from './sessions.js';

/** The process primitives, injected so tests need no real processes. */
export interface PidControls {
  killProcess: (pid: number, signal: NodeJS.Signals) => void;
  pidIsAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /** The clock, injectable for the same reason `sleep` is: the escalation this
   *  loop performs is defined in seconds, and a test that waited them out in
   *  real time would take six of them to assert one branch. */
  now?: () => number;
  /** The start token of the process now at `pid`, read fresh (not from a cache).
   *  Only consulted when `terminatePid` is given an `expectedStart`. */
  processStart?: (pid: number) => Promise<string | undefined>;
}

/**
 * How a kill ended.
 *  - `gone`: the pid no longer exists — the writer is dead, proven.
 *  - `survived`: still there after SIGKILL — refuse to proceed.
 *  - `reused`: the pid is somebody else's process now (its start token differs
 *    from the one the liveness record carried). We stopped BEFORE signalling it.
 *    Whatever the record named is no longer at that pid, but this loop did not
 *    prove it dead, so `terminatePid` reports it as a refusal.
 */
export type TerminateOutcome = 'gone' | 'survived' | 'reused';

/** Ask for ~4s, then insist; give up at 6s. */
const ESCALATE_AFTER_MS = 4000;
const GIVE_UP_AFTER_MS = 6000;

/**
 * SIGTERM, escalate to SIGKILL after ~4s; resolve true once the pid is gone.
 *
 * False means the process is STILL THERE after SIGKILL — a wedged uninterruptible
 * state, or a pid we are not allowed to signal — OR that the pid turned out to
 * belong to another process (see `expectedStart`). Callers must treat that as a
 * refusal to proceed, never as a slow success: launching a second writer on a
 * false here is precisely how a transcript gets corrupted. A caller that needs to
 * tell the cases apart uses `terminatePidOutcome`.
 */
export async function terminatePid(
  pid: number,
  c: PidControls,
  expectedStart?: string,
): Promise<boolean> {
  return (await terminatePidOutcome(pid, c, expectedStart)) === 'gone';
}

/**
 * `terminatePid` with the reason spelled out.
 *
 * `expectedStart` is the `procStart` the liveness record carried. When given,
 * the start token of the process at `pid` is re-read before EVERY signal, and
 * if it is known and differs we stop: the pid was reused, and the next signal
 * would hit a process nobody asked us to end — the SIGKILL four seconds after
 * the SIGTERM is exactly where that would happen. An unreadable token (the
 * process just exited, an OS that does not tell) does not stop the loop: it is
 * «cannot tell», and the pid-alive proof below still decides the outcome.
 * Without `expectedStart` nothing is checked — the previous behaviour, for
 * records an older CLI wrote with no fingerprint.
 */
export async function terminatePidOutcome(
  pid: number,
  c: PidControls,
  expectedStart?: string,
): Promise<TerminateOutcome> {
  // Never a signal to -1 (every process of the user), 0 (our own group) or
  // init, whatever a record says. Reported as «survived»: the caller refuses
  // the takeover, which is the safe reading of a pid nobody can vouch for.
  if (!isValidPid(pid)) {
    console.warn(`[agent] refusing to signal pid ${String(pid)} — not a process id a record may name`);
    return 'survived';
  }
  const readStart = c.processStart ?? ((p: number) => processStartToken(p, { fresh: true }));
  /** True if it is still the process the record named, or we cannot tell. */
  const stillTarget = async (): Promise<boolean> => {
    if (expectedStart === undefined) return true;
    const current = await readStart(pid);
    if (current === undefined || sameStartToken(current, expectedStart)) return true;
    console.warn(
      `[agent] not signalling pid ${pid}: its start token is "${current}", the liveness record ` +
        `says "${expectedStart}" — the pid belongs to another process now`,
    );
    return false;
  };

  if (!(await stillTarget())) return 'reused';
  try {
    c.killProcess(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
  }
  const now = c.now ?? Date.now;
  const start = now();
  let escalated = false;
  while (now() - start < GIVE_UP_AFTER_MS) {
    if (!c.pidIsAlive(pid)) return 'gone';
    if (!escalated && now() - start > ESCALATE_AFTER_MS) {
      escalated = true;
      if (!(await stillTarget())) return 'reused';
      try {
        c.killProcess(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await c.sleep(250);
  }
  return c.pidIsAlive(pid) ? 'survived' : 'gone';
}
