import { SUBAGENTS_MAX, closeSubagentActions, isPlanTool, noteSubagentAction, planItems, planProgress, type Subagent, type SubagentStatus } from '@cc-remote/shared';
import { clip, optionalString as str } from './json-util.js';

/** Who started a background task: names can repeat, the id tells them apart. */
export interface BackgroundTaskOwner {
  id: string;
  name: string;
}

/**
 * The run's sub-agents as clients draw them, folded from the SDK's task
 * messages (`task_started` / `task_progress` / `task_updated` /
 * `task_notification`) and the parent's own tool results.
 *
 * Only what a person reads: who, what, doing what now, how long, how much,
 * how it ended. Never the agent's messages — those live in its own
 * transcript, and streamed into the parent's they read as the session itself
 * talking (10.10.2026, f5d33a9).
 *
 * `snapshot()` is a LEVEL: the whole set, running first, then the most recent
 * finished, at most SUBAGENTS_MAX.
 */
export class SubagentTracker {
  private readonly agents = new Map<string, Subagent>();
  private readonly byToolUse = new Map<string, string>();
  /** What a call asked for (`Agent.input.model`), until its task starts. */
  private readonly callModel = new Map<string, string>();
  /** A sub-agent's tool call → the `Agent` call that started the sub-agent. */
  private readonly callerOf = new Map<string, string>();
  /** A background task a sub-agent started → that sub-agent. Kept apart from
   *  `agents`: the task can outlive its owner and the owner's eviction. */
  private readonly ownerOfTask = new Map<string, BackgroundTaskOwner>();
  /** The session's own model: what a sub-agent that names none runs on. */
  private defaultModel: string | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Fold one SDK message. Returns 'status' for a change a viewer should see
   *  at once, 'progress' for a counter tick (throttle it), or null. */
  receive(msg: unknown): 'status' | 'progress' | null {
    const m = msg as Record<string, unknown> | null;
    if (!m || m['type'] !== 'system') return null;
    const taskId = str(m['task_id']);
    switch (m['subtype']) {
      case 'task_started': {
        if (!taskId) return null;
        const toolUseId = str(m['tool_use_id']);
        if (!isAgentTask(m)) {
          this.noteTaskOwner(taskId, toolUseId);
          return null;
        }
        const agent: Subagent = {
          id: taskId,
          kind: clip(str(m['subagent_type']) ?? 'agent', 80),
          description: clip(str(m['description']) ?? '', 200),
          status: 'running',
          startedAt: this.now(),
        };
        if (toolUseId) {
          agent.toolUseId = toolUseId;
          this.byToolUse.set(toolUseId, taskId);
        }
        if (m['is_backgrounded'] === true) agent.background = true;
        const model = (toolUseId && this.callModel.get(toolUseId)) || this.defaultModel;
        if (model) agent.model = clip(model, 80);
        if (toolUseId) this.callModel.delete(toolUseId);
        this.agents.set(taskId, agent);
        return 'status';
      }
      case 'task_progress': {
        const a = taskId ? this.agents.get(taskId) : undefined;
        if (!a || a.status !== 'running') return null;
        this.usage(a, m['usage']);
        const action = actionOf(m);
        if (action) noteSubagentAction(a, action, this.now());
        else a.activeAt = this.now();
        return 'progress';
      }
      case 'task_updated': {
        const a = taskId ? this.agents.get(taskId) : undefined;
        if (!a) return null;
        const patch = (m['patch'] ?? {}) as Record<string, unknown>;
        let changed = false;
        if (typeof patch['is_backgrounded'] === 'boolean' && patch['is_backgrounded'] !== !!a.background) {
          a.background = patch['is_backgrounded'] as boolean;
          changed = true;
        }
        const status = statusOf(str(patch['status']));
        if (status && status !== 'running' && a.status === 'running') {
          this.end(a, status, typeof patch['end_time'] === 'number' ? (patch['end_time'] as number) : undefined);
          const error = str(patch['error']);
          if (error && !a.summary) a.summary = clip(error, 2000);
          changed = true;
        }
        return changed ? 'status' : null;
      }
      case 'task_notification': {
        if (taskId) this.ownerOfTask.delete(taskId);
        const a = taskId ? this.agents.get(taskId) : undefined;
        if (!a) return null;
        this.usage(a, m['usage']);
        const summary = str(m['summary']);
        if (summary && (a.status === 'running' || !a.summary)) a.summary = clip(summary, 2000);
        // The first ending is the ending: a Stop already marked it stopped,
        // and the CLI's trailing «completed» must not overwrite that.
        if (a.status === 'running') this.end(a, statusOf(str(m['status'])) ?? 'completed');
        return 'status';
      }
      default:
        return null;
    }
  }

  /**
   * The parent got the `Agent` call's result: a foreground agent is done, and
   * the result text is its report. A background agent's result is only
   * «launched» — its end comes as a task notification, so it is left alone.
   */
  toolResult(toolUseId: string, text: string, isError: boolean, background: boolean, resolvedModel?: string): boolean {
    const id = this.byToolUse.get(toolUseId);
    const a = id ? this.agents.get(id) : undefined;
    // The CLI names the model it actually ran — at launch for a background
    // agent, at the end for a foreground one. Better than any guess.
    let named = false;
    if (a && resolvedModel && a.model !== resolvedModel) {
      a.model = clip(resolvedModel, 80);
      named = true;
    }
    if (!a || a.status !== 'running' || background || a.background) return named;
    this.end(a, isError ? 'failed' : 'completed');
    if (text.trim()) a.summary = clip(text.trim(), 2000);
    return true;
  }

