import { z } from 'zod';
import { PlanProgressSchema } from './plan.js';

/**
 * A sub-agent the session's model started — Claude's `Agent` tool, a Codex
 * `spawn_agent` thread — as every client draws it: one card in the parent's
 * transcript and one row in the panel over the composer. Never its messages:
 * those stay in the sub-agent's own transcript (`session.subagent`), because
 * streamed into the parent's they read as the session talking (10.10.2026).
 *
 * The agent sends the run's whole set as a `status` event with code
 * `subagents` and `data.agents` — a LEVEL, like `background_tasks`: each frame
 * replaces the last, and the hub replays the latest one to a late viewer.
 */
/** How many earlier actions a card keeps under «сейчас». */
export const SUBAGENT_RECENT = 3;
/** How many earlier actions the expanded «ход работы» shows. A separate field:
 *  iOS 1.0.17 drops a row whose `recent` is longer than 3. */
export const SUBAGENT_STEPS = 12;

/** Record a new «сейчас»: the previous one moves into `recent`. Shared by
 *  the Claude and Codex trackers so both cards move the same way. */
export function noteSubagentAction(
  a: { lastAction?: string; recent?: string[]; steps?: string[]; activeAt?: number },
  action: string,
  now: number,
): boolean {
  a.activeAt = now;
  if (action === a.lastAction) return false;
  if (a.lastAction) {
    a.recent = [...(a.recent ?? []), a.lastAction].slice(-SUBAGENT_RECENT);
    a.steps = [...(a.steps ?? []), a.lastAction].slice(-SUBAGENT_STEPS);
  }
  a.lastAction = action;
  return true;
}

/** It ended: nothing is «now» any more, the last step joins the trail. */
export function closeSubagentActions(a: { lastAction?: string; recent?: string[]; steps?: string[]; activeAt?: number }): void {
  if (a.lastAction) a.steps = [...(a.steps ?? []), a.lastAction].slice(-SUBAGENT_STEPS);
  delete a.lastAction;
  delete a.recent;
  delete a.activeAt;
}

export const SubagentStatusSchema = z.enum(['running', 'completed', 'failed', 'stopped']);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

export const SubagentSchema = z.object({
  /** The runtime's handle on it: Claude's `task_id`, Codex's child thread id.
   *  What `run.stopSubagent` takes. */
  id: z.string().min(1).max(200),
  /** The parent's tool call that started it — the card's anchor in the
   *  transcript and the key `session.subagent` reads by. Claude: the `Agent`
   *  tool_use id. Codex: the `spawn_agent` call id when known. */
  toolUseId: z.string().max(200).optional(),
  /** `general-purpose`, `Explore`, a Codex role or nickname. */
  kind: z.string().max(80),
  /** The task in a few words, as the model named it. */
  description: z.string().max(200),
  status: SubagentStatusSchema,
  /** Started with `run_in_background` / not awaited by the turn. */
  background: z.boolean().optional(),
  /** ms epoch. */
  startedAt: z.number(),
  endedAt: z.number().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  /** What it is doing now, one line («Bash · git status»). Running only. */
  lastAction: z.string().max(160).optional(),
  /** The few actions before `lastAction`, oldest first — enough to see it
   *  moving without opening its transcript. Running only. */
  recent: z.array(z.string().max(160)).max(SUBAGENT_RECENT).optional(),
  /** The longer trail behind `recent`, for the expanded «ход работы». Kept
   *  after the end too: what it did is the point of looking. */
  steps: z.array(z.string().max(160)).max(SUBAGENT_STEPS).optional(),
  /** ms epoch of its last sign of work. A running agent that has not moved for
   *  a while is shown as such, so «is it stuck?» has an answer on screen. */
  activeAt: z.number().optional(),
  /** Its final report, capped. Ended only. */
  summary: z.string().max(2000).optional(),
  model: z.string().max(80).optional(),
  /** Its own checklist, if it keeps one (`mcp__hegai__plan`): «3/5 · сейчас».
   *  Kept after the end — the last count says how far it got. */
  plan: PlanProgressSchema.optional(),
});
export type Subagent = z.infer<typeof SubagentSchema>;

/** At most this many go on the wire; the oldest finished ones drop first. */
export const SUBAGENTS_MAX = 32;

/** `data` of a `subagents` status event. Malformed rows are dropped rather
 *  than failing the frame — one bad agent must not blank the others. */
export function parseSubagents(data: unknown): Subagent[] {
  const raw = (data as { agents?: unknown } | null | undefined)?.agents;
  if (!Array.isArray(raw)) return [];
  const out: Subagent[] = [];
  for (const row of raw) {
    const parsed = SubagentSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out.slice(0, SUBAGENTS_MAX);
}

/**
 * What a Claude `<task-notification>` says about a background agent that
 * finished: the CLI writes it into the transcript as a USER message when the
 * task ends, and it is the only record of that ending in the parent's file.
 * Read by the history card (a reload has no live `subagents` frame).
 */
export interface TaskNotice {
  toolUseId?: string;
  taskId?: string;
  status?: SubagentStatus;
  summary?: string;
}

const tag = (text: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m?.[1]?.trim() || undefined;
};

export function parseTaskNotification(text: string): TaskNotice | null {
  if (!text.includes('<task-notification>')) return null;
  const raw = tag(text, 'status');
  const status: SubagentStatus | undefined =
    raw === 'completed' ? 'completed' : raw === 'failed' ? 'failed' : raw === 'stopped' || raw === 'killed' ? 'stopped' : undefined;
  const summary = tag(text, 'result') ?? tag(text, 'summary');
  return {
    toolUseId: tag(text, 'tool-use-id'),
    taskId: tag(text, 'task-id'),
    status,
    summary: summary ? summary.slice(0, 2000) : undefined,
  };
}
