import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseTaskNotification, type HistoryMessage, type RenderBlock, type Subagent, type SubagentStatus } from '@cc-remote/shared';
import type { TranscriptLine } from '../central-reducers.js';
import { pluralRu } from '../lib.js';
import { PlanLine } from '../components/PlanStrip.js';
import { CaretDown, Check, SquareIcon, X } from '../icons.js';
import { prettyModel } from '../components/run-settings.js';
import { humanAction, humanStep, humanToolLine, type Step } from '../stepText.js';
import { SideSheet } from '../components/SideSheet.js';
import { askConfirm } from '../dialogs.js';

/**
 * Sub-agents in the transcript (10.10.2026). The pattern every native client
 * converged on: ONE card per sub-agent in the parent's transcript (who, what,
 * doing what now, how long, how much, how it ended), a panel of the live ones
 * over the composer with Stop, and the agent's own transcript one click away —
 * never its messages inside the parent's, which read as the session talking.
 *
 * The live facts come from the agent's `subagents` level (`Subagent`); a
 * reloaded transcript has none, so the card falls back on what the parent's
 * own transcript says: the `Agent` call's result and the CLI's
 * `<task-notification>` (`agentNotices`).
 */

/** One `Agent`/`Task` call in the parent's transcript — what a card is drawn for. */
export interface SubagentCall {
  toolUseId?: string;
  kind: string;
  description: string;
}

/** What the parent's transcript itself says about how a call ended. */
export interface AgentNotice {
  status?: SubagentStatus;
  summary?: string;
  /** The result was «launched in the background», not a report. */
  async?: boolean;
}

export interface OpenTarget {
  toolUseId?: string;
  id?: string;
  title: string;
}

export interface SubagentsApi {
  /** Live agents by the parent's call id. */
  live: Map<string, Subagent>;
  notices: Map<string, AgentNotice>;
  open: (target: OpenTarget) => void;
  /** Absent for a viewer who may not drive the run. */
  stop?: (id: string) => void;
  /** Whether the run is still here to finish what the transcript started. */
  runAlive: boolean;
  /** A card says whether it is on screen (`undefined` = gone): the panel
   *  leaves out a helper whose card the reader is already looking at. */
  onCardView?: (toolUseId: string, visible: boolean | undefined) => void;
}

export const SubagentsContext = createContext<SubagentsApi | null>(null);

const AGENT_TOOLS = new Set(['Agent', 'Task']);

function callOf(name: string, input: unknown, id?: string): SubagentCall | null {
  if (!AGENT_TOOLS.has(name)) return null;
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  return { toolUseId: id, kind: s('subagent_type') || 'агент', description: s('description') || s('prompt').slice(0, 120) };
}

export function agentCallsFromBlocks(blocks: RenderBlock[] | undefined): SubagentCall[] {
  if (!blocks) return [];
  return blocks.flatMap((b) => {
    if (b.kind !== 'tool_use') return [];
    const c = callOf(b.name, b.input, b.id);
    return c ? [c] : [];
  });
}

/** A live `tool_use` line is "Name {json}", its id in `data.id` (the agent adds it). */
export function agentCallsFromLines(lines: TranscriptLine[] | undefined): SubagentCall[] {
  if (!lines) return [];
  return lines.flatMap((l) => {
    if (l.kind !== 'tool_use') return [];
    const space = l.text.indexOf(' ');
    const name = space < 0 ? l.text : l.text.slice(0, space);
    if (!AGENT_TOOLS.has(name)) return [];
    let input: unknown = {};
    try {
      input = JSON.parse(l.text.slice(space + 1));
    } catch {
      /* a clipped line still names the call */
    }
    const id = typeof l.data?.['id'] === 'string' ? (l.data['id'] as string) : undefined;
    const c = callOf(name, input, id);
    return c ? [c] : [];
  });
}

