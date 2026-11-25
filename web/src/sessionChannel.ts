import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseSubagents, type Subagent } from '@cc-remote/shared';
import type {
  ActiveRunInfo,
  BrowserToCentral,
  CentralToBrowser,
  FileInput,
  ImageInput,
  PermissionMode,
  SessionCategory,
} from '@cc-remote/shared';
import { newId } from './lib.js';
import { humanAction } from './stepText.js';
import { parseRateLimit, type RateLimitNotice } from './rateLimit.js';
import {
  HEARTBEAT_CODES,
  alreadyFocused,
  createUnsentGuard,
  foldStreamEvent,
  freezeStreamingTail,
  keepUnansweredTail,
  reconcileActivity,
  type ActiveRun,
  attachmentLabel,
  foldUserTurn,
  type TranscriptLine,
} from './central-reducers.js';
import type { ContextUsageInfo, RunSettingsInfo, StartSettings, ToolRequest } from './useCentral.js';

/**
 * One session VIEW on the window's one hub socket.
 *
 * Until 24.09.2026 every pane of the split was a whole `useCentral` — its own
 * /ui socket, its own copy of the fleet snapshot (hundreds of KB), its own
 * handshake before it could show anything, and an empty machine list that read
 * as «Машина офлайн» until its snapshot landed. What a pane actually needs of
 * its own is small: the run it follows and that run's transcript tail, busy
 * flag, pending approval, model/mode/effort and context — everything below.
 * The socket, the fleet, RPC and mirrors are the window's.
 *
 * Each view tags what it sends with its `id` (`ref` on the wire). The hub
 * copies that onto every frame it sends back while handling the message
 * (`reply_ref` in server-rs), which is how a refusal reaches the composer that
 * sent the text and how the replay a `subscribe` triggers is drawn only in the
 * view that asked — a view already following that run has the frames already.
 */

/** What the window's connection lends each view. */
export interface HubLink {
  /** `machineHint`: the machine this view is showing - how a frame about a run
   *  this browser did not open itself finds its machine (E2EE sealing). */
  send: (msg: BrowserToCentral, quiet?: boolean, machineHint?: string) => boolean;
  /** Join the connection's frame fan-out; returns the way out. */
  register: (port: ChannelPort) => () => void;
  /** This view follows `runId` on the current socket. */
  hold: (runId: string, viewId: string) => void;
  /** …and no longer does. The socket is unsubscribed only when no other view
   *  on it still follows the run — otherwise closing one pane would silence
   *  the other pane of the same session. */
  release: (runId: string, viewId: string) => void;
  /** The fleet's active runs as of the last frame — read at call time. */
  activeRuns: () => ActiveRunInfo[];
  flashError: (message: string, ms?: number) => void;
}

/** What a view answers to. Stable for the view's lifetime; reads refs. */
export interface ChannelPort {
  id: string;
  /** A frame about runs. `opened` returns whether this view claims it. */
  frame: (msg: CentralToBrowser) => boolean;
  /** A (re)connected socket: the hub remembers no subscription from before.
   *  `lost`: the previous one died without closing (socketWatch.ts), so what was
   *  written into it last may have gone nowhere. */
  socketOpened: (lost?: boolean) => void;
  socketClosed: () => void;
  /** Back from a hushed background tab: frames were dropped, not queued. */
  woke: () => void;
  /** The run this view follows, if any. */
  runId: () => string | undefined;
  activity: (runs: ActiveRunInfo[]) => void;
}

/** How long a view waits, on the socket that replaced a dead one, for the replay
 *  or the activity board to confirm what it had sent. */
const LOST_SETTLE_MS = 6_000;

/** The optimistic echoes of texts that came back, taken off the end. */
function dropEchoes(lines: TranscriptLine[], texts: string[]): TranscriptLine[] {
  let out = lines;
  for (const text of [...texts].reverse()) {
    const last = out[out.length - 1];
    // An attachment-only message shows a placeholder in place of its empty text.
    if (last?.kind === 'user' && (last.text === text || (!text.trim() && last.carried))) out = out.slice(0, -1);
  }
  return out;
}

export type TurnPhase = 'unknown' | 'working' | 'ended' | 'settled';

/** A task the CLI runs in the background for the followed run — a Bash with
 *  `run_in_background`, a backgrounded subagent. `since` is ms epoch. */
export interface BackgroundTask {
  id: string;
  type: string;
  description: string;
  since: number;
  /** The sub-agent that started it; absent for the session's own tasks. */
  owner?: string;
  /** That sub-agent's task id: two helpers can share a name. */
  ownerId?: string;
}

const NO_TASKS: BackgroundTask[] = [];
const NO_AGENTS: Subagent[] = [];

/**
 * Shell syntax a sentence written for a person does not carry. A background
 * Bash started without a `description` arrives with the COMMAND in its place
 * (the SDK falls back to it), and the pane printed it verbatim — «в фоне: for
 * i in $(seq 1 55); do if git ls-remote …» (28.09.2026, «что за подпись
 * странная?»). The line stays; the command does not.
 */
