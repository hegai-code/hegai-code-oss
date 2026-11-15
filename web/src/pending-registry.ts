type RejectHook = (error: Error) => void;

interface PendingEntry<TResult, TContext> {
  context: TContext;
  resolve: (value: TResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onReject?: RejectHook;
}

/**
 * Correlates request ids with promises and owns their complete lifecycle:
 * timeout, timer cleanup, individual settlement, and reject-on-socket-drop.
 * Keeping this logic in one place prevents the RPC/mirror paths from
 * drifting apart or leaking timers.
 */
export class PendingRegistry<TResult, TContext = undefined> {
  private readonly entries = new Map<string, PendingEntry<TResult, TContext>>();

  constructor(private readonly timeoutMs = 30_000) {}

  wait(
    id: string,
    context: TContext,
    timeoutMessage: string,
    onReject?: RejectHook,
  ): Promise<TResult> {
    if (this.entries.has(id)) throw new Error(`duplicate pending id: ${id}`);
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.entries.get(id);
        if (!entry) return;
        this.entries.delete(id);
        const error = new Error(timeoutMessage);
        entry.onReject?.(error);
        entry.reject(error);
      }, this.timeoutMs);
      this.entries.set(id, { context, resolve, reject, timer, onReject });
    });
  }

  context(id: string): TContext | undefined {
    return this.entries.get(id)?.context;
  }

  resolve(id: string, value: TResult): boolean {
    const entry = this.take(id);
    if (!entry) return false;
    entry.resolve(value);
    return true;
  }

  reject(id: string, error: Error): boolean {
    const entry = this.take(id);
    if (!entry) return false;
    entry.onReject?.(error);
    entry.reject(error);
    return true;
  }

  rejectAll(error: Error): void {
    const ids = [...this.entries.keys()];
    for (const id of ids) this.reject(id, error);
  }

  get size(): number {
    return this.entries.size;
  }

  private take(id: string): PendingEntry<TResult, TContext> | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }
}
