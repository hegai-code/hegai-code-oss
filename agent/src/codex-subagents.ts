import { createInterface } from 'node:readline';
import { SUBAGENTS_MAX, closeSubagentActions, noteSubagentAction, type HistoryMessage, type Subagent, type SubagentStatus } from '@cc-remote/shared';
import { CODEX_TRANSCRIPT_MAX_BYTES, findCodexTranscript, parseCodexLines } from './codex.js';
import { openRollout } from './confine.js';
import { trimToolPayloads } from './history.js';
import { asRecord as record, clip, optionalString as str } from './json-util.js';

/**
 * Codex sub-agents (`spawn_agent`) as every client draws them: one card per
 * child thread, folded from two streams the app-server writes on the parent's
 * pipe.
 *
 *  - The PARENT's items: `subAgentActivity` (started / interacted /
 *    interrupted / completed — all a v2 model such as gpt-5.6-sol emits) and
 *    `collabAgentToolCall` (v1 tools: `spawnAgent` with its prompt, `wait` /
 *    `closeAgent` with `agentsStates`).
 *  - The CHILD's own notifications, under the child's `threadId`:
 *    `thread/started` (nickname, role, model), `turn/started` /
 *    `turn/completed`, its items (what it is doing now) and token usage.
 *
 * `CodexSessionRun` keeps child notifications away from its own turn (the
 * 30.09.2026 bug: a child's `turn/completed` ended the parent's turn) and
 * hands them here instead. Nothing here can touch the parent's turn.
 *
 * The output is a LEVEL (`status` / `subagents`): the run's whole set after
 * every change, running first, then the most recent finished, at most
 * SUBAGENTS_MAX. A status change goes out at once; progress (current action,
 * tool count, tokens) at most every `tickMs`.
 */

export const CODEX_SUBAGENT_TICK_MS = 1500;
/** Item ids remembered per agent to count each tool call once. */
const SEEN_ITEMS_CAP = 512;

type Change = 'status' | 'progress' | null;

interface Tracked {
  agent: Subagent;
  /** The child's live turn — what `turn/interrupt` needs. */
  turnId?: string;
  /** Last thing it said; its report when the turn ends without one. */
  lastMessage?: string;
  seenItems: Set<string>;
}

export interface CodexSubagentOptions {
  now?: () => number;
  tickMs?: number;
  /** A child first seen in the parent's items. codex-cli 0.162 sends no
   *  `thread/started` for children, so its name (nickname / role) has to be
   *  asked for (`thread/read`), and the answer fed back as `thread/started`. */
  onNewChild?: (id: string) => void;
}

export class CodexSubagents {
  private readonly agents = new Map<string, Tracked>();
  private readonly now: () => number;
  private readonly tickMs: number;
  private timer?: NodeJS.Timeout;
  private lastFlush = 0;
  private lastSent = '';
  private closed = false;
  private readonly onNewChild?: (id: string) => void;

  constructor(
    /** The parent thread id (empty until a fresh thread has one). */
    private readonly parentId: () => string,
    private readonly emit: (agents: Subagent[]) => void,
    opts: CodexSubagentOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? CODEX_SUBAGENT_TICK_MS;
    this.onNewChild = opts.onNewChild;
  }

  /** One of the PARENT's items (`item/started` or `item/completed`). Returns
   *  true when it was a sub-agent item, whatever it changed. */
  parentItem(item: Record<string, unknown>): boolean {
    const type = item['type'];
    if (type !== 'subAgentActivity' && type !== 'collabAgentToolCall') return false;
    const known = new Set(this.agents.keys());
    this.publish(type === 'subAgentActivity' ? this.activity(item) : this.collab(item));
    if (this.onNewChild && !this.closed) {
      for (const id of this.agents.keys()) if (!known.has(id)) this.onNewChild(id);
    }
    return true;
  }

