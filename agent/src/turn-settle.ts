/**
 * When is a turn REALLY over — the moment the person has the floor?
 *
 * The SDK's `result` says a turn ended, never that the work did. A turn that
 * closes on «запустил агента в фоне, дождусь» is followed, minutes later, by
 * the CLI waking itself on the task's notification and carrying on. Anything
 * that reads `result` as "your move" — the suggestion strip under the reply —
 * lands in the middle of work.
 *
 * Two SDK signals together say it properly:
 * - `session_state_changed: idle` — the SDK's own "authoritative turn-over
 *   signal", fired after the held-back result flushes;
 * - `background_tasks_changed` — the full set of live background tasks
 *   (REPLACE semantics; we keep only its size).
 *
 * Settled = a successful `result` has arrived, the state is idle, no
 * background task is alive, and that has held for `delayMs` (a task finishing
 * empties the set a beat before the CLI flips to `running` to handle its
 * notification — without the hold that gap reads as settled). Emitted once per
 * turn. A CLI that never sends `session_state_changed` is treated as idle
 * after its `result`, so the signal degrades to "the turn ended with nothing
 * in the background" rather than to silence.
 */
export type SessionState = 'idle' | 'running' | 'requires_action';

export class TurnSettle {
  private state: SessionState | undefined;
  private background = 0;
  /** A successful result arrived and has not been announced as settled yet. */
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onSettled: () => void,
    private readonly delayMs = 1500,
  ) {}

  /** A turn finished successfully (a failed turn is not a handoff to suggest on). */
  result(): void {
    this.pending = true;
    this.check();
  }

  sessionState(state: string | undefined): void {
    if (state !== 'idle' && state !== 'running' && state !== 'requires_action') return;
    this.state = state;
    if (state !== 'idle') this.cancel();
    this.check();
  }

  backgroundTasks(count: number): void {
    this.background = Math.max(0, count);
    if (this.background > 0) this.cancel();
    this.check();
  }

  /** The person spoke: whatever was pending is superseded by the new turn. */
  input(): void {
    this.pending = false;
    this.cancel();
  }

  dispose(): void {
    this.pending = false;
    this.cancel();
  }

  private ready(): boolean {
    return this.pending && (this.state === undefined || this.state === 'idle') && this.background === 0;
  }

  private check(): void {
    if (!this.ready() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.ready()) return;
      this.pending = false;
      this.onSettled();
    }, this.delayMs);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
