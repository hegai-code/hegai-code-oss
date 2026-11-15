import type { UsageInfo } from '@cc-remote/shared';
import { fetchUsage, lastUsageHttp } from './usage.js';

type UsageHttp = ReturnType<typeof lastUsageHttp>;

/** Wait for the hub's owner policy before any Claude API call. Disconnects
 *  cancel old requests, so a late reading cannot cross a pause/reconnect. */
export class ClaudeUsageMonitor {
  private controller?: AbortController;

  constructor(
    private readonly read: (signal: AbortSignal) => Promise<UsageInfo | null> = fetchUsage,
    private readonly http: () => UsageHttp = lastUsageHttp,
  ) {}

  configure(enabled = true): void {
    this.stop();
    if (enabled) this.controller = new AbortController();
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  async poll(): Promise<{ usage: UsageInfo | null; http?: UsageHttp }> {
    const controller = this.controller;
    if (!controller) return { usage: null };
    const usage = await this.read(controller.signal);
    if (controller !== this.controller || controller.signal.aborted) return { usage: null };
    return { usage, http: this.http() };
  }
}