  /**
   * A notification under another thread's id. Only this run's children are
   * folded: a child is known from the parent's items, or announces itself in
   * `thread/started` with this thread as its parent. A grandchild, or any
   * other thread, is ignored.
   */
  childNotification(threadId: string, method: string, params: Record<string, unknown>): void {
    if (method === 'thread/started') {
      this.publish(this.threadStarted(record(params['thread'])));
      return;
    }
    const t = this.agents.get(threadId);
    if (!t) return;
    this.publish(this.childEvent(t, method, params));
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  isRunning(id: string): boolean {
    return this.agents.get(id)?.agent.status === 'running';
  }

  /** The child's live turn id, when one has been seen. */
  activeTurn(id: string): string | undefined {
    return this.agents.get(id)?.turnId;
  }

  /** Stopped from our side; the child's own `turn/completed` may follow. */
  stopped(id: string): void {
    const t = this.agents.get(id);
    if (!t || t.agent.status !== 'running') return;
    this.end(t, 'stopped');
    this.publish('status');
  }

  snapshot(): Subagent[] {
    const all = [...this.agents.values()];
    const running = all
      .filter((t) => t.agent.status === 'running')
      .sort((x, y) => x.agent.startedAt - y.agent.startedAt);
    const ended = all
      .filter((t) => t.agent.status !== 'running')
      .sort((x, y) => (y.agent.endedAt ?? 0) - (x.agent.endedAt ?? 0));
    const kept = [...running, ...ended].slice(0, SUBAGENTS_MAX);
    // Forget the finished ones that fell off: the map must not grow for the
    // life of a run. A running one stays, wire or not — its end must land.
    if (kept.length < all.length) {
      const keep = new Set(kept.map((t) => t.agent.id));
      for (const t of ended) if (!keep.has(t.agent.id)) this.agents.delete(t.agent.id);
    }
    return kept.map((t) => ({ ...t.agent }));
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ── folding ────────────────────────────────────────────────────────────

  private activity(item: Record<string, unknown>): Change {
    const id = str(item['agentThreadId']);
    if (!id) return null;
    const kind = item['kind'];
    const existed = this.agents.has(id);
    // Only `started` may introduce an agent: an `interrupted` / `completed`
    // for one this run never saw start (a resumed session's old child) would
    // be a card for work nobody watched here.
    if (!existed && kind !== 'started') return null;
    const t = this.ensure(id);
    let change: Change = existed ? null : 'status';
    const path = str(item['agentPath']);
    if (path && !t.agent.description) {
      t.agent.description = clip(pathTail(path), 200);
      change ??= 'progress';
    }
    const model = str(item['model']);
    if (model && !t.agent.model) t.agent.model = clip(model, 80);
    if (kind === 'interrupted' && t.agent.status === 'running') {
      this.end(t, 'stopped');
      return 'status';
    }
    if (kind === 'completed' && t.agent.status === 'running') {
      this.end(t, 'completed');
      return 'status';
    }
    return change;
  }

  private collab(item: Record<string, unknown>): Change {
    const tool = item['tool'];
    const receivers = Array.isArray(item['receiverThreadIds'])
      ? (item['receiverThreadIds'] as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [];
    let change: Change = null;
    if (tool === 'spawnAgent') {
      const prompt = str(item['prompt']);
      const model = str(item['model']);
      const callId = str(item['id']);
      for (const id of receivers) {
        const existed = this.agents.has(id);
        const t = this.ensure(id);
        if (!existed) change = 'status';
        // The spawn prompt is the task in the model's own words — better than
        // the path a `subAgentActivity` may have filled in first.
        if (prompt) t.agent.description = clip(oneLine(prompt), 200);
        if (model && !t.agent.model) t.agent.model = clip(model, 80);
        // One call, one child: only then is the call the card's anchor.
        if (callId && receivers.length === 1) t.agent.toolUseId = clip(callId, 200);
        change ??= 'progress';
      }
    }
    const states = record(item['agentsStates']);
    if (states) {
      for (const [id, raw] of Object.entries(states)) {
        const t = this.agents.get(id);
        const state = record(raw);
        if (!t || !state) continue;
        const status = collabStatus(str(state['status']), t.agent.status, tool === 'closeAgent');
        const message = str(state['message']);
        if (status && status !== 'running' && t.agent.status === 'running') {
          this.end(t, status, message);
          change = 'status';
        } else if (status && status !== 'running' && message && !t.agent.summary) {
          t.agent.summary = clip(message.trim(), 2000);
          change = 'status';
        }
      }
    }
    return change;
  }

  private threadStarted(thread: Record<string, unknown> | undefined): Change {
    const id = str(thread?.['id']);
    if (!thread || !id) return null;
    const parent = this.parentId();
    const spawn = record(record(record(thread['source'])?.['subagent'])?.['thread_spawn']);
    const parentOf = str(thread['parentThreadId']) ?? str(spawn?.['parent_thread_id']);
    if (!parent || parentOf !== parent) return null;
    const existed = this.agents.has(id);
    const t = this.ensure(id);
    const created = typeof thread['createdAt'] === 'number' ? (thread['createdAt'] as number) * 1000 : undefined;
    if (!existed && created && created <= this.now()) t.agent.startedAt = created;
    const name =
      str(thread['agentRole']) ??
      str(spawn?.['agent_role']) ??
      str(thread['agentNickname']) ??
      str(spawn?.['agent_nickname']);
    if (name) t.agent.kind = clip(name, 80);
    const path = str(spawn?.['agent_path']);
    if (path && !t.agent.description) t.agent.description = clip(pathTail(path), 200);
    const model = str(thread['model']);
    if (model && !t.agent.model) t.agent.model = clip(model, 80);
    // Its name is part of the card, not a progress tick; once per child.
    return 'status';
  }

  private childEvent(t: Tracked, method: string, params: Record<string, unknown>): Change {
    switch (method) {
      case 'turn/started': {
        const turnId = str(record(params['turn'])?.['id']);
        if (turnId) t.turnId = turnId;
        if (t.agent.status === 'running') return null;
        // Woken by a follow-up (`send_input`, a v2 message): working again.
        t.agent.status = 'running';
        delete t.agent.endedAt;
        delete t.agent.summary;
        t.lastMessage = undefined;
        return 'status';
      }
      case 'turn/completed': {
        const turn = record(params['turn']) ?? {};
        const turnId = str(turn['id']);
        if (turnId && t.turnId && turnId !== t.turnId) return null;
        t.turnId = undefined;
        if (t.agent.status !== 'running') return null;
        const s = turn['status'];
        const status: SubagentStatus = s === 'interrupted' ? 'stopped' : s === 'failed' ? 'failed' : 'completed';
        const error = str(record(turn['error'])?.['message']);
        this.end(t, status, status === 'failed' ? error : undefined);
        return 'status';
      }
      case 'thread/status/changed': {
        const type = record(params['status'])?.['type'];
        if (type === 'systemError' && t.agent.status === 'running') {
          this.end(t, 'failed');
          return 'status';
        }
        return null;
      }
      case 'thread/closed':
        if (t.agent.status !== 'running') return null;
        this.end(t, 'stopped');
        return 'status';
      case 'thread/tokenUsage/updated': {
        const total = record(record(params['tokenUsage'])?.['total'])?.['totalTokens'];
        if (typeof total !== 'number' || !Number.isFinite(total)) return null;
        const tokens = Math.max(0, Math.round(total));
        if (tokens === t.agent.tokens) return null;
        t.agent.tokens = tokens;
        return 'progress';
      }
      case 'item/started':
      case 'item/completed':
        return this.childItem(t, record(params['item']), method === 'item/completed');
      default:
        return null;
    }
  }

  private childItem(t: Tracked, item: Record<string, unknown> | undefined, completed: boolean): Change {
    if (!item) return null;
    if (item['type'] === 'agentMessage') {
      const text = str(item['text']);
      if (completed && text) t.lastMessage = text;
      return null;
    }
    const action = actionOf(item);
    if (!action) return null;
    const id = str(item['id']);
    let change: Change = null;
    if (id && !t.seenItems.has(id)) {
      if (t.seenItems.size >= SEEN_ITEMS_CAP) t.seenItems.clear();
      t.seenItems.add(id);
      t.agent.toolUses = (t.agent.toolUses ?? 0) + 1;
      change = 'progress';
    }
    if (t.agent.status === 'running' && noteSubagentAction(t.agent, action, this.now())) change = 'progress';
    return change;
  }

  private ensure(id: string): Tracked {
    let t = this.agents.get(id);
    if (!t) {
      t = {
        agent: { id: clip(id, 200), kind: 'agent', description: '', status: 'running', startedAt: this.now() },
        seenItems: new Set(),
      };
      this.agents.set(id, t);
    }
    return t;
  }

  private end(t: Tracked, status: SubagentStatus, report?: string): void {
    t.agent.status = status;
    t.agent.endedAt = this.now();
    closeSubagentActions(t.agent);
    const summary = report?.trim() || (status === 'completed' ? t.lastMessage?.trim() : undefined);
    if (summary && !t.agent.summary) t.agent.summary = clip(summary, 2000);
  }

  // ── publishing ─────────────────────────────────────────────────────────

  private publish(change: Change): void {
    if (!change || this.closed) return;
    if (change === 'status') {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.flush();
      return;
    }
    if (this.timer) return;
    const wait = this.lastFlush + this.tickMs - this.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closed) this.flush();
    }, wait);
    this.timer.unref?.();
  }

