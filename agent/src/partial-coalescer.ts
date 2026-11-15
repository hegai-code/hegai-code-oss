import type { AgentToCentral } from '@cc-remote/shared';

/**
 * Glues adjacent text deltas of one run into one `stream`/`partial` frame.
 *
 * Every `text_delta` the SDK emits used to leave the machine as its own
 * WebSocket message — dozens per second while a model types. On a phone each
 * frame is a radio wake-up, a JSON decode and a transcript re-render, and the
 * hub forwards them one for one. The wire format is unchanged: a coalesced
 * frame is an ordinary `partial` that simply carries more text.
 *
 * The rule that keeps the wire order intact: a buffered delta is flushed
 * BEFORE any other message of the same run (tool_use, status, the final
 * assistant block, result, run_status, run_mode, context_usage, …). The
 * coalescer is the one door every outbound message passes, so a new sender
 * cannot forget it. Deltas of different runs never reorder each other, so
 * only the run's own messages flush its buffer.
 *
 * A buffer is flushed at the latest `delayMs` after its first delta (a bound,
 * not a debounce — a steady stream still goes out every `delayMs`) or once it
 * holds `maxChars`. Frames sent while the socket is down are dropped by the
 * sink, exactly as before; `clear()` is for the moment the link goes away or
 * the agent stops, so nothing buffered leaks into the next connection.
 */

export const PARTIAL_FLUSH_MS = 75;
export const PARTIAL_FLUSH_CHARS = 8 * 1024;

interface Buffered {
  sessionId: string;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface PartialCoalescerOptions {
  delayMs?: number;
  maxChars?: number;
}

type PartialFrame = Extract<AgentToCentral, { type: 'stream' }>;

/** A plain text delta: nothing but `kind` and `text` — a `partial` that carries
 *  a code or data is not a delta and is never merged. */
function isPlainPartial(msg: AgentToCentral): msg is PartialFrame {
  if (msg.type !== 'stream') return false;
  const ev = msg.event;
  return ev.kind === 'partial' && typeof ev.text === 'string' && ev.code === undefined && ev.data === undefined;
}

export class PartialCoalescer {
  private readonly buffers = new Map<string, Buffered>();
  private readonly delayMs: number;
  private readonly maxChars: number;

  constructor(
    private readonly sink: (message: AgentToCentral) => boolean,
    options: PartialCoalescerOptions = {},
  ) {
    this.delayMs = options.delayMs ?? PARTIAL_FLUSH_MS;
    this.maxChars = options.maxChars ?? PARTIAL_FLUSH_CHARS;
  }

  /** Send `msg`, buffering it when it is a plain text delta. Returns what the
   *  sink returned; a buffered delta reports `true` (it is on its way). */
  send(msg: AgentToCentral): boolean {
    if (!isPlainPartial(msg)) {
      // Anything else of this run goes after the text that precedes it.
      if ('runId' in msg && typeof msg.runId === 'string') this.flush(msg.runId);
      return this.sink(msg);
    }
    const { runId, sessionId } = msg;
    let buf = this.buffers.get(runId);
    // A new session id mid-run (a fresh session learns its real id at init):
    // the frame says which session it belongs to, so do not mix the two.
    if (buf && buf.sessionId !== sessionId) {
      this.flush(runId);
      buf = undefined;
    }
    const text = msg.event.text ?? '';
    if (buf) {
      buf.text += text;
    } else {
      const timer = setTimeout(() => this.flush(runId), this.delayMs);
      timer.unref?.();
      buf = { sessionId, text, timer };
      this.buffers.set(runId, buf);
    }
    if (buf.text.length >= this.maxChars) this.flush(runId);
    return true;
  }

  /** Send one run's buffered text now. */
  flush(runId: string): void {
    const buf = this.buffers.get(runId);
    if (!buf) return;
    clearTimeout(buf.timer);
    this.buffers.delete(runId);
    this.sink({
      type: 'stream',
      sessionId: buf.sessionId,
      runId,
      event: { kind: 'partial', text: buf.text },
    });
  }

  /** Send everything buffered. */
  flushAll(): void {
    for (const runId of [...this.buffers.keys()]) this.flush(runId);
  }

  /** Drop everything buffered without sending, and stop the timers. */
  clear(): void {
    for (const buf of this.buffers.values()) clearTimeout(buf.timer);
    this.buffers.clear();
  }

  /** Runs with text waiting (tests, diagnostics). */
  get pending(): number {
    return this.buffers.size;
  }
}