  /** The session's model, for sub-agents that name none. */
  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  /** An `Agent` call was made; remember the model it asked for, if any. */
  noteCall(toolUseId: string, input: unknown): void {
    const model = (input as { model?: unknown } | null)?.model;
    if (typeof model === 'string' && model) this.callModel.set(toolUseId, model);
    if (this.callModel.size > 64) this.callModel.delete(this.callModel.keys().next().value!);
  }

  /**
   * A sub-agent's own message: `parent_tool_use_id` names its `Agent` call, and
   * the tool calls in it are the only link between a background task and who
   * started it — the task messages carry just the task's own call id.
   */
  noteSubagentCalls(parentToolUseId: string, content: unknown): boolean {
    if (!Array.isArray(content)) return false;
    let planned = false;
    for (const block of content as Array<Record<string, unknown> | null>) {
      if (block?.['type'] !== 'tool_use' || typeof block['id'] !== 'string') continue;
      capped(this.callerOf, block['id'], parentToolUseId, OWNER_LINKS_MAX);
      if (isPlanTool(str(block['name'])) && this.notePlan(parentToolUseId, block['input'])) planned = true;
    }
    return planned;
  }

  /** A sub-agent rewrote its checklist: the card shows «done/total · now».
   *  Its own messages never reach a client, so this is the only way out. */
  private notePlan(parentToolUseId: string, input: unknown): boolean {
    const id = this.byToolUse.get(parentToolUseId);
    const a = id ? this.agents.get(id) : undefined;
    const items = planItems(input);
    if (!a || !items) return false;
    const next = planProgress(items);
    const prev = a.plan;
    if (prev && prev.done === next.done && prev.total === next.total && prev.active === next.active) return false;
    a.plan = next;
    a.activeAt = this.now();
    return true;
  }

  /** The sub-agent that started this background task, if one did. */
  taskOwner(taskId: string): BackgroundTaskOwner | undefined {
    return this.ownerOfTask.get(taskId);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  isRunning(id: string): boolean {
    return this.agents.get(id)?.status === 'running';
  }

  /** Mark one stopped from our side (the CLI's own notice may follow). */
  stopped(id: string): boolean {
    const a = this.agents.get(id);
    if (!a || a.status !== 'running') return false;
    this.end(a, 'stopped');
    return true;
  }

  snapshot(): Subagent[] {
    const all = [...this.agents.values()];
    const running = all.filter((a) => a.status === 'running');
    const ended = all
      .filter((a) => a.status !== 'running')
      .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0));
    const kept = [...running, ...ended].slice(0, SUBAGENTS_MAX);
    // Forget the FINISHED ones that fell off: the map must not grow for the
    // life of a run. A running one past the wire cap is still tracked — its
    // end must land and Stop must still find it.
    if (kept.length < all.length) {
      const keep = new Set(kept.map((a) => a.id));
      for (const a of ended) {
        if (keep.has(a.id)) continue;
        this.agents.delete(a.id);
        if (a.toolUseId) this.byToolUse.delete(a.toolUseId);
      }
    }
    return kept.map((a) => ({ ...a }));
  }

  private noteTaskOwner(taskId: string, toolUseId: string | undefined): void {
    const caller = toolUseId ? this.callerOf.get(toolUseId) : undefined;
    const ownerId = caller ? this.byToolUse.get(caller) : undefined;
    const owner = ownerId ? this.agents.get(ownerId) : undefined;
    const name = owner && (owner.description || owner.kind);
    if (ownerId && name) capped(this.ownerOfTask, taskId, { id: ownerId, name: clip(name, 200) }, OWNER_LINKS_MAX);
  }

  private end(a: Subagent, status: SubagentStatus, at?: number): void {
    a.status = status;
    a.endedAt = at ?? this.now();
    closeSubagentActions(a);
  }

  private usage(a: Subagent, raw: unknown): void {
    const u = raw as { total_tokens?: unknown; tool_uses?: unknown } | undefined;
    if (typeof u?.total_tokens === 'number') a.tokens = Math.max(0, Math.round(u.total_tokens));
    if (typeof u?.tool_uses === 'number') a.toolUses = Math.max(0, Math.round(u.tool_uses));
  }
}

/** Enough for any live set (the wire shows 32 tasks); a chatty sub-agent's
 *  calls must not grow the maps for the life of a run. Oldest out first. */
const OWNER_LINKS_MAX = 512;

function capped<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value!);
}

/** A sub-agent, not a background Bash or a workflow (those are the panel's
 *  `background_tasks`, not cards). Older CLIs send no `task_type`; a
 *  `subagent_type` is then the tell. */
function isAgentTask(m: Record<string, unknown>): boolean {
  const type = str(m['task_type']);
  if (type) return type === 'local_agent';
  return !!str(m['subagent_type']);
}

function statusOf(s: string | undefined): SubagentStatus | undefined {
  switch (s) {
    case 'running':
    case 'pending':
    case 'paused':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
    case 'stopped':
      return 'stopped';
    default:
      return undefined;
  }
}

/**
 * «what it is doing now»: the CLI's own words when it summarised (opt-in
 * `agentProgressSummaries`), else the tool and what it said it would do —
 * `description` arrives as «Running <the Bash description>».
 */
function actionOf(m: Record<string, unknown>): string | undefined {
  const summary = str(m['summary']);
  if (summary) return clip(summary.replace(/\s+/g, ' ').trim(), 160);
  const tool = str(m['last_tool_name']);
  const desc = str(m['description'])?.replace(/^Running\s+/i, '').trim();
  const words = [tool, desc && desc !== tool ? desc : undefined].filter(Boolean).join(' · ');
  return words ? clip(words.replace(/\s+/g, ' '), 160) : undefined;
}