  private flush(): void {
    this.lastFlush = this.now();
    const agents = this.snapshot();
    const wire = JSON.stringify(agents);
    if (wire === this.lastSent) return;
    this.lastSent = wire;
    this.emit(agents);
  }
}

/** `turn/interrupt` refused because the turn moved on: Codex names the live
 *  one («expected active turn id A but found B»), as the TUI relies on. */
export function interruptRaceTurnId(message: string): string | undefined {
  const m = /expected active turn id \S* ?but found (\S+)/.exec(message);
  return m?.[1];
}

// ── history ──────────────────────────────────────────────────────────────

/**
 * Where the child's OWN history starts in its rollout, as a line index, or
 * -1 when it has none yet.
 *
 * A spawned child's rollout is a fork: after its own `session_meta` comes a
 * copy of the parent's (a second `session_meta`, the parent's turns, its
 * compaction markers), and only then the child's first turn. Turn ids are
 * UUIDv7 — their first 48 bits are the minting time in ms — so the first
 * `task_started` / `turn_context` whose turn id is no older than the child
 * thread id itself is the child's. Verified on real rollouts 10.10.2026 for
 * both shapes (codex-cli 0.14x with a copied `session_meta`, and the older
 * one without it). Ids that are not UUIDv7 fall back to the turn's
 * `started_at` against the child's `session_meta.timestamp`.
 */
