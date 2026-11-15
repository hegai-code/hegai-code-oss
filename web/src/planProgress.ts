import { isPlanTool, planItems, planProgress, stripHarnessNoise, type HistoryMessage, type PlanItem, type PlanProgress } from '@cc-remote/shared';
import type { TranscriptLine } from './central-reducers.js';

/** The session's plan right now: its checklist and the counts a strip draws. */
export interface CurrentPlan extends PlanProgress {
  items: PlanItem[];
}

const toPlan = (items: PlanItem[]): CurrentPlan => ({ items, ...planProgress(items) });

/** A live `tool_use` line is «Name {json}»: the plan's items, or null. */
function planOfLine(line: TranscriptLine): PlanItem[] | null {
  if (line.kind !== 'tool_use') return null;
  const sp = line.text.indexOf(' ');
  if (sp < 0 || !isPlanTool(line.text.slice(0, sp))) return null;
  try {
    return planItems(JSON.parse(line.text.slice(sp + 1)));
  } catch {
    return null;
  }
}

/** What a person typed in a history message — not a tool result or CLI notice. */
function humanText(m: HistoryMessage): string | null {
  if (m.type !== 'user' || m.blocks.some((b) => b.kind === 'tool_result')) return null;
  const text = m.blocks
    .map((b) => (b.kind === 'text' ? stripHarnessNoise(b.text) : ''))
    .join('')
    .trim();
  if (text) return text;
  // A picture alone is a turn too (iOS `CurrentPlan.isHuman` counts it): the
  // walk must stop there, not run on into the previous task's plan.
  return m.blocks.some((b) => b.kind === 'image') ? '' : null;
}

/**
 * The plan of the CURRENT task: the latest plan call of the main thread after
 * the person's last message. A plan from before it belonged to an earlier task.
 *
 * The live tail is fresher than the file, so it is read first. When the tail
 * holds the person's own line, that line is the turn's start and the search
 * ends there; only a tail with no human line falls through to the file.
 */
export function currentPlan(history: readonly HistoryMessage[], lines: readonly TranscriptLine[]): CurrentPlan | null {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.kind === 'user') {
      start = i;
      break;
    }
  }
  for (let i = lines.length - 1; i > start; i--) {
    const items = planOfLine(lines[i]!);
    if (items) return toPlan(items);
  }
  // The person's line is live: this turn's plan, if any, is after it. The
  // file is not read — nothing ties its last human message to THIS line
  // (a repeated «продолжай», a picture, a clipped prompt all fool a text
  // match), and a missing strip beats the previous task's count.
  if (start >= 0) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (humanText(m) !== null) return null;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j]!;
      if (b.kind === 'tool_use' && isPlanTool(b.name)) {
        const items = planItems(b.input);
        if (items) return toPlan(items);
      }
    }
  }
  return null;
}