/** The parent transcript's own record of how each `Agent` call ended. */
export function agentNotices(history: HistoryMessage[]): Map<string, AgentNotice> {
  const calls = new Set<string>();
  const out = new Map<string, AgentNotice>();
  for (const m of history) {
    for (const b of m.blocks) {
      if (b.kind === 'tool_use' && AGENT_TOOLS.has(b.name)) calls.add(b.id);
      else if (b.kind === 'tool_result' && calls.has(b.toolUseId)) {
        const launched = /^async agent launched/i.test(b.text.trim());
        const prev = out.get(b.toolUseId);
        if (launched) out.set(b.toolUseId, { ...prev, async: true });
        else out.set(b.toolUseId, { ...prev, status: b.isError ? 'failed' : 'completed', summary: b.text.trim().slice(0, 2000) });
      } else if (b.kind === 'text' && b.text.includes('<task-notification>')) {
        const n = parseTaskNotification(b.text);
        if (n?.toolUseId) out.set(n.toolUseId, { ...out.get(n.toolUseId), status: n.status ?? 'completed', summary: n.summary });
      }
    }
  }
  return out;
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const fmtClock = (ms: number): string => {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}с` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
};

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** A stopped helper cannot be resumed, and a stray tap on a 44pt link killed
 *  one on 23.10.2026 with nobody owning up to it — every stop asks first. */
function confirmStop(text: string): Promise<boolean> {
  return typeof window === 'undefined' ? Promise.resolve(true) : askConfirm(text, { confirmLabel: 'Остановить', danger: true });
}

const STATUS_WORD: Record<SubagentStatus, string> = {
  running: 'работает',
  completed: 'готово',
  failed: 'ошибка',
  stopped: 'остановлен',
};

function StatusMark({ status }: { status: SubagentStatus | undefined }) {
  if (status === 'completed') return <Check size={12} className="sa-mark done" aria-label="готово" />;
  if (status === 'failed') return <X size={12} className="sa-mark failed" aria-label="ошибка" />;
  if (status === 'stopped') return <SquareIcon size={10} className="sa-mark stopped" aria-label="остановлен" />;
  if (status === 'running') return <span className="sa-mark running" aria-label="работает" />;
  return <span className="sa-mark idle" aria-hidden />;
}

/** A running agent that has not moved for this long says so: «тихо 1:05». */
const QUIET_MS = 30_000;

function quietFor(agent: Subagent | undefined, now: number): number | undefined {
  if (agent?.status !== 'running' || !agent.activeAt) return undefined;
  const quiet = now - agent.activeAt;
  return quiet >= QUIET_MS ? quiet : undefined;
}

/** Counters in one muted run: «12 вызовов · 41k токенов · 1:23». */
function Meta({ agent, now }: { agent?: Subagent; now: number }) {
  if (!agent) return null;
  const parts: string[] = [];
  if (agent.toolUses !== undefined) parts.push(`${agent.toolUses} ${pluralRu(agent.toolUses, ['вызов', 'вызова', 'вызовов'])}`);
  if (agent.tokens) parts.push(`${fmtTokens(agent.tokens)} токенов`);
  const end = agent.status === 'running' ? now : (agent.endedAt ?? now);
  parts.push(fmtClock(end - agent.startedAt));
  const quiet = quietFor(agent, now);
  return (
    <span className="sa-meta">
      {parts.join(' · ')}
      {quiet !== undefined && <span className="sa-quiet"> · тихо {fmtClock(quiet)}</span>}
    </span>
  );
}

/** «Opus 5.5», «Sonnet», «gpt-5.6-sol» — the model a helper runs on. */
function modelName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const pretty = prettyModel(model);
  return /^[a-z]+$/.test(pretty) ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : pretty;
}

/** One step as a line of the card's trail: the sentence, the raw command or
 *  path behind it one hover away. The running one carries the pulse. */
function StepLine({ step, now }: { step: Step; now?: boolean }) {
  return (
    <li className={now ? 'sa-now' : 'sa-past'} title={step.detail} aria-current={now ? 'step' : undefined}>
      <span className="sa-step">{step.text}</span>
    </li>
  );
}

/** A trail of steps, oldest first; `live` marks the last one as running.
 *  `first` is the turn-wide number of `steps[0]` when the trail is a window
 *  onto a longer list: each row is keyed by its step, so a new step appends a
 *  row and drops the oldest instead of rewriting every row's text in place —
 *  WebKit (the Mac app) left the old glyphs under the new ones, three lines
 *  drawn over three (31.10.2026). */
function Trail({ steps, live, all, first }: { steps: Step[]; live: boolean; all?: boolean; first?: number }) {
  if (!steps.length) return null;
  // A rolling window with no turn-wide numbering (a helper's `recent`) is
  // keyed by content: the same step keeps its row as the window slides.
  const seen = new Map<string, number>();
  const keyOf = (st: Step, i: number): string => {
    if (all || first !== undefined) return String((first ?? 0) + i);
    const base = `${st.text}\u0000${st.detail ?? ''}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  };
  return (
    <ol className={`sa-stream${all ? ' all' : ''}`} aria-live={live && !all ? 'polite' : undefined}>
      {steps.map((st, i) => (
        <StepLine key={keyOf(st, i)} step={st} now={live && i === steps.length - 1} />
      ))}
    </ol>
  );
}