export function codexForkBoundary(lines: readonly string[], childId: string): number {
  const childMs = uuidV7Ms(childId);
  let metaMs: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes('task_started') && !line.includes('turn_context') && !line.includes('session_meta')) continue;
    let rec: { type?: unknown; payload?: unknown };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    const payload = record(rec.payload);
    if (!payload) continue;
    if (rec.type === 'session_meta') {
      if (metaMs === undefined && payload['id'] === childId) {
        const ts = Date.parse(String(payload['timestamp'] ?? ''));
        if (Number.isFinite(ts)) metaMs = ts;
      }
      continue;
    }
    const isTurnStart =
      (rec.type === 'event_msg' && payload['type'] === 'task_started') || rec.type === 'turn_context';
    if (!isTurnStart) continue;
    // codex-cli 0.162 nests it: `task_started.turn_attribution.turn_id`.
    const turnId = str(payload['turn_id']) ?? str(record(payload['turn_attribution'])?.['turn_id']);
    const turnMs = turnId ? uuidV7Ms(turnId) : undefined;
    if (childMs !== undefined && turnMs !== undefined) {
      if (turnMs >= childMs) return i;
      continue;
    }
    const started = payload['started_at'];
    if (metaMs !== undefined && typeof started === 'number' && started * 1000 >= Math.floor(metaMs / 1000) * 1000) {
      return i;
    }
  }
  return -1;
}


/**
 * A Codex sub-agent's own transcript (`session.subagent` for a Codex session):
 * the child thread's rollout, without the copy of the parent's history it was
 * forked from (see `codexForkBoundary`). Same parser as every other Codex
 * history (`parseCodexLines`).
 *
 * Only a spawned thread's rollout is read here — and, when `parentThreadId` is
 * given, only one spawned by that thread.
 */