const SHELL_SYNTAX = /\$\(|\$\{|\$[A-Za-z_]|&&|\|\||[;|`<>]|2>&1|\bdo\b[\s\S]*\bdone\b/;

/** What «в фоне: …» names a task by: its description when a person could
 *  have written it; a command in its place is worded like a step («Жду»,
 *  «Прогоняю тесты на stage») — three rows of bare «команда» told nothing
 *  apart (31.10.2026); nothing at all → what kind of thing it is. */
export function backgroundTaskLabel(t: Pick<BackgroundTask, 'type' | 'description'>): string {
  const d = t.description.trim();
  if (/agent/i.test(t.type)) return d && !SHELL_SYNTAX.test(d) ? d : 'агент';
  if (!d) return 'команда';
  // The sub-agent «Bash · what» reader already tells a sentence from a
  // command — `sleep 30` and `npm test` carry no shell punctuation.
  const said = humanAction(`Bash · ${d}`).text;
  return said === 'Выполняю команду' || said === 'Запускаю команду' ? 'команда' : said;
}

/** The agent cuts a description here; at this length the end may differ. */
const DESCRIPTION_CAP = 200;

/** Tasks with this key are one line to a person: same kind, same words, same
 *  owner — a sub-agent re-arming one watcher. Stop takes the whole row, so no
 *  key for what must not be taken along: a sub-agent (its own work, even while
 *  its `subagents` entry is missing), a task that says nothing about itself, a
 *  description the agent may have cut (usually a long command). */
export function backgroundTaskRepeatKey(t: Pick<BackgroundTask, 'type' | 'description' | 'ownerId'>): string | undefined {
  if (/agent/i.test(t.type) || t.description.length >= DESCRIPTION_CAP) return undefined;
  const d = t.description.trim();
  return d ? JSON.stringify([t.type, t.ownerId ?? '', d]) : undefined;
}

/** Folds rows sharing a `repeatKey` into the first one's place: every id (Stop
 *  must reach them all), the earliest start. Rows without a key stay as they are. */
export function collapseRepeats<R extends { id: string; since: number; ids?: string[]; repeatKey?: string }>(rows: R[]): R[] {
  const first = new Map<string, R>();
  const out: R[] = [];
  for (const row of rows) {
    const head = row.repeatKey ? first.get(row.repeatKey) : undefined;
    if (!head) {
      if (row.repeatKey) first.set(row.repeatKey, row);
      out.push(row);
      continue;
    }
    head.ids = [...(head.ids ?? [head.id]), row.id];
    head.since = Math.min(head.since, row.since);
  }
  return out;
}

/** The agent's `background_tasks` status → the list, dropping malformed rows. */
export function parseBackgroundTasks(data: Record<string, unknown> | undefined): BackgroundTask[] {
  const raw = data?.['tasks'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t): BackgroundTask[] => {
    if (!t || typeof t !== 'object') return [];
    const r = t as Record<string, unknown>;
    if (typeof r['id'] !== 'string') return [];
    return [{
      id: r['id'],
      type: typeof r['type'] === 'string' ? r['type'] : '',
      description: typeof r['description'] === 'string' ? r['description'] : '',
      since: typeof r['since'] === 'number' ? r['since'] : Date.now(),
      ...(typeof r['owner'] === 'string' && r['owner'] ? { owner: r['owner'] } : {}),
      ...(typeof r['ownerId'] === 'string' && r['ownerId'] ? { ownerId: r['ownerId'] } : {}),
    }];
  });
}

export interface SessionChannel {
  /** Names this view on the wire (`ref`). */
  id: string;
  lines: TranscriptLine[];
  clearLines: () => void;
  active: ActiveRun | null;
  busy: boolean;
  /**
   * Where the followed run's turn stands, for whatever wants to speak only
   * when the person has the floor (the suggestion strip).
   * - `unknown`: attached to a run we did not watch finish, or none at all —
   *   treated as over, which is what a reopened session is;
   * - `working`: this view sent input and no turn has ended since;
   * - `ended`: a `result` arrived, but the agent has not said the work is done
   *   (a background task may still run, the CLI may wake on it) — hold;
   * - `settled`: the agent's `turn_settled` — really over.
   */
  turnPhase: TurnPhase;
  /**
   * What the followed run still has running in the background after its turn
   * ended. Non-empty = the job is not over even though the turn is: the CLI
   * will wake on the task and carry on (and the hub keeps the run `working`).
   */
  background: BackgroundTask[];
  /** The followed run's sub-agents (the agent's `subagents` level): the cards
   *  in the transcript and the rows of the panel over the composer. */
  subagents: Subagent[];
  /**
   * The plan-limit warning of the machine the followed run is on — the strip
   * over the composer (`RateLimitBanner`). An ACCOUNT fact, so it is kept per
   * machine, not per run: opening another session there keeps it. Claude's
   * only — the pane does not show it over a Codex session.
   */
  rateLimit: RateLimitNotice | null;
  toolReq: ToolRequest | null;
  permissionMode: PermissionMode | null;
  runConfirmed: boolean;
  contextUsage: ContextUsageInfo | null;
  sessionCost: number | null;
  runSettings: RunSettingsInfo | null;
  compact: () => void;
  refusal: number;
  recoveredText: { machineId: string; sessionId: string; text: string } | null;
  clearRecovered: () => void;
  open: (
    machineId: string,
    sessionId: string,
    message?: string,
    images?: ImageInput[],
    files?: FileInput[],
    startup?: Pick<StartSettings, 'model' | 'effort'>,
  ) => boolean;
  newSession: (
    machineId: string,
    cwd: string,
    message?: string,
    images?: ImageInput[],
    category?: SessionCategory,
    source?: 'claude' | 'codex',
    files?: FileInput[],
    startup?: StartSettings,
  ) => boolean;
  takeover: (machineId: string, sessionId: string, message?: string, images?: ImageInput[], files?: FileInput[]) => boolean;
  focusSession: (machineId: string, sessionId: string) => void;
  sendInput: (text: string, images?: ImageInput[], files?: FileInput[]) => boolean;
  interrupt: () => void;
  closeRun: () => void;
  decideTool: (allow: boolean, updatedInput?: Record<string, unknown>, permissionMode?: PermissionMode) => void;
}

/** What a message with attachments but no text says in the transcript. It used
 *  to be a hardcoded "[image]", which is now a lie half the time. */
export function attachmentPlaceholder(images?: ImageInput[], files?: FileInput[]): string {
  // The same words the hub's `user_turn` is shown with on the other screens —
  // one helper, so the sender's echo and that frame fold into one bubble.
  return attachmentLabel(images?.length ?? 0, files?.map((f) => f.name) ?? []);
}

const NO_STATES = new Map();

/** Frames a `subscribe` REPLAYS — tagged with the view that asked. Another
 *  view already following the run has them from the live stream, and drawing
 *  the replay too would print the current turn twice. Facts about the run
 *  (`run_status`, `session_started`, `tool_resolved`) are never skipped. */
function isReplayForAnother(msg: { ref?: string }, id: string): boolean {
  return msg.ref !== undefined && msg.ref !== id;
}

/** The part of a start/resume pick the run will report back, or null when
 *  nothing was pinned — then the account decides and there is nothing to
 *  claim before the run names its model. */
export function sentPick(startup?: Pick<StartSettings, 'model' | 'effort'>): RunSettingsInfo | null {
  if (!startup?.model && !startup?.effort) return null;
  return {
    ...(startup.model ? { model: startup.model } : {}),
    ...(startup.effort ? { effort: startup.effort } : {}),
  };
}

export function useSessionChannel(link: HubLink): SessionChannel {
  const [id] = useState(() => newId('v', 8));
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('unknown');
  // Kept WITH the run it came from: a list belongs to one run, and following
  // another must not show the old one. Cleared on (re)subscribe, synchronously
  // — a reset effect could land after the hub's replay of the live list.
  const [backgroundOf, setBackgroundOf] = useState<{ runId: string; tasks: BackgroundTask[] } | null>(null);
  const background = useMemo(
    () => (backgroundOf && backgroundOf.runId === active?.runId ? backgroundOf.tasks : NO_TASKS),
    [backgroundOf, active?.runId],
  );
  // Same lifetime as the background list: one run's, cleared on (re)subscribe.
  const [subagentsOf, setSubagentsOf] = useState<{ runId: string; agents: Subagent[] } | null>(null);
  const subagents = useMemo(
    () => (subagentsOf && subagentsOf.runId === active?.runId ? subagentsOf.agents : NO_AGENTS),
    [subagentsOf, active?.runId],
  );
  const [rateLimitOf, setRateLimitOf] = useState<Record<string, RateLimitNotice>>({});
  const rateLimit = (active?.machineId && rateLimitOf[active.machineId]) || null;
  /** A spent window was reported during the current turn — its own `result`
   *  must not clear the plate it just raised. */
  const spentThisTurn = useRef(false);
  const [toolReq, setToolReq] = useState<ToolRequest | null>(null);
  /** Mirrors `toolReq` for the decision path, which must read it OUTSIDE a
   *  state updater — see `decideTool`. */
  const toolReqRef = useRef<ToolRequest | null>(null);
  toolReqRef.current = toolReq;
  const [permissionMode, setPermMode] = useState<PermissionMode | null>(null);
  const [runSettings, setRunSettings] = useState<RunSettingsInfo | null>(null);
  /**
   * The model/effort a start (or a resume) was SENT with, held until the run
   * reports its own settings.
   *
   * Without it the composer of a brand-new session had nothing to name between
   * the start screen and the run's first `run_settings` — that arrives with the
   * run's `system init`, seconds later — and fell back to the account default.
   * So the label read «Opus» on the start screen, «Sonnet» for those seconds
   * and «Opus» again once the run spoke (07.10.2026). What was sent IS what the
   * agent pins (`new_session.model` → `query({ model })`), so it is a true
   * statement until the run's own report replaces it.
   */
  const sentSettings = useRef<RunSettingsInfo | null>(null);
  /** The run whose own `run_settings` arrived since this view last switched.
   *  A fast agent can report BEFORE React runs the run-id reset below, and that
   *  reset must not then wipe the report it was racing. */
  const reportedFor = useRef<string | null>(null);
  // The focused run has produced agent-side activity since we attached. `opened`
  // is NOT this: the hub acks it the moment it queues the resume, and the agent
  // can still answer `yielded` afterwards. Anything holding user text must wait
  // for this, not for the ack.
  const [runConfirmed, setRunConfirmed] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsageInfo | null>(null);
  /** What the focused run's session has cost so far, in USD, as the SDK
   *  reports it on each `result`. Null until the first turn ends, and for
   *  runtimes that do not say. */
  const [sessionCost, setSessionCost] = useState<number | null>(null);
  /**
   * Bumped ONLY when the hub refuses something this view asked for.
   *
   * `error` is a display channel: a toast. It carries hub refusals, lost
   * connections and — since dictation started reporting through it — a failed
   * transcription. Chat was using it as the signal that a RESUME had been
   * refused, so any toast at all while a resume was in flight put the message
   * back in the composer while it was still on its way.
   *
   * A counter rather than a flag: two refusals in a row are two events, and a
   * boolean that is already true says nothing the second time.
   */
  const [refusal, setRefusal] = useState(0);
  /** The last text handed to a live run, and the way back to the composer if it
   *  turns out nothing received it. See `createUnsentGuard`. */
  const unsent = useRef(createUnsentGuard());
  /** What the last `open` carried, until the hub answers it. A `run_active`
   *  refusal of it hands this to the session's idle run (see `onError`). */
  const lastOpen = useRef<{
    machineId: string;
    sessionId: string;
    text: string;
    images?: ImageInput[];
    files?: FileInput[];
  } | null>(null);
  const [recoveredText, setRecoveredText] = useState<SessionChannel['recoveredText']>(null);

  const activeRef = useRef<ActiveRun | null>(null);
  activeRef.current = active;
  // Subscription belongs to one WebSocket connection. A reconnect preserves
  // the run identity but must attach the fresh socket to the hub fanout again.
  const attachedRunRef = useRef<string | null>(null);
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  const addLine = useCallback(
    (kind: TranscriptLine['kind'], text: string, attached?: { images?: ImageInput[]; files?: FileInput[] }) => {
      // Speech is stamped, machinery is not — same rule the stream reducer uses.
      const ts = kind === 'user' || kind === 'assistant' ? Date.now() : undefined;
      // The wire payload carries everything a thumbnail needs; no second copy
      // has to be threaded down from the composer.
      const images = attached?.images?.map((i) => `data:${i.media_type};base64,${i.data}`);
      const files = attached?.files?.map((f) => f.name);
      setLines((prev) => [
        ...prev,
        {
          id: nextId(),
          kind,
          text,
          ...(ts ? { ts } : {}),
          ...(images?.length ? { images } : {}),
          ...(files?.length ? { files } : {}),
        },
      ]);
    },
    [],
  );

  /** Everything this view sends names it — see the module note. */
  const send = useCallback(
    (msg: BrowserToCentral, quiet = false) =>
      link.send({ ...msg, ref: id } as BrowserToCentral, quiet, activeRef.current?.machineId),
    [link, id],
  );
  const subscribe = useCallback(
    (runId: string): boolean => {
      if (!send({ type: 'subscribe', runId }, true)) return false;
      // The hub re-states only a NON-empty list; one that emptied while this
      // view was not following the run must not survive the re-attach. Synchronous
      // and queued before the hub's answer, so its replay lands on top of it.
      setBackgroundOf(null);
      setSubagentsOf(null);
      attachedRunRef.current = runId;
      link.hold(runId, id);
      return true;
    },
    [send, link, id],
  );
  const leave = useCallback(
    (runId: string | undefined) => {
      if (!runId) return;
      if (attachedRunRef.current === runId) attachedRunRef.current = null;
      link.release(runId, id);
    },
    [link, id],
  );
  /** Our own new_session run that focusSession kept holding while the hub
   *  still listed it without a name; resolved on its `session_started`. */
  const kept = useRef<{ runId: string; machineId: string } | null>(null);
  const dropKept = useCallback(() => {
    const k = kept.current;
    kept.current = null;
    if (k && k.runId !== activeRef.current?.runId) link.release(k.runId, id);
  }, [link, id]);

  // ---- the frames ---------------------------------------------------------
  const frame = (msg: CentralToBrowser): boolean => {
    switch (msg.type) {
      case 'opened': {
        // Accept the ack only for the session we're still looking at. A late
        // ack (open/subscribe of session A answered after the user switched
        // to B) must not hijack the view — and its run must stop streaming
        // at us, or it stays in the run's fanout forever.
        const cur = activeRef.current;
        // And never on another MACHINE than the one this view is showing: the
        // hub does not get to move a view (and what it types) to a machine
        // whose key it may not hold (docs/E2EE.md).
        if (
          cur &&
          cur.machineId === msg.machineId &&
          (cur.runId === msg.runId ||
            cur.sessionId === msg.sessionId ||
            (!cur.sessionId && msg.ref === id))
        ) {
          const next = { runId: msg.runId, machineId: msg.machineId, sessionId: msg.sessionId || cur.sessionId };
          activeRef.current = next;
          attachedRunRef.current = msg.runId;
          lastOpen.current = null;
          link.hold(msg.runId, id);
          setActive(next);
          return true;
        }
        if (msg.ref === id) leave(msg.runId);
        return false;
      }
      case 'session_started': {
        // A new_session run just learned its real session id — swap the
        // placeholder so the composer + view bind to the real session.
        const cur = activeRef.current;
        if (cur && cur.runId === msg.runId) {
          const next = { runId: msg.runId, machineId: cur.machineId, sessionId: msg.sessionId };
          activeRef.current = next;
          setActive(next);
        } else if (kept.current?.runId === msg.runId) {
          // The run focusSession kept for us (see there): ours again if this
          // view now shows the session it was named, released otherwise.
          const k = kept.current;
          kept.current = null;
          if (cur && !cur.runId && cur.machineId === k.machineId && cur.sessionId === msg.sessionId) {
            const next = { runId: msg.runId, machineId: k.machineId, sessionId: msg.sessionId };
            activeRef.current = next;
            attachedRunRef.current = msg.runId;
            setActive(next);
          } else {
            leave(msg.runId);
          }
        }
        return false;
      }
      case 'stream': {
        // Only the followed run feeds the transcript; background runs are
        // tracked via `activity` (board / badges), not interleaved here.
        if (msg.runId !== activeRef.current?.runId || isReplayForAnother(msg, id)) return false;
        setRunConfirmed(true);
        // The run is talking, so whatever we last handed it was received. Not
        // proof after a dead socket: a replay and a run that was already busy
        // talk without having heard us (`settleLost` decides by the run's record).
        if (!awaitingLost.current) unsent.current.delivered();
        if (msg.event.code === 'turn_settled') {
          setTurnPhase('settled');
          return false;
        }
        // A plan-limit warning is the strip over the composer, not a line: it
        // repeats after every request and a line of it scrolled away. The
        // spent window stays a line as well — it is why the turn stopped.
        if (msg.event.code === 'rate_limit') {
          const notice = parseRateLimit(msg.event.data);
          const machineId = activeRef.current?.machineId;
          if (notice && machineId) setRateLimitOf((p) => ({ ...p, [machineId]: notice }));
          if (notice?.status === 'rejected') spentThisTurn.current = true;
          if (notice?.status !== 'rejected') return false;
        }
        if (msg.event.code === 'background_tasks') {
          setBackgroundOf({ runId: msg.runId, tasks: parseBackgroundTasks(msg.event.data) });
          return false;
        }
        // A level for the cards and the panel, never a transcript line.
        if (msg.event.code === 'subagents') {
          setSubagentsOf({ runId: msg.runId, agents: parseSubagents(msg.event.data) });
          return false;
        }
        // The CLI's own turn state. The agent withholds a turn's `result` while
        // a background task lives (turn-settle.ts), so `idle` here is the only
        // sign that the TURN ended while the JOB did not — what switches the
        // pane from «работает…» to «в фоне: …». `running` with nobody having
        // typed is the CLI waking itself on the task: work like any other.
        if (msg.event.code === 'session_state') {
          const state = msg.event.data?.['state'];
          if (state === 'running') {
            setBusy(true);
            setTurnPhase('working');
          } else if (state === 'idle') {
            setTurnPhase((p) => (p === 'working' ? 'ended' : p));
          }
          return false;
        }
        if (msg.event.kind === 'result') {
          setBusy(false);
          setTurnPhase('ended');
          // The CLI never says «allowed again» (the agent drops `allowed`), so
          // a turn that went through without a refusal is the sign: extra
          // usage switched on, or the window freed up. Without this the ember
          // plate stayed until its old reset — or forever, with none given.
          const mid = activeRef.current?.machineId;
          if (!spentThisTurn.current && mid) {
            setRateLimitOf((p) => {
              if (p[mid]?.status !== 'rejected') return p;
              const { [mid]: _spent, ...rest } = p;
              return rest;
            });
          }
          spentThisTurn.current = false;
          // What the turn cost, as the SDK reported it. `total_cost_usd` is
          // the session's running total, so the latest value is the answer.
          const cost = msg.event.data?.['total_cost_usd'];
          if (typeof cost === 'number') setSessionCost(cost);
        }
        // The CLI's own spinner states are a sign of life, not a line.
        if (msg.event.code && HEARTBEAT_CODES.has(msg.event.code)) return false;
        setLines((prev) => foldStreamEvent(prev, msg.event, nextId));
        return false;
      }
      case 'tool_request':
        // Only the followed run may raise the approval modal — a background
        // run must not steal the view of another session.
        if (msg.runId !== activeRef.current?.runId || isReplayForAnother(msg, id)) return false;
        // Re-delivery of the SAME request is idempotent. The agent replays a
        // pending request on every `register_ack` and the hub replays it on
        // every `subscribe`, both deliberately, so an unanswered question
        // arrives again after any reconnect. Replacing the state object with
        // an equal one re-mounts the modal — losing whatever the person had
        // already picked in it.
        setToolReq((prev) =>
          prev?.requestId === msg.requestId
            ? prev
            : { runId: msg.runId, requestId: msg.requestId, tool: msg.tool, input: msg.input, title: msg.title },
        );
        return false;
      case 'user_turn':
        // Not filtered by `isReplayForAnother`: the fold is idempotent by
        // `turnId`, and a view that already follows the run is exactly the
        // one that must see a turn another screen just sent. Only our own
        // replay may MOVE a line kept across the reconnect (`carried`).
        if (msg.runId !== activeRef.current?.runId) return false;
        unsent.current.echoed(msg.text, msg.truncated);
        setLines((prev) => foldUserTurn(prev, msg, nextId, Date.now, !isReplayForAnother(msg, id)));
        return false;
      case 'tool_resolved':
        // Somebody answered it — another device, another tab, or another view
        // on this very socket. Match on requestId alone: this only ever REMOVES
        // a prompt, and a stale one is worse than one dismissed a moment early.
        setToolReq((prev) => (prev?.requestId === msg.requestId ? null : prev));
        return false;
      case 'context_usage':
        if (msg.runId !== activeRef.current?.runId || isReplayForAnother(msg, id)) return false;
        setContextUsage({
          totalTokens: msg.totalTokens,
          maxTokens: msg.maxTokens,
          percentage: msg.percentage,
          autoCompactThreshold: msg.autoCompactThreshold,
          autoCompactEnabled: msg.autoCompactEnabled,
        });
        return false;
      case 'run_settings':
        // The one message that reports model/effort BACK. `set_model` and
        // `set_effort` travel outward only, so without this the pickers reset
        // to their placeholder on every reload while the run kept its setting.
        if (msg.runId !== activeRef.current?.runId) return false;
        // The run has spoken for itself: the sent pick has done its job, and
        // must not be re-seeded onto whatever this view follows next.
        sentSettings.current = null;
        reportedFor.current = msg.runId;
        setRunSettings({
          model: msg.model,
          activeModel: msg.activeModel,
          effort: msg.effort,
          // Rebuilt field by field, so each field has to be named: the agent
          // reported `activeEffort`, the hub relayed it, and this line once
          // being missing was all it took for the picker to never show it.
          activeEffort: msg.activeEffort,
          ultracode: msg.ultracode,
        });
        return false;
      case 'run_mode':
        // Server-authoritative permission mode for the followed run.
        if (msg.runId !== activeRef.current?.runId) return false;
        setPermMode(msg.mode);
        return false;
      case 'run_status':
        if (msg.runId !== activeRef.current?.runId) return false;
        if (msg.state === 'started') setRunConfirmed(true);
        else if (msg.state === 'idle') setBusy(false);
        else {
          setBusy(false);
          leave(msg.runId);
          activeRef.current = null;
          setActive(null);
          // A pick that rode a refused or ended run is not what the NEXT
          // resume sends — it must not outlive the run on the composer.
          sentSettings.current = null;
          reportedFor.current = null;
          setRunSettings(null);
          // The agent never launched this run — a transcript over the cap,
          // an editor holding the session, a cancelled start. Whatever rode
          // on the `open` was dropped with it, and the composer holds the
          // only copy: `refusal` is what makes Chat put it back.
          const refused = msg.code === 'resume_refused' || msg.state === 'yielded';
          if (refused) {
            lastOpen.current = null;
            link.flashError(msg.error ?? 'Сессия открыта в редакторе — отдали её обратно, чтобы не было конфликта.', 9000);
            // Take the optimistic echo back: nothing was sent.
            setLines((prev) => {
              const last = prev[prev.length - 1];
              return last?.kind === 'user' ? prev.slice(0, -1) : prev;
            });
            setRefusal((n) => n + 1);
          }
          addLine('status', `run ${msg.state}${msg.error ? `: ${msg.error}` : ''}`);
        }
        return false;
      case 'error':
        onError(msg);
        return false;
      default:
        return false;
    }
  };

  const onError = (msg: Extract<CentralToBrowser, { type: 'error' }>) => {
    // The message WAS delivered, minus attachments that did not fit —
    // the hub names them. A toast, nothing to take back.
    if (msg.code === 'attachments_dropped') {
      link.flashError(msg.message, 12_000);
      return;
    }
    // A live run already holds this session — a reason to WATCH it, not to
    // fight the lock (port of the CLI's b0503f9 recovery). The refusal names
    // the run: switch focus to it and subscribe. The refused open's message
    // was never delivered — the echo comes back and `refusal` hands the text
    // to the composer; do NOT auto-resend into a busy run.
    if (msg.code === 'run_active' || /already has an active run/i.test(msg.message)) {
      // The run that holds the session is OURS and is waiting for input — the
      // view had merely lost its run id (20.10.2026: a fresh session whose pane
      // went dormant). Bouncing the text back to the composer made the person
      // send everything twice; hand it to the run instead, as `input` would
      // have. A run that is working stays the composer's — no auto-resend into
      // a busy turn.
      const owner = activeRef.current;
      const refused = lastOpen.current;
      lastOpen.current = null;
      const holder = msg.runId ? link.activeRuns().find((r) => r.runId === msg.runId) : undefined;
      if (
        msg.runId &&
        owner &&
        refused &&
        holder?.state === 'idle' &&
        refused.machineId === owner.machineId &&
        refused.sessionId === owner.sessionId &&
        holder.machineId === owner.machineId &&
        holder.sessionId === owner.sessionId
      ) {
        sentSettings.current = null;
        reportedFor.current = null;
        const next = { runId: msg.runId, machineId: owner.machineId, sessionId: owner.sessionId };
        activeRef.current = next;
        setActive(next);
        subscribe(msg.runId);
        if (send({ type: 'input', runId: msg.runId, text: refused.text, images: refused.images, files: refused.files })) {
          unsent.current.sent(refused.text);
          inputBefore.current = holder.taskStartedAt;
          setBusy(true);
          setTurnPhase('working');
          return;
        }
      }
      setBusy(false);
      if (!attachedRunRef.current) {
        setLines((prev) => {
          const last = prev[prev.length - 1];
          return last?.kind === 'user' ? prev.slice(0, -1) : prev;
        });
      }
      setRefusal((n) => n + 1);
      // The pick rode the refused open; the run we attach to instead was
      // started by someone else, on settings of its own.
      sentSettings.current = null;
      reportedFor.current = null;
      if (msg.runId && owner) {
        const next = { runId: msg.runId, machineId: owner.machineId, sessionId: owner.sessionId };
        activeRef.current = next;
        setActive(next);
        subscribe(msg.runId);
        link.flashError('Прогон уже идёт — подключаюсь к нему.', 6000);
      } else {
        link.flashError(msg.message);
      }
      return;
    }
    // An open/resume rejection (e.g. session live elsewhere) must clear the
    // optimistic "working…" state set when the run was opened.
    lastOpen.current = null;
    setBusy(false);
    // No run ever attached, so a trailing optimistic user line belongs to the
    // `open` that was just refused. Take the echo back: the composer still
    // holds that text for a retry.
    if (!attachedRunRef.current) {
      setLines((prev) => {
        const last = prev[prev.length - 1];
        return last?.kind === 'user' ? prev.slice(0, -1) : prev;
      });
    }
    // The run the hub was addressed about is gone — so NOTHING we just sent
    // was delivered. Drop the stale runId so the composer recovers to a
    // dormant session (offers Resume) instead of no-op'ing sendInput.
    if (msg.code === 'run_gone' || /run not found/i.test(msg.message)) {
      leave(activeRef.current?.runId);
      setActive((prev) => (prev ? { machineId: prev.machineId, sessionId: prev.sessionId } : prev));
    }
    // Both say "nothing was delivered": the run is gone, or its agent is
    // between sockets (`machine_offline`). Either way the text goes back
    // where it can be sent again.
    const back = unsent.current.recover(msg.code, msg.message);
    const owner = activeRef.current;
    if (back.length && owner) {
      setRecoveredText({ machineId: owner.machineId, sessionId: owner.sessionId, text: back.filter((t) => t.trim()).join('\n\n') });
      setLines((prev) => dropEchoes(prev, back));
    }
    link.flashError(msg.message);
    setRefusal((n) => n + 1);
  };

  const resubscribe = () => {
    // A hub that RESTARTED has no memory of who was watching what, and a
    // reconnected socket is a new subscriber either way. Cheap and idempotent:
    // the hub answers `subscribe` by adding the socket and replaying the turn.
    const attached = activeRef.current?.runId;
    if (attached) subscribe(attached);
  };

  // The socket died without closing, and nothing on the new one has confirmed
  // what this view wrote into the old one. The hub will never refuse a frame it
  // never saw, so the view says it itself, unless the run's own record shows it
  // took an input since. Only a possibility, hence the words.
  const settleLost = () => {
    awaitingLost.current = false;
    const a = activeRef.current;
    if (!a) return;
    const run = link
      .activeRuns()
      .find((r) => (a.runId ? r.runId === a.runId : r.machineId === a.machineId && r.sessionId === a.sessionId));
    // Moves with every input the agent accepts, whatever the run is doing. An
    // agent that does not report it leaves «busy» as the only sign.
    if (run && a.runId) {
      const busyNow = run.state === 'working' || run.state === 'needs_attention';
      if (run.taskStartedAt === undefined) {
        if (busyNow) unsent.current.delivered();
      } else if (run.taskStartedAt !== inputBefore.current) unsent.current.tookOne();
    }
    // The resume did start: the board has its run and this view is joining it.
    if (run && !a.runId) lastOpen.current = null;
    if (lastOpen.current || unsent.current.pending()) {
      onError({
        type: 'error',
        code: 'connection_lost',
        message: 'Связь прерывалась, сообщение могло не дойти. Оно снова в поле ввода.',
      });
    } else if (!a.runId && !a.sessionId) {
      // A new chat has no composer of its own to give the text back to.
      link.flashError('Связь прерывалась, новый чат мог не запуститься. Если его нет в списке, скопируйте текст и начните ещё раз.', 12_000);
    }
  };

  // The port the connection talks to. Built once; every method reads refs, so
  // it never needs rebuilding — the latest render's closures are behind them.
  const impl = useRef({ frame, onError, resubscribe, settleLost });
  impl.current = { frame, onError, resubscribe, settleLost };
  /** The followed run's `taskStartedAt` when the last text was handed to it. */
  const inputBefore = useRef<number | undefined>(undefined);
  /** A dead socket was replaced and what it swallowed is not settled yet. */
  const awaitingLost = useRef(false);
  const lostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopLostTimer = () => {
    if (lostTimer.current) clearTimeout(lostTimer.current);
    lostTimer.current = null;
  };
  const port = useMemo<ChannelPort>(
    () => ({
      id,
      frame: (msg) => impl.current.frame(msg),
      socketOpened: (lost) => {
        // Drop transcript lines from before the disconnect: the hub does NOT
        // replay output missed while offline, so a surviving streaming tail
        // would glue onto the resumed stream with the gap silently missing.
        // …except what you just sent (see `keepUnansweredTail`).
        setLines(keepUnansweredTail);
        impl.current.resubscribe();
        stopLostTimer();
        if (lost) awaitingLost.current = true;
        if (awaitingLost.current) lostTimer.current = setTimeout(() => impl.current.settleLost(), LOST_SETTLE_MS);
      },
      socketClosed: () => {
        // The question stays open across another drop (`awaitingLost`).
        stopLostTimer();
        // Preserve the run identity: the hub owns the run lifecycle and the
        // socket is only a replaceable subscriber. The reconnect re-attaches.
        attachedRunRef.current = null;
        setBusy(false);
        setToolReq(null);
        // Freeze a mid-stream assistant line so it can't absorb later chunks.
        setLines(freezeStreamingTail);
      },
      woke: () => {
        setLines(keepUnansweredTail);
        // `subscribe` is the only thing that makes the hub replay a tool
        // approval raised while the page was asleep.
        impl.current.resubscribe();
      },
      runId: () => activeRef.current?.runId,
      activity: (runs) => {
        const result = reconcileActivity({
          rawRuns: runs,
          active: activeRef.current,
          attachedRunId: attachedRunRef.current,
          previousStates: NO_STATES,
          seeded: false,
          notify: false,
          viewerId: null,
          now: Date.now(),
          nextId,
        });
        if (result.activeChanged) {
          const was = activeRef.current?.runId;
          activeRef.current = result.active;
          setActive(result.active);
          if (was && was !== result.active?.runId) link.release(was, id);
        }
        attachedRunRef.current = result.attachedRunId;
        if (typeof result.busy === 'boolean') setBusy(result.busy);
        if (result.clearToolRequest) setToolReq(null);
        if (result.subscribeRunId) subscribe(result.subscribeRunId);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable by design, see above
    [id],
  );
  useEffect(() => {
    const off = link.register(port);
    return () => {
      off();
      stopLostTimer();
      // A closed pane stops following its run — unless another view on this
      // socket still does, which `release` decides.
      const runId = activeRef.current?.runId;
      if (runId) link.release(runId, id);
      dropKept();
    };
  }, [link, port, id, dropKept]);

  // A newly-followed run's mode is unknown until the agent reports it — clear
  // the previous one so the indicator falls back to the local default rather
  // than showing another session's (or a stale) mode.
  useEffect(() => {
    setPermMode(null);
    setRunConfirmed(false);
    setContextUsage(null);
    setSessionCost(null);
    // The run id changes twice on a start (placeholder → `opened` ack), and
    // each time this used to wipe the one thing known about it.
    if (!active?.runId || reportedFor.current !== active.runId) setRunSettings(sentSettings.current);
  }, [active?.runId]);

  // ---- the actions ----------------------------------------------------------
  const open = useCallback(
    (
      machineId: string,
      sessionId: string,
      message?: string,
      images?: ImageInput[],
      files?: FileInput[],
      startup?: Pick<StartSettings, 'model' | 'effort'>,
    ): boolean => {
      if (!send({ type: 'open', machineId, sessionId, message, images, files, ...startup })) return false;
      lastOpen.current =
        message?.trim() || images?.length || files?.length
          ? { machineId, sessionId, text: message ?? '', images, files }
          : null;
      sentSettings.current = sentPick(startup);
      reportedFor.current = null;
      setLines([]);
      setActive({ machineId, sessionId });
      setBusy(!!message?.trim() || !!images?.length || !!files?.length);
      setTurnPhase(message?.trim() || images?.length || files?.length ? 'working' : 'unknown');
      if (message?.trim() || images?.length || files?.length) {
        addLine('user', message ? message : attachmentPlaceholder(images, files), { images, files });
      }
      return true;
    },
    [send, addLine],
  );

  // Start a brand-new session in `cwd` on a machine. The hub allocates the run
  // and acks with an empty-id `opened`; the agent then mints the real session id
  // → `session_started` swaps the placeholder in.
  const newSession = useCallback(
    (
      machineId: string,
      cwd: string,
      message?: string,
      images?: ImageInput[],
      category?: SessionCategory,
      source?: 'claude' | 'codex',
      files?: FileInput[],
      startup?: StartSettings,
    ): boolean => {
      if (!send({ type: 'new_session', machineId, cwd, message, images, category, source, files, ...startup })) return false;
      lastOpen.current = null;
      dropKept();
      sentSettings.current = sentPick(startup);
      reportedFor.current = null;
      setLines([]);
      setActive({ machineId, sessionId: '' });
      setBusy(!!message?.trim() || !!images?.length || !!files?.length);
      setTurnPhase(message?.trim() || images?.length || files?.length ? 'working' : 'unknown');
      if (message?.trim() || images?.length || files?.length) {
        addLine('user', message ? message : attachmentPlaceholder(images, files), { images, files });
      }
      return true;
    },
    [send, addLine, dropKept],
  );

  // Force takeover: the agent terminates the editor's writer (confirmed dead),
  // then resumes here. Reports delivery, like `open` and `sendInput`.
  const takeover = useCallback(
    (machineId: string, sessionId: string, message?: string, images?: ImageInput[], files?: FileInput[]): boolean => {
      if (!send({ type: 'takeover', machineId, sessionId, message, images, files })) return false;
      lastOpen.current = null;
      sentSettings.current = null;
      reportedFor.current = null;
      setLines([]);
      setActive({ machineId, sessionId });
      setBusy(true);
      setTurnPhase('working');
      if (message?.trim() || images?.length || files?.length) {
        addLine('user', message?.trim() ? message : attachmentPlaceholder(images, files), { images, files });
      }
      return true;
    },
    [send, addLine],
  );

  // Attach the view to a session: subscribe to its live run if one exists,
  // otherwise leave it dormant (the composer will `open` it on first send).
  const focusSession = useCallback(
    (machineId: string, sessionId: string) => {
      // Re-focusing the session we are already driving is a no-op, not a switch.
      if (alreadyFocused(activeRef.current, machineId, sessionId)) return;
      // Another session: a pick sent for the previous one is not this one's.
      sentSettings.current = null;
      reportedFor.current = null;
      lastOpen.current = null;
      dropKept();
      const prev = activeRef.current?.runId;
      setLines([]);
      setBusy(false);
      setTurnPhase('unknown');
      setToolReq(null);
      // The safety net belongs to the session the text was typed in.
      unsent.current.left();
      awaitingLost.current = false;
      const runs = link.activeRuns();
      const run = runs.find((r) => r.machineId === machineId && r.sessionId === sessionId);
      // Our own new_session run that the hub's list still carries under the
      // EMPTY id: the route got the real name a beat before `activity` did.
      // Leaving it unsubscribed the turn we had just started — the answer then
      // went to nobody and the next send bounced with `run_active` (20.10.2026).
      // Keep holding it until `session_started` names it: this view takes it
      // back if the name is the session it now shows, and lets go otherwise.
      const own = prev ? runs.find((r) => r.runId === prev) : undefined;
      const unnamedOwn = !!own && own.machineId === machineId && !own.sessionId;
      // Stop following the run we're leaving. It keeps running on the agent
      // and remains available from the board or another client.
      if (prev && prev !== run?.runId) {
        if (unnamedOwn) kept.current = { runId: prev, machineId };
        else leave(prev);
      }
      // Only attach to a run that's still live on the hub. A run in a terminal
      // state has already been released there, so subscribing would bounce
      // with "Run not found" and leave `active.runId` set.
      const attachable = run && (run.state === 'working' || run.state === 'needs_attention' || run.state === 'idle');
      if (run && attachable) {
        const next = { runId: run.runId, machineId, sessionId };
        activeRef.current = next;
        setActive(next);
        setBusy(run.state === 'working');
        subscribe(run.runId);
      } else {
        const next = { machineId, sessionId };
        activeRef.current = next;
        attachedRunRef.current = null;
        setActive(next);
      }
    },
    [link, leave, subscribe, dropKept],
  );

  const sendInput = useCallback(
    (text: string, images?: ImageInput[], files?: FileInput[]): boolean => {
      const a = activeRef.current;
      if (!a?.runId || (!text.trim() && !images?.length && !files?.length)) return false;
      if (!send({ type: 'input', runId: a.runId, text, images, files })) return false;
      // Held until the hub either accepts it or tells us the run is gone.
      if (!unsent.current.pending()) {
        inputBefore.current = link.activeRuns().find((r) => r.runId === a.runId)?.taskStartedAt;
      }
      unsent.current.sent(text);
      addLine('user', text || attachmentPlaceholder(images, files), { images, files });
      setBusy(true);
      setTurnPhase('working');
      return true;
    },
    [send, addLine, link],
  );

  const clearRecovered = useCallback(() => setRecoveredText(null), []);

  const interrupt = useCallback(() => {
    const a = activeRef.current;
    if (a?.runId) send({ type: 'interrupt', runId: a.runId });
  }, [send]);

  const closeRun = useCallback(() => {
    const a = activeRef.current;
    if (a?.runId) {
      send({ type: 'close', runId: a.runId });
      leave(a.runId);
    }
    activeRef.current = null;
    setActive(null);
    sentSettings.current = null;
    reportedFor.current = null;
    setRunSettings(null);
    setBusy(false);
    setToolReq(null);
  }, [send, leave]);

  const decideTool = useCallback(
    (allow: boolean, updatedInput?: Record<string, unknown>, permissionMode?: PermissionMode) => {
      // The frame goes out HERE, not inside the state updater: an updater must
      // be pure and React may run it twice.
      const req = toolReqRef.current;
      if (!req) return;
      toolReqRef.current = null;
      setToolReq(null);
      send({ type: 'tool_decision', runId: req.runId, requestId: req.requestId, allow, updatedInput, permissionMode });
    },
    [send],
  );

  const compact = useCallback(() => {
    const a = activeRef.current;
    if (a?.runId) send({ type: 'compact', runId: a.runId });
  }, [send]);

  const clearLines = useCallback(() => setLines([]), []);

  return {
    id,
    lines,
    clearLines,
    active,
    busy,
    turnPhase,
    background,
    subagents,
    rateLimit,
    toolReq,
    permissionMode,
    runConfirmed,
    contextUsage,
    sessionCost,
    runSettings,
    compact,
    refusal,
    recoveredText,
    clearRecovered,
    open,
    newSession,
    takeover,
    focusSession,
    sendInput,
    interrupt,
    closeRun,
    decideTool,
  };
}