/**
 * What it did, step by step — the trail behind «сейчас», kept after the end.
 * Collapsed by default; the reader opens it when the one line is not enough.
 */
function Steps({ agent }: { agent: Subagent }) {
  const steps = [...(agent.steps ?? []), ...(agent.lastAction ? [agent.lastAction] : [])].map(humanAction);
  return <Trail steps={steps} live={agent.status === 'running' && !!agent.lastAction} all />;
}

/** «Explore · Opus 5.5» — who works, on what model, as one quiet line. */
function WhoLine({ kind, model }: { kind?: string; model?: string }) {
  const parts = [kind, model].filter(Boolean);
  return parts.length ? <div className="sa-who">{parts.join(' · ')}</div> : null;
}

function SubagentCard({ call, api }: { call: SubagentCall; api: SubagentsApi }) {
  const live = call.toolUseId ? api.live.get(call.toolUseId) : undefined;
  const notice = call.toolUseId ? api.notices.get(call.toolUseId) : undefined;
  // A background call the run no longer carries and no notice closed: it ran
  // out with the run. Nothing to claim either way.
  const status: SubagentStatus | undefined = live?.status ?? notice?.status ?? (notice?.async && api.runAlive ? 'running' : undefined);
  const summary = live?.summary ?? notice?.summary;
  const [open, setOpen] = useState(false);
  const now = useNow(status === 'running');
  const title = `${live?.kind ?? call.kind} · ${live?.description || call.description}`;
  const model = modelName(live?.model);
  const hasSteps = !!(live?.steps?.length || (live?.lastAction && live.recent?.length));
  const ref = useRef<HTMLDivElement>(null);
  const report = api.onCardView;
  useEffect(() => {
    const el = ref.current;
    const id = call.toolUseId;
    if (!el || !id || !report || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) report(id, e.isIntersecting);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      report(id, undefined);
    };
  }, [call.toolUseId, report]);
  return (
    <div ref={ref} className={`sa-card ${status ?? 'unknown'}`}>
      <div className="sa-head">
        <StatusMark status={status} />
        <span className="sa-desc">{live?.description || call.description}</span>
        <Meta agent={live} now={now} />
      </div>
      <WhoLine kind={live?.kind ?? call.kind} model={model} />
      {open && live ? (
        <Steps agent={live} />
      ) : (
        status === 'running' &&
        live &&
        (live.recent?.length || live.lastAction) && (
          // The last few steps, oldest faint — it is visibly moving, or visibly not.
          <Trail
            steps={[...(live.recent?.slice(-2) ?? []), ...(live.lastAction ? [live.lastAction] : [])].map(humanAction)}
            live={!!live.lastAction}
          />
        )
      )}
      {status === 'running' && live?.plan && <PlanLine plan={live.plan} />}
      {summary && status !== 'running' && <div className={`sa-summary${open ? ' open' : ''}`}>{summary}</div>}
      <div className="sa-actions">
        {(hasSteps || (summary && status !== 'running')) && (
          <button type="button" className="sa-link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Свернуть' : status === 'running' ? 'Ход работы' : 'Подробнее'}
          </button>
        )}
        {call.toolUseId && (
          <button type="button" className="sa-link" onClick={() => api.open({ toolUseId: call.toolUseId, id: live?.id, title })}>
            Транскрипт
          </button>
        )}
        {status === 'running' && live && api.stop && (
          <button type="button" className="sa-link danger" onClick={async () => { if (await confirmStop(`Остановить «${live.description || call.description}»? Продолжить его потом не получится.`)) api.stop!(live.id); }}>
            Остановить
          </button>
        )}
        {status && status !== 'running' && <span className="sa-word">{STATUS_WORD[status]}</span>}
      </div>
    </div>
  );
}

/** Cards for the `Agent` calls in one folded run of machinery. */
export function SubagentCards({ calls }: { calls: SubagentCall[] }) {
  const api = useContext(SubagentsContext);
  if (!api || !calls.length) return null;
  return (
    <div className="sa-cards">
      {calls.map((c, i) => (
        <SubagentCard key={c.toolUseId ?? i} call={c} api={api} />
      ))}
    </div>
  );
}