export async function loadCodexSubagentHistory(
  childThreadId: string,
  limit: number,
  toolChars?: number,
  parentThreadId?: string,
  knownCwd?: string,
): Promise<HistoryMessage[]> {
  const filePath = await findCodexTranscript(childThreadId, knownCwd);
  if (!filePath) return [];
  // One verified open; size and every byte come from this descriptor (a path
  // swapped for /dev/zero or a symlink after the lookup cannot be re-read).
  const handle = await openRollout(filePath);
  const st = await handle.stat();
  if (!st.isFile()) {
    await handle.close();
    return [];
  }
  // The shared cap, not a smaller one: the file starts with a copy of the
  // parent's history, so its size says little about the child's own part.
  if (st.size > CODEX_TRANSCRIPT_MAX_BYTES) {
    await handle.close();
    throw new Error(
      `Транскрипт помощника — ${Math.round(st.size / 1e6)} МБ, больше ${Math.round(CODEX_TRANSCRIPT_MAX_BYTES / 1e6)} МБ, которые читаются за раз`,
    );
  }
  const lines: string[] = [];
  const input = handle.createReadStream({ encoding: 'utf8', start: 0, end: Math.max(0, st.size - 1) });
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) lines.push(line);
  } finally {
    input.destroy();
  }
  const meta = firstMeta(lines);
  if (!meta || meta['id'] !== childThreadId) return [];
  const spawn = record(record(record(meta['source'])?.['subagent'])?.['thread_spawn']);
  if (!spawn && meta['thread_source'] !== 'subagent') return [];
  if (parentThreadId && str(spawn?.['parent_thread_id']) !== parentThreadId) return [];
  const start = codexForkBoundary(lines, childThreadId);
  if (start < 0) return [];
  const messages = parseCodexLines(lines.slice(start).join('\n'));
  const window = messages.slice(-Math.max(0, limit));
  return toolChars === undefined ? window : trimToolPayloads(window, toolChars);
}

function firstMeta(lines: readonly string[]): Record<string, unknown> | undefined {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { type?: unknown; payload?: unknown };
      return rec.type === 'session_meta' ? record(rec.payload) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ── helpers ──────────────────────────────────────────────────────────────

/** ms epoch of a UUIDv7, or undefined for any other id. */
export function uuidV7Ms(id: string): number | undefined {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(id);
  return m ? parseInt(m[1]! + m[2]!, 16) : undefined;
}

function collabStatus(
  status: string | undefined,
  current: SubagentStatus,
  closing: boolean,
): SubagentStatus | undefined {
  switch (status) {
    case 'pendingInit':
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'stopped';
    case 'errored':
      return 'failed';
    case 'shutdown':
      // Closed while still working is a stop; closed after it finished is
      // just tidying up.
      return current === 'running' ? (closing ? 'stopped' : 'completed') : current;
    default:
      return undefined;
  }
}

/** «What it is doing now» for one of the child's items. */
function actionOf(item: Record<string, unknown>): string | undefined {
  switch (item['type']) {
    case 'commandExecution': {
      const cmd = str(item['command'])?.replace(/^\S*\/(?:zsh|bash|sh)\s+-l?c\s+/, '');
      return cmd ? clip(`Bash · ${oneLine(cmd)}`, 160) : 'Bash';
    }
    case 'fileChange': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
      const paths = changes.map((c) => str(record(c)?.['path'])).filter(Boolean).map((p) => pathTail(p!));
      return clip(paths.length ? `Edit · ${paths.join(', ')}` : 'Edit', 160);
    }
    case 'mcpToolCall': {
      const server = str(item['server']);
      const tool = str(item['tool']);
      return clip(`MCP · ${[server, tool].filter(Boolean).join('/') || 'tool'}`, 160);
    }
    case 'dynamicToolCall':
      return clip(`Tool · ${str(item['tool']) ?? 'tool'}`, 160);
    case 'webSearch': {
      const q = str(item['query']);
      return clip(q ? `Search · ${oneLine(q)}` : 'Search', 160);
    }
    case 'collabAgentToolCall':
      return clip(`Agent · ${str(item['tool']) ?? 'agent'}`, 160);
    case 'imageView':
      return 'View image';
    default:
      return undefined;
  }
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const pathTail = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
