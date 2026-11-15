import type { AgentToCentral } from '@cc-remote/shared';

type ContextUsageFrame = Extract<AgentToCentral, { type: 'context_usage' }>;

/**
 * The last `context_usage` the hub was told for each run, so the 15 s poll
 * sends changes only. An idle run answers every poll with the same numbers;
 * the hub caches the value and replays it to new subscribers, so repeating it
 * was a frame (and a phone wake-up) per run per poll for nothing.
 *
 * The cache belongs to one connection: `clear()` on every (re)connect and
 * disconnect makes the first poll after it resend everything, so a hub that
 * just came back — with no memory of any run — gets the current values.
 */
export class ContextCache {
  private readonly sent = new Map<string, string>();

  private static key(f: ContextUsageFrame): string {
    return JSON.stringify([
      f.sessionId,
      f.totalTokens,
      f.maxTokens,
      f.percentage,
      f.autoCompactThreshold ?? null,
      f.autoCompactEnabled,
    ]);
  }

  /** Forget runs that are no longer live. */
  prune(liveRunIds: Iterable<string>): void {
    const live = new Set(liveRunIds);
    for (const runId of this.sent.keys()) if (!live.has(runId)) this.sent.delete(runId);
  }

  /** Send `frame` through `send` unless the hub already has exactly this. The
   *  value is remembered only when `send` reports the frame went out. */
  sendIfChanged(frame: ContextUsageFrame, send: (frame: ContextUsageFrame) => boolean): boolean {
    const key = ContextCache.key(frame);
    if (this.sent.get(frame.runId) === key) return false;
    const ok = send(frame);
    if (ok) this.sent.set(frame.runId, key);
    return ok;
  }

  clear(): void {
    this.sent.clear();
  }
}