/** One tool call as a card step, in words (`stepText.ts`). */
export const stepOf = (name: string, input: unknown): Step => humanStep(name, input);

/** The same for a live `tool_use` line: Claude's «Name {json}»; Codex's
 *  «$ cmd», «edit paths», «web_search: q», «mcp: tool». */
export const toolStep = (text: string): Step => humanToolLine(text);

/**
 * The session's own turn, drawn like a sub-agent's card (14.10.2026, by
 * request): the model, what it is doing in two words, how many calls and how
 * long — and the last steps under it with «сейчас», so the main run reads the
 * same as its helpers instead of one grey word under the transcript. No Stop
 * here: the composer's own stop is right below.
 */
export function SessionWorkCard({
  model,
  activity,
  steps,
  current,
  startedAt,
}: {
  /** The model's display name, as the composer's model button shows it. */
  model?: string;
  activity: string;
  /** This turn's tool steps, oldest first. */
  steps: Step[];
  /** The last step is still running (not between steps). */
  current: boolean;
  startedAt?: number;
}) {
  const [mountedAt] = useState(() => Date.now());
  const now = useNow(true);
  const since = startedAt !== undefined && startedAt > 0 && Number.isFinite(startedAt) ? Math.min(startedAt, now) : mountedAt;
  const meta = [steps.length ? `${steps.length} ${pluralRu(steps.length, ['шаг', 'шага', 'шагов'])}` : '', fmtClock(now - since)].filter(Boolean).join(' · ');
  return (
    <div className="sa-card running sa-self" role="status">
      <div className="sa-head">
        <StatusMark status="running" />
        <span className="sa-desc">{activity}</span>
        <span className="sa-meta">{meta}</span>
      </div>
      <WhoLine model={model} />
      <Trail steps={steps.slice(-3)} first={Math.max(0, steps.length - 3)} live={current} />
    </div>
  );
}

/**
 * What a finished turn did (19.10.2026, by request): the working card does not
 * just vanish when the turn ends — a one-line «Сделано · 14 шагов · 5:28»
 * stays at the end of the turn and opens into every step, in words.
 */
export function TurnRecap({ steps, ms }: { steps: Step[]; ms?: number }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  const meta = [`${steps.length} ${pluralRu(steps.length, ['шаг', 'шага', 'шагов'])}`, ms !== undefined && ms > 0 ? fmtClock(ms) : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`sa-card completed sa-recap${open ? ' open' : ''}`}>
      <button type="button" className="sa-head sa-recap-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <StatusMark status="completed" />
        <span className="sa-desc">Что сделано</span>
        <span className="sa-meta">{meta}</span>
        <CaretDown size={14} className="sa-chev" aria-hidden />
      </button>
      {open && <Trail steps={steps} live={false} all />}
    </div>
  );
}

/** A row of the panel: a sub-agent (running or finished this turn), or
 *  another background task. */
export interface PanelRow {
  id: string;
  label: string;
  kind?: string;
  lastAction?: string;
  since: number;
  agent?: Subagent;
  toolUseId?: string;
  /** The sub-agent that started this task (`BackgroundTask.owner`). */
  owner?: string;
  /** Same `repeatKey` = the same task repeated: one row (`collapseRepeats`). */
  repeatKey?: string;
  /** Every task id the row stands for, when it stands for more than one. */
  ids?: string[];
}

const idsOf = (row: PanelRow): string[] => row.ids ?? [row.id];

