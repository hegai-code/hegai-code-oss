import { z } from 'zod';

/**
 * The session's plan as a checklist the person can watch — «3/7 · прогоняю
 * тесты» over the composer and on every sub-agent card.
 *
 * Why the agent supplies its own tool: Claude Code ships a checklist tool
 * (`TodoWrite`, later `TaskCreate`/`TaskUpdate`), but turns it off per model by
 * a remote flag. On CLI 2.1.319 an Opus 5.5 session gets neither, Sonnet 4.6
 * gets `TaskCreate` (probed 07.11.2026), and from 24.09 to 07.11 not one of
 * ~3000 fleet sessions wrote a plan. The agent registers `mcp__hegai__plan`
 * with TodoWrite's exact input, so every model has one tool and every client
 * reads one shape. A session from before keeps rendering: `TodoWrite` reads
 * the same.
 */
export const PLAN_TOOL = 'mcp__hegai__plan';

/** The tool names a client reads as a plan. Same input shape for both. */
export function isPlanTool(name: string | undefined): boolean {
  return name === PLAN_TOOL || name === 'TodoWrite';
}

export const PlanStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export interface PlanItem {
  content: string;
  status: PlanStatus;
  /** Present continuous, shown while the step runs («Прогоняю тесты»). */
  activeForm?: string;
}

/** A plan tool's `input.todos`, with every malformed row dropped rather than
 *  failing the whole list. `null` when the input is not a plan at all. */
export function planItems(input: unknown): PlanItem[] | null {
  const todos = (input as { todos?: unknown } | null | undefined)?.todos;
  if (!Array.isArray(todos)) return null;
  const out: PlanItem[] = [];
  for (const raw of todos) {
    const row = raw as Record<string, unknown> | null;
    if (!row || typeof row['content'] !== 'string' || !row['content'].trim()) continue;
    const status = PlanStatusSchema.safeParse(row['status']);
    const item: PlanItem = { content: row['content'], status: status.success ? status.data : 'pending' };
    if (typeof row['activeForm'] === 'string' && row['activeForm'].trim()) item.activeForm = row['activeForm'];
    out.push(item);
  }
  return out;
}

/** «done of total, doing what» — what a card or a strip draws. */
export const PlanProgressSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** The step in progress, as its `activeForm` (else its `content`). */
  active: z.string().max(160).optional(),
  /** The checklist itself for a 45 mm screen (Apple Watch): <= 12 rows, each
   *  clipped to 80 UTF-16 units. Only when asked for (`planProgress(items, true)`):
   *  sub-agent cards carry just the counts. */
  steps: z.array(z.object({ text: z.string().max(80), status: PlanStatusSchema })).max(12).optional(),
});
export type PlanProgress = z.infer<typeof PlanProgressSchema>;

export const PLAN_STEPS_MAX = 12;

/** At most 12 rows. A longer plan shows the window that starts 3 rows before
 *  the step in progress (from the top when none is), clamped to the tail. */
function planSteps(items: PlanItem[]): NonNullable<PlanProgress['steps']> {
  let start = 0;
  if (items.length > PLAN_STEPS_MAX) {
    const idx = items.findIndex((i) => i.status === 'in_progress');
    start = Math.min(Math.max(0, idx - 3), items.length - PLAN_STEPS_MAX);
  }
  return items.slice(start, start + PLAN_STEPS_MAX).map((i) => {
    const text = i.content.trim();
    return { text: text.length > 80 ? `${clipUnits(text, 79)}…` : text, status: i.status };
  });
}

export function planProgress(items: PlanItem[], withSteps = false): PlanProgress {
  const done = items.filter((i) => i.status === 'completed').length;
  const current = items.find((i) => i.status === 'in_progress');
  const progress: PlanProgress = { done, total: items.length };
  const active = current ? (current.activeForm ?? current.content).trim() : '';
  if (active) progress.active = active.length > 160 ? `${clipUnits(active, 159)}…` : active;
  if (withSteps && items.length > 0) progress.steps = planSteps(items);
  return progress;
}

/** The first `n` UTF-16 units, never ending inside a surrogate pair — a lone
 *  half is an invalid string that the hub's JSON parser would reject with the
 *  whole frame. */
function clipUnits(text: string, n: number): string {
  const head = text.slice(0, n);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}
