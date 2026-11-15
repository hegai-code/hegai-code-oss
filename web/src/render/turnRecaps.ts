import type { RenderBlock } from '@cc-remote/shared';
import type { TranscriptLine } from '../central-reducers.js';
import { humanStep, humanToolLine, type Step } from '../stepText.js';
import type { LiveItem, TranscriptItem } from './Blocks.js';

/** What one finished turn did: its steps in words and how long it took. */
export interface TurnRecapData {
  steps: Step[];
  ms?: number;
}

/** The turn still open where a phase stopped — the next phase goes on with it. */
export interface RecapFold {
  done: Map<string, TurnRecapData>;
  steps: Step[];
  startTs?: number;
  endTs?: number;
  /** Machinery came after the last timestamped line: the real end is unknown. */
  openEnd: boolean;
  /** The turn's human message is in view. A history page that begins mid-turn
   *  holds only its tail — a count of that would claim to be the whole. */
  started: boolean;
  lastId?: string;
}

const EMPTY: RecapFold = { done: new Map(), steps: [], openEnd: false, started: false };

function flush(f: RecapFold): void {
  if (f.started && f.lastId && f.steps.length) {
    const ms = !f.openEnd && f.startTs !== undefined && f.endTs !== undefined && f.endTs > f.startTs ? f.endTs - f.startTs : undefined;
    f.done.set(f.lastId, ms !== undefined ? { steps: f.steps, ms } : { steps: f.steps });
  }
  f.steps = [];
  f.endTs = undefined;
  f.openEnd = false;
}

const blockSteps = (f: RecapFold, blocks: RenderBlock[] | undefined) => {
  for (const b of blocks ?? []) if (b.kind === 'tool_use') f.steps.push(humanStep(b.name, b.input));
};
const lineSteps = (f: RecapFold, lines: TranscriptLine[] | undefined) => {
  for (const l of lines ?? []) if (l.kind === 'tool_use') f.steps.push(humanToolLine(l.text));
};

/** The history phase: memoize it on the history alone, so a streamed token
 *  does not rescan two thousand messages. */
export function foldHistoryRecaps(history: TranscriptItem[]): RecapFold {
  const f: RecapFold = { ...EMPTY, done: new Map(), steps: [] };
  for (const it of history) {
    if (it.kind === 'msg' && it.msg.type === 'user') {
      flush(f);
      f.started = true;
      f.startTs = it.msg.ts;
    } else if (it.kind === 'msg') {
      blockSteps(f, it.runBefore);
      if (it.msg.ts !== undefined) {
        f.endTs = it.msg.ts;
        f.openEnd = false;
      }
      if (it.runAfter?.some((b) => b.kind === 'tool_use')) f.openEnd = true;
      blockSteps(f, it.runAfter);
    } else if (it.kind === 'run') {
      blockSteps(f, it.blocks);
      if (it.blocks.some((b) => b.kind === 'tool_use')) f.openEnd = true;
    }
    f.lastId = it.id;
  }
  return f;
}

/**
 * Where the «Что сделано» blocks go (19.10.2026): one after the last item of
 * every finished agent turn, keyed by that item's id. A turn is everything
 * between two human messages; the last one is finished only when the run is
 * not busy. History and the live tail are one transcript — a turn that began
 * on disk and goes on streaming is counted once, across both. The duration is
 * left out when the turn ended in machinery with no stamp after it.
 */
export function turnRecaps(history: TranscriptItem[] | RecapFold, live: LiveItem[], busy: boolean): Map<string, TurnRecapData> {
  const base = Array.isArray(history) ? foldHistoryRecaps(history) : history;
  const f: RecapFold = { ...EMPTY, ...base, done: new Map(base.done), steps: [...base.steps] };
  for (const it of live) {
    if (it.kind === 'line' && it.line.kind === 'user') {
      flush(f);
      f.started = true;
      f.startTs = it.line.ts;
    } else if (it.kind === 'line') {
      lineSteps(f, it.runBefore);
      if (it.line.ts !== undefined) {
        f.endTs = it.line.ts;
        f.openEnd = false;
      }
      if (it.runAfter?.lines.some((l) => l.kind === 'tool_use')) f.openEnd = true;
      lineSteps(f, it.runAfter?.lines);
    } else {
      lineSteps(f, it.lines);
      if (it.lines.some((l) => l.kind === 'tool_use')) f.openEnd = true;
    }
    f.lastId = it.id;
  }
  if (!busy) flush(f);
  return f.done;
}