function PanelRowView({ row, api, now }: { row: PanelRow; api: SubagentsApi | null; now: number }) {
  const [open, setOpen] = useState(false);
  const a = row.agent;
  const status: SubagentStatus = a?.status ?? 'running';
  const running = status === 'running';
  const end = running ? now : (a?.endedAt ?? now);
  const quiet = quietFor(a, now);
  const model = modelName(a?.model);
  const expandable = !!(a && (a.steps?.length || a.recent?.length || a.summary));
  const rowStep = row.lastAction ? humanAction(row.lastAction) : undefined;
  return (
    <li className={`sa-row ${status}`}>
      <div className="sa-row-line">
        <StatusMark status={status} />
        <button
          type="button"
          className="sa-row-main"
          onClick={() => expandable && setOpen((v) => !v)}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
        >
          {row.kind && <span className="sa-kind">{row.kind}</span>}
          <span className="sa-desc">{row.label}</span>
          {idsOf(row).length > 1 && <span className="sa-count">× {idsOf(row).length}</span>}
          {row.owner && <span className="sa-owner" title={`Запустил: ${row.owner}`}>{row.owner}</span>}
          {running && rowStep && !open && <span className="sa-row-now" title={rowStep.detail}>{rowStep.text}</span>}
        </button>
        <span className="sa-meta">
          {a?.plan && a.plan.total > 0 && <span className="plan-row-count" title="Шаги плана">{a.plan.done}/{a.plan.total} · </span>}
          {model ? `${model} · ` : ''}
          {a?.tokens ? `${fmtTokens(a.tokens)} · ` : ''}
          {fmtClock(end - row.since)}
          {quiet !== undefined && <span className="sa-quiet"> · тихо {fmtClock(quiet)}</span>}
        </span>
        {api && (row.toolUseId || a) && (
          <button type="button" className="sa-link" onClick={() => api.open({ toolUseId: row.toolUseId, id: a?.id, title: `${row.kind ?? 'агент'} · ${row.label}` })}>
            Открыть
          </button>
        )}
        {running && api?.stop ? (
          <button type="button" className="sa-link danger" onClick={async () => { if (await confirmStop(`Остановить «${row.label}»${idsOf(row).length > 1 ? ` (${idsOf(row).length})` : ''}? Продолжить его потом не получится.`)) idsOf(row).forEach((id) => api.stop!(id)); }} aria-label={`Остановить: ${row.label}`}>
            Стоп
          </button>
        ) : (
          !running && <span className="sa-word">{STATUS_WORD[status]}</span>
        )}
      </div>
      {open && a && (
        <div className="sa-row-more">
          <Steps agent={a} />
          {a.summary && !running && <div className="sa-summary open">{a.summary}</div>}
        </div>
      )}
    </li>
  );
}

/**
 * Over the composer: the helpers of this turn whose card is not on screen — what still runs (sub-agents
 * and other background tasks, each with its clock and a Stop) and what has
 * finished since the person last spoke (a mark, how long it took, its report
 * a click away). A finished helper does not vanish the moment it ends.
 */
export function SubagentPanel({ rows }: { rows: PanelRow[] }) {
  const api = useContext(SubagentsContext);
  const running = rows.filter((r) => (r.agent?.status ?? 'running') === 'running');
  const now = useNow(running.length > 0);
  if (!rows.length) return null;
  const runningIds = running.flatMap(idsOf);
  const title = running.length ? `В фоне · ${runningIds.length}` : 'Помощники';
  const done = rows.length - running.length;
  return (
    <div className="sa-panel" role="region" aria-label={title}>
      <div className="sa-panel-head">
        {running.length > 0 ? <span className="sa-mark running" aria-hidden /> : <Check size={12} className="sa-mark done" aria-hidden />}
        <span>
          {title}
          {running.length > 0 && done > 0 ? ` · готово ${done}` : ''}
        </span>
        {api?.stop && running.length > 1 && (
          <button type="button" className="sa-link danger" onClick={async () => { if (await confirmStop(`Остановить все фоновые задачи (${runningIds.length})?`)) runningIds.forEach((id) => api.stop!(id)); }}>
            Остановить все
          </button>
        )}
      </div>
      <ul className="sa-rows">
        {rows.map((r) => (
          <PanelRowView key={r.id} row={r} api={api} now={now} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The sub-agent's own transcript, read-only, over the session. Polls while the
 * agent runs — the file grows as it works — and stops once it ended.
 */
export function SubagentTranscript({
  target,
  running,
  load,
  render,
  onClose,
}: {
  target: OpenTarget;
  running: boolean;
  load: () => Promise<HistoryMessage[]>;
  render: (messages: HistoryMessage[]) => ReactNode;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<HistoryMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      load()
        .then((m) => !cancelled && (setMessages(m), setError(null)))
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    void read();
    if (!running) return () => void (cancelled = true);
    const t = setInterval(read, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one target per mount
  }, [running]);
  const body = useMemo(() => (messages ? render(messages) : null), [messages, render]);
  return (
    <SideSheet title={target.title} badge={running ? 'работает' : undefined} onClose={onClose}>
      {error ? (
        <div className="line error">{error}</div>
      ) : messages === null ? (
        <div className="line status">Загружаю…</div>
      ) : messages.length === 0 ? (
        <div className="line status">Расшифровки помощника нет — CLI её не сохранил или сессия почищена.</div>
      ) : (
        body
      )}
    </SideSheet>
  );
}
