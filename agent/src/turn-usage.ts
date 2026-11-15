import { asRecord as record } from './json-util.js';

/** Runtime readings, never estimates from rendered text. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export class ClaudeTurnUsage {
  private messages = new Map<string, number>();
  reset(): void { this.messages.clear(); }
  receive(message: unknown): number | undefined {
    const m = record(message), usage = record(m?.['usage']);
    if (typeof m?.['id'] !== 'string' || !usage) return;
    const input = tokenCount(usage['input_tokens']), output = tokenCount(usage['output_tokens']);
    if (input === undefined || output === undefined) return;
    // Claude's cache counters are disjoint from input_tokens. Thinking is already
    // included in output_tokens; nested cache_creation breakdown must not be added.
    const read = tokenCount(usage['cache_read_input_tokens'] ?? 0);
    const write = tokenCount(usage['cache_creation_input_tokens'] ?? 0);
    if (read === undefined || write === undefined) return;
    this.messages.set(m['id'], input + output + read + write);
    return [...this.messages.values()].reduce((sum, n) => sum + n, 0);
  }
}

export class CodexTurnUsage {
  private baseline?: number;
  reset(): void { this.baseline = undefined; }
  receive(value: unknown): number | undefined {
    const usage = record(value);
    const total = tokenCount(record(usage?.['total'])?.['totalTokens']);
    const last = tokenCount(record(usage?.['last'])?.['totalTokens']);
    if (total === undefined || last === undefined || total < last) return;
    // On resume the first event includes lifetime usage. Its `last` is the
    // current request; subsequent readings subtract this turn's baseline.
    if (this.baseline === undefined || total < this.baseline) this.baseline = total - last;
    // Codex totalTokens already includes cached input and reasoning: do not add twice.
    return total - this.baseline;
  }
}
