import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subagent } from '@cc-remote/shared';
import { transcribeProject, type PolishResult } from './polish.js';
import {
  CAP_STATS_ON_DEMAND,
  decodeCentralToBrowser,
  type ActiveRunInfo,
  type AttentionState,
  type BrowserToCentral,
  type BuilderProfile,
  type CentralToBrowser,
  type ActiveEffortLevel,
  type EffortLevel,
  type Enrichment,
  type HistoryMessage,
  type FileInput,
  type ImageInput,
  type MachineSnapshot,
  type MachineStats,
  type RuntimeStatus,
  type MemoryEntry,
  type MemoryScope,
  type PermissionMode,
  PolishRequest,
  PolishResponse,
  type SessionSummary,
  type TeamMachine,
  RpcMethodSchema,
  RpcResultSchemas,
  type RpcMethod,
  type SessionCategory,
  type UsageInfo,
  type ViewerContext,
} from '@cc-remote/shared';
import {
  cleanSessions,
  cleanSnapshot,
  mergeTeamMachines,
  mergeInbox,
  pruneInbox,
  reconcileActivity,
  type ActiveRun,
  type NotifItem,
  dropReadNotifications,
  mergeReads,
  bellStamp,
  dropStamped,
  mergeStamps,
  parseBellSync,
  stampCovers,
  type BellStamp,
  type BellSync,
  type TranscriptLine,
} from './central-reducers.js';
import { clearRpcContent, mayCarryE2e } from '@cc-remote/shared';
import { hasRealContent, needsSeal, openFrame, sealFrame } from './e2ee/crypto.js';
import { hasAnyKey, hasKeyFor, keys as e2eeKeys, requestPairDialog, ringReady } from './e2ee/ring.js';
import { PendingRegistry } from './pending-registry.js';
import { LocalCache } from './localCache.js';
import { storageGet, storageSet } from './storage.js';
import { useSessionChannel, type BackgroundTask, type ChannelPort, type HubLink, type TurnPhase } from './sessionChannel.js';
import type { RateLimitNotice } from './rateLimit.js';
import { attentionLabel, isAutomatedSession, sessionKey } from './lib.js';

/** Optional extras for `/transcribe`: clip length in seconds and comma-separated session terms. */
export interface TranscribeOptions {
  durSec?: number;
  hints?: string;
}

/** Error texts other code recognises (NewProjectPanel.describeCreateError) —
 *  compared by identity of these constants, never by retyped wording. */
export const NO_HUB = 'нет связи с хабом';
export const RPC_TIMEOUT = 'машина не ответила вовремя';

export type { ActiveRun, NotifItem, TranscriptLine } from './central-reducers.js';

export interface ContextUsageInfo {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  autoCompactThreshold?: number;
  autoCompactEnabled: boolean;
}

/** What the focused run is actually set to, as reported by the agent. */
export interface RunSettingsInfo {
  /** Explicit model pick in force. Absent = the account default is running. */
  model?: string;
  /** Wire model id the runtime resolved to — what "default" currently means. */
  activeModel?: string;
  /** Explicit reasoning effort. Absent = the account default. */
  effort?: EffortLevel;
  /** The level the runtime reports it is REALLY running at — the twin of
   *  `activeModel`, and what lets a picker name a level for a session nobody
   *  pinned. Arrives with a turn's first tool call. */
  activeEffort?: ActiveEffortLevel;
  ultracode?: boolean;
}

/**
 * Is this page running inside the native desktop shell?
 *
 * The shell injects the marker (`initialization_script` on the window builder,
 * `windows/src-tauri/src/main.rs`). It matters because the shell has its OWN
 * connection to the hub and its own toasts — one that keeps working while this
 * page is frozen, which is precisely when notifications are wanted. Two
 * notifiers on one machine is how the same event arrived twice, and the one
 * that can be throttled into silence is the wrong one to keep.
 */
const NATIVE_SHELL =
  typeof window !== 'undefined' && !!(window as { __HEGAI_SHELL__?: string }).__HEGAI_SHELL__;

/** More news than a person can read as separate toasts becomes one that counts
 *  them. Mirrors `BURST_MAX` in `windows/src-tauri/src/hub/notify.rs`. */
const BURST_MAX = 3;

/** How long dictation waits for `/polish` before inserting what whisper wrote. */
const POLISH_DEADLINE_MS = 8_000;

/** News older than this is not news — the guard the backlog case needs. See
 *  `STALE_ALERT` in the same file. */
const STALE_ALERT_MS = 120_000;

/**
 * Turn fresh attention changes into OS notifications, or into one that counts
 * them, or into nothing.
 *
 * The bug this replaces: a straight `for` loop over every item, fired whenever
 * `document.hidden`. That reads as "the user is not looking, so tell them" —
 * and during a backlog drain it means "the user is STILL not looking, so tell
 * them four hundred times". A hidden desktop window keeps its socket open while
 * WebView2 freezes the page, so the hub's queue fills; when the renderer gets
 * CPU again every queued frame is reconciled in turn and each transition in the
 * whole missed history becomes its own interruption, with nothing anywhere to
 * stop it.
 */
function announce(fresh: NotifItem[]): void {
  if (NATIVE_SHELL) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  // `document.hidden` is the ONLY reason to notify — an on-screen page shows
  // attention itself, in the rail and on the board.
  if (!document.hidden) return;
  const now = Date.now();
  const live = fresh.filter((n) => now - n.ts < STALE_ALERT_MS);
  if (!live.length) return;
  try {
    if (live.length > BURST_MAX) {
      const waiting = live.filter((n) => n.state === 'needs_attention').length;
      new Notification('Hegai Code', {
        body: waiting
          ? `${live.length} обновлений, ${waiting} ждут ответа`
          : `${live.length} обновлений по вашим сессиям`,
        // One tag for every digest, so a second burst REPLACES the first
        // instead of stacking under it.
        tag: 'hegai-digest',
      });
      return;
    }
    for (const n of live) {
      const verb =
        n.state === 'needs_attention'
          ? // Name the tool when it is a permission prompt: "ждёт подтверждения:
            // Write" is answerable at a glance, "ждёт ответа" was not even true.
            attentionLabel(n) + (n.pendingKind === 'permission' && n.pendingTool ? `: ${n.pendingTool}` : '')
          : n.state === 'error'
            ? 'завершилась ошибкой'
            : 'готова';
      new Notification(`Hegai Code — ${n.title}`, {
        body: `${n.machineName ? n.machineName + ' · ' : ''}сессия ${verb}`,
        tag: n.runId,
      });
    }
  } catch {
    /* the OS refused; the inbox still has all of it */
  }
}

/**
 * What was picked on the start screen, before the session exists.
 *
 * The same three settings `RunSettingsInfo` reports and the `set_` controls
 * change — the difference is only that there is no run yet to send them to, so
 * they ride on `new_session` instead. Every field is optional and omission is
 * meaningful: an absent field leaves the machine's own default in force, which
 * is what every session did before this picker existed.
 */
export interface StartSettings {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
}

export interface ToolRequest {
  runId: string;
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  title?: string;
}

export interface MirrorHandle {
  close: () => void;
}
export type MirrorSink = (replace: boolean, messages: HistoryMessage[]) => void;
interface MirrorSubs {
  sink: MirrorSink;
  /** The live view died (agent offline / hub reconnect) — not just quiet. */
  onExit?: () => void;
}

export interface CentralState {
  status: 'connecting' | 'open' | 'closed';
  /** Bumped every time a backgrounded tab comes back and the hub was hushed
   *  while a run was attached. The hub DROPS frames for a paused socket rather
   *  than queueing them, so the focused run's stream has a hole in it — panes
   *  that render a transcript re-read it on a change here, the same way they do
   *  when `status` flips back to 'open' after a reconnect. */
  resumeEpoch: number;
  /** The fleet as the UI should show it — automated runs and CLOSED sessions
   *  filtered out unless `showAutomated` / `showClosed` is on (see the
   *  matching `…Hidden` counts). */
  machines: MachineSnapshot[];
  /** Team members' machines for the workspace owner / a manager: READ-ONLY
   *  hardware, kept apart from `machines` on purpose so nothing that lists
   *  machines (panel, pickers, files, board) can offer one. Only «Машины» draws
   *  it; live samples land in `machineStats` / `runtimes` by machine id. */
  teamMachines: TeamMachine[];
  /** The first snapshot has landed — until then a route naming an unknown
   *  session means «loading», not «missing». Sticky across reconnects. */
  hydrated: boolean;
  /** Session lookup over the UNFILTERED inventory. A URL is explicit intent,
   *  so the automated/closed list filters do not apply here. */
  findSession: (machineId: string, sessionId: string) => SessionSummary | undefined;
  viewer: ViewerContext | null;
  /** How many sessions the automated filter is holding back right now. */
  automatedHidden: number;
  showAutomated: boolean;
  setShowAutomated: (v: boolean) => void;
  /** How many sessions the «closed» filter is holding back right now. */
  closedHidden: number;
  showClosed: boolean;
  setShowClosed: (v: boolean) => void;
  /** Per-machine Claude account usage/limits, keyed by machineId. */
  usage: Record<string, UsageInfo>;
  /** Per-machine OpenAI Codex account usage/limits, keyed by machineId. */
  codexUsage: Record<string, UsageInfo>;
  /** Per-machine locally-computed builder profile, keyed by machineId. */
  profiles: Record<string, BuilderProfile>;
  /** Per-machine hardware/process telemetry, keyed by machineId. */
  machineStats: Record<string, MachineStats>;
  /** Ask the hub for live hardware samples (`stats_interest`) for as long as
   *  the caller shows them; returns the release. Reference-counted across
   *  callers and re-sent after a reconnect. Without a watcher the hub sends no
   *  samples at all — the screens that draw `machineStats` must hold one. */
  watchStats: () => () => void;
  /** Per-machine runtime status — what its Claude and Codex ARE (found,
   *  logged in as whom, own login or a gateway), keyed by machineId. A machine
   *  missing here has an agent too old to say: unknown, not broken. */
  runtimes: Record<string, RuntimeStatus>;
  /** Sessions with a fresh commit ("ready to close" nudge), keyed
   *  `machineId::sessionId`. Transient — set by `session_committed`, cleared when
   *  the card's stage changes. */
  committed: Record<string, boolean>;
  activeRuns: ActiveRunInfo[];
  /** `activeRuns` for the session LISTS: a run whose session the closed or
   *  automated filter holds back is dropped unless it is working or waiting for a decision.
   *  The lists add a row per run whose session they did not see (a session
   *  started a moment ago is not in the inventory yet), and the filtered
   *  inventory looks exactly like «not seen» — so a closed session with an
   *  idle run parked on it (Codex keeps one after every turn) came straight
   *  back and «Закрыть сессию» changed nothing on screen. */
  listedRuns: ActiveRunInfo[];
  notifications: NotifItem[];
  unread: number;
  lines: TranscriptLine[];
  /** Drop the live-line buffer after a convergence re-read of the transcript
   *  file, so re-read content isn't duplicated by its streamed copy. */
  clearLines: () => void;
  active: ActiveRun | null;
  busy: boolean;
  /** Where the followed run's turn stands — see `SessionChannel.turnPhase`. */
  turnPhase: TurnPhase;
  /** Background tasks the followed run still has alive — see `SessionChannel.background`. */
  background: BackgroundTask[];
  /** The followed run's sub-agents — see `SessionChannel.subagents`. */
  subagents: Subagent[];
  /** The plan-limit warning for the followed run's machine — see `SessionChannel.rateLimit`. */
  rateLimit: RateLimitNotice | null;
  toolReq: ToolRequest | null;
  /** The focused run's live permission mode as reported by the agent (null until
   *  reported) — lets the UI indicator track the real mode, not an optimistic one. */
  permissionMode: PermissionMode | null;
  /** The focused run is genuinely driving: the agent has streamed or reported
   *  started. Distinct from `active.runId`, which only means the hub accepted
   *  the open and may still be followed by a `yielded` refusal. */
  runConfirmed: boolean;
  /** Focused run's context budget, straight from the CLI. Null until it reports
   *  (or on a runtime too old to answer). */
  contextUsage: ContextUsageInfo | null;
  /** What the focused session has cost so far (USD), from the runtime's own
   *  `result` accounting. Null until a turn ends or on a runtime that does not
   *  report it. */
  sessionCost: number | null;
  /** Focused run's live model / reasoning settings as the agent reports them.
   *  Null until reported. Absent `model`/`effort` inside = no explicit pick, the
   *  account default is running — which `activeModel` names. */
  runSettings: RunSettingsInfo | null;
  /** Ask the focused run to compact its context now. */
  compact: () => void;
  error: string | null;
  /** Bumped each time the HUB refuses something (a refused resume, a yielded
   *  run) — not a general toast channel. See the note on the state itself. */
  refusal: number;
  /** Text that was typed but provably never delivered (the run had ended),
   *  WITH the session it belongs to. The composer puts it back, then calls
   *  `clearRecovered`.
   *
   *  Carries its owner because it is one slot for the whole app and the refusal
   *  can land after you have walked away: send in A, open B, and B's composer
   *  used to be handed A's message — in a session where sending it is wrong. */
  recoveredText: { machineId: string; sessionId: string; text: string } | null;
  clearRecovered: () => void;
  /** Returns whether the frame left the browser. A `true` is NOT acceptance —
   *  the hub can still refuse (session live in an editor, machine reconnecting,
   *  run already attached) with an async `error`, so callers holding user text
   *  must wait for the run to actually attach before discarding it. */
  open: (
    machineId: string,
    sessionId: string,
    message?: string,
    images?: ImageInput[],
    files?: FileInput[],
    /** Model / effort picked in the composer before continuing. */
    startup?: Pick<StartSettings, 'model' | 'effort'>,
  ) => boolean;
  /** Start a brand-new session in `cwd`; the agent mints the real id (session_started). */
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
  takeover: (
    machineId: string,
    sessionId: string,
    message?: string,
    images?: ImageInput[],
    files?: FileInput[],
  ) => boolean;
  focusSession: (machineId: string, sessionId: string) => void;
  sendInput: (text: string, images?: ImageInput[], files?: FileInput[]) => boolean;
  /** POST an audio blob to the hub's /transcribe proxy; resolves to the text. */
  transcribe: (blob: Blob, project?: string, opts?: TranscribeOptions) => Promise<string>;
  /** POST recognised text to the hub's /polish; resolves to the cleaned text,
   *  or null when there is none to offer (off, slow, failed) — the caller then
   *  keeps what whisper wrote. Never throws. See polish.ts. */
  polish: (req: PolishRequest) => Promise<PolishResult>;
  /** Raise the app's own transient toast. For failures a panel discovers on its
   *  own (dictation refused, a mic with no permission) — without it those end in
   *  `console.warn`, which nobody on a phone is reading. */
  notifyError: (message: string) => void;
  interrupt: () => void;
  closeRun: () => void;
  decideTool: (allow: boolean, updatedInput?: Record<string, unknown>, permissionMode?: PermissionMode) => void;
  rescan: (machineId: string) => void;
  /** Set (or clear, when stage is undefined) a session's kanban stage. */
  setStage: (machineId: string, sessionId: string, stage?: string) => void;
  /** End a session outright — clean close of a driven run, or SIGTERM of an
   *  editor-held writer. Used by the Flow board's "confirm Done". */
  endSession: (machineId: string, sessionId: string) => void;
  /** `quiet` suppresses the "connection lost" toast — pass it for reads the app
   *  issues on its own (transcript, model list), never for an action a person
   *  took and is waiting on. */
  rpc: <T = unknown>(
    machineId: string,
    method: RpcMethod,
    params: Record<string, unknown>,
    quiet?: boolean,
  ) => Promise<T>;
  /** LLM annotation of one assistant turn (the hub proxies to its gateway).
   *  Resolves null when the hub has no gateway configured — callers keep
   *  their heuristic layer and this hook stops asking for the connection. */
  enrich: (
    machineId: string,
    sessionId: string,
    source: 'claude' | 'codex' | undefined,
    uuid: string,
    text: string,
    userText?: string,
    digest?: string,
  ) => Promise<Enrichment | null>;
  /** Everything the hub remembers for the signed-in user. Metadata only. */
  memoryList: () => Promise<MemoryEntry[]>;
  /** One memory's body, addressed by the identity the list handed out. */
  memoryRead: (scope: MemoryScope, scopeKey: string, path: string) => Promise<string>;
  /** Tombstone a memory. Agents retire their local copy on the next catalog. */
  memoryDelete: (scope: MemoryScope, scopeKey: string, path: string) => Promise<void>;
  openMirror: (
    machineId: string,
    sessionId: string,
    cwd: string,
    onData: MirrorSink,
    onExit?: () => void,
  ) => Promise<MirrorHandle>;
  /** Returns whether the frame left the browser — a pick that never went out
   *  must not be shown as the session's setting. */
  setModel: (runId: string, model?: string) => boolean;
  /** Returns whether the frame left the browser. See `setModel`. */
  /** `machineId`: the machine the view shows - how a mode switch finds a keyed machine (sealing). */
  setPermissionMode: (runId: string, mode: PermissionMode, machineId?: string) => boolean;
  /** Set reasoning effort live; pass `ultracode` for the xhigh+orchestration flag. */
  /** Returns whether the frame left the browser. See `setModel`. */
  setEffort: (runId: string, effort?: EffortLevel, ultracode?: boolean) => boolean;
  runFor: (machineId: string, sessionId: string) => ActiveRunInfo | undefined;
  markRead: () => void;
  clearNotifications: () => void;
  /** Sessions now on screen (`sessionKey`s): their bell entries have been
   *  seen, so they leave (`pruneInbox`). */
  dismissOnScreen: (keys: ReadonlySet<string>) => void;
  /** Tell the hub these sessions are on screen right now, so their «finished»
   *  marks clear on the person's other devices too (`session_read`). Sent only
   *  after a session has stayed in a focused window for a few seconds since
   *  the last change. */
  markSessionsRead: (keys: ReadonlySet<string>) => void;
  /** Read marks the hub holds for this person: `machine::session` -> hub ms. */
  reads: ReadonlyMap<string, number>;
  requestNotifyPermission: () => void;
  /** This window's one hub socket, for another session view to share — a pane
   *  of the split calls `useSessionChannel(central.link)` instead of opening a
   *  socket of its own (sessionChannel.ts). */
  link: HubLink;
}

/**
 * Correlation id that also works in NON-secure contexts. `crypto.randomUUID`
 * is gated to secure contexts (https / localhost) — this app is served over
 * plain http to a VPS/LAN IP, where `crypto.randomUUID` is `undefined` and
 * would throw on every rpc() call. These ids are routing tokens, not secrets.
 */
function uuidish(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
  }
  return `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function defaultCentralUrl(): string {
  const env = (import.meta as { env?: Record<string, string> }).env?.['VITE_CENTRAL_URL'];
  if (env) return env;
  // Same-origin: the SPA and the /ui endpoint are always served from one host.
  // `location.host` keeps the port only when it is non-default, so this is
  // `wss://code.acme.test` behind nginx on 443 and `ws://localhost:4319` when
  // the hub serves the build directly in dev. Never hardcode a port here — the
  // old `:4319` fallback broke prod, which is proxied on 443. Vite dev (:5173)
  // must still set VITE_CENTRAL_URL (the env branch above wins there).
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

/** How long a session stays in front of the person before it counts as read. */
const READ_DWELL_MS = 3_000;

/** The window is on screen AND is the one the person is using. */
function inFront(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function useCentral(
  token: string,
  opts?: {
    notifications?: boolean;
    workspaceId?: string;
    /** `false` holds the socket shut — the shell passes it while it does not
     *  know which workspace to open yet. Absent = connect. */
    enabled?: boolean;
    /** Whose device cache this socket may read and fill — the signed-in user,
     *  once `/api/me` has confirmed who that is. Absent = no cache (a pane's
     *  own socket, or before sign-in). See localCache.ts. */
    cacheOwner?: string;
    /** The socket keeps failing to OPEN. A browser never exposes the status of a
     *  refused WebSocket upgrade, so only the caller can find out whether the hub
     *  is down or refusing us — and act on it. */
    onHandshakeFailing?: () => void;
  },
): CentralState {
  // Column instances (the multi-session grid) run their own /ui socket but must
  // not each fire OS notifications for the same transitions the main hook already
  // reports — pass { notifications: false } to keep them quiet. Held in a ref so
  // ingestActivity (deps: []) always sees the current flag without re-binding.
  const notifyRef = useRef(opts?.notifications !== false);
  notifyRef.current = opts?.notifications !== false;
  const [status, setStatus] = useState<CentralState['status']>('connecting');
  const [machines, setMachines] = useState<MachineSnapshot[]>([]);
  const [teamMachines, setTeamMachines] = useState<TeamMachine[]>([]);
  // Private machines (docs/E2EE.md): which machine a run / terminal belongs to,
  // for sealing what is sent to it. The snapshot is the truth for «private».
  /** run -> machine, learned ONLY from what this browser itself asked for (its
   *  own open / new_session, answered by `opened` with the same machine). A hub
   *  that says a run lives elsewhere does not get to move it. */
  const runMachine = useRef(new Map<string, string>());
  /** ref -> machine this browser named in an open / new_session / takeover that
   *  has not been answered yet. */
  const pendingOpen = useRef(new Map<string, string>());
  /** requestId -> machine of an rpc this browser sent; mirrorId -> machine of a mirror it opened.
   *  Envelopes are bound to the machine, and these say which one this browser
   *  attributes an answer to. */
  const rpcMachine = useRef(new Map<string, string>());
  const mirrorMachine = useRef(new Map<string, string>());
  const termMachine = useRef(new Map<string, string>());
  /** Sealing is asynchronous. While any send is still being sealed, every
   *  later send queues behind it, so the order a person acted in survives. */
  const sealChain = useRef<Promise<void>>(Promise.resolve());
  const sealing = useRef(0);
  /** Incoming frames are opened in arrival order for the same reason. */
  const openChain = useRef<Promise<void>>(Promise.resolve());
  const opening = useRef(0);
  // The first snapshot has landed. Until then a route that names an unknown
  // session means «still loading», not «missing» — and the flag is sticky
  // across reconnects on purpose: stale-but-real data beats a false
  // «не найдено» flash while the socket is re-handshaking.
  const [hydrated, setHydrated] = useState(false);
  // Scripted runs are hidden from every list by default. One choke point, not a
  // filter per screen: the counts, the project drill, the recent cards and the
  // palette all have to agree, or the history says 91 and shows 3.
  const [showAutomated, setShowAutomatedState] = useState(
    () => storageGet('cc-show-automated') === '1',
  );
  const setShowAutomated = useCallback((v: boolean) => {
    storageSet('cc-show-automated', v ? '1' : '0');
    setShowAutomatedState(v);
  }, []);
  // Closing a session is the kanban stage `done`, set from the session itself
  // (see `setStage`). It has to actually REMOVE the session from the lists or
  // the button changes nothing a person can see — «done» already existed as a
  // Flow column and that is precisely why it was never used. Same shape as the
  // automated filter above, down to the count: a filter that hides work without
  // saying how much is the one that gets mistrusted.
  const [showClosed, setShowClosedState] = useState(
    () => storageGet('cc-show-closed') === '1',
  );
  const setShowClosed = useCallback((v: boolean) => {
    storageSet('cc-show-closed', v ? '1' : '0');
    setShowClosedState(v);
  }, []);
  const hide = useCallback(
    (s: SessionSummary) =>
      (!showAutomated && isAutomatedSession(s)) || (!showClosed && s.stage === 'done'),
    [showAutomated, showClosed],
  );
  // Resolve a session the URL names from the UNFILTERED list. Filters shape
  // lists; a URL is explicit intent — a deep link (or a notification click) to
  // a closed or automated session must still open it, not silently fall back
  // to the StartScreen because `visibleMachines` hid it.
  const findSession = useCallback(
    (machineId: string, sessionId: string) =>
      machines
        .find((m) => m.machine.machineId === machineId)
        ?.sessions.find((s) => s.sessionId === sessionId),
    [machines],
  );
  const visibleMachines = useMemo(() => {
    if (showAutomated && showClosed) return machines;
    return machines.map((m) => {
      const sessions = m.sessions.filter((s) => !hide(s));
      return sessions.length === m.sessions.length ? m : { ...m, sessions };
    });
  }, [machines, showAutomated, showClosed, hide]);
  const automatedHidden = useMemo(
    () =>
      showAutomated
        ? 0
        : machines.reduce((n, m) => n + m.sessions.filter(isAutomatedSession).length, 0),
    [machines, showAutomated],
  );
  // Counted on its own terms: a closed session that is ALSO automated is
  // already held back by the other filter, so counting it here would promise a
  // reveal that showing closed sessions does not deliver.
  const closedHidden = useMemo(
    () =>
      showClosed
        ? 0
        : machines.reduce(
            (n, m) =>
              n + m.sessions.filter((s) => s.stage === 'done' && (showAutomated || !isAutomatedSession(s))).length,
            0,
          ),
    [machines, showClosed, showAutomated],
  );
  const [viewer, setViewer] = useState<ViewerContext | null>(null);
  // Read inside `ingestActivity`, which is a stable useCallback — a plain
  // `viewer` there would close over the value from first render (null) and
  // silence notifications for good.
  const viewerIdRef = useRef<string | null>(null);
  viewerIdRef.current = viewer?.userId ?? null;
  const [usage, setUsage] = useState<Record<string, UsageInfo>>({});
  const [codexUsage, setCodexUsage] = useState<Record<string, UsageInfo>>({});
  const [profiles, setProfiles] = useState<Record<string, BuilderProfile>>({});
  const [machineStats, setMachineStats] = useState<Record<string, MachineStats>>({});
  /** How many mounted screens are showing hardware right now (`watchStats`). */
  const statsWatchers = useRef(0);
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeStatus>>({});
  const [committed, setCommitted] = useState<Record<string, boolean>>({});
  const [activeRuns, setActiveRuns] = useState<ActiveRunInfo[]>([]);
  const listedRuns = useMemo(() => {
    if (showAutomated && showClosed) return activeRuns;
    const held = new Set<string>();
    for (const m of machines) {
      for (const s of m.sessions) if (hide(s)) held.add(sessionKey(m.machine.machineId, s.sessionId));
    }
    if (held.size === 0) return activeRuns;
    return activeRuns.filter((r) => (r.state === 'working' || r.state === 'needs_attention') || !held.has(sessionKey(r.machineId, r.sessionId)));
  }, [activeRuns, machines, showAutomated, showClosed, hide]);
  const [notifications, setNotifications] = useState<NotifItem[]>([]);
  /** The inbox as of the last merge — read by `ingestActivity`, a stable
   *  callback, which must not compute the badge inside a state updater. */
  const inboxRef = useRef<NotifItem[]>([]);
  const readsRef = useRef<ReadonlyMap<string, number>>(new Map());
  const [reads, setReads] = useState<ReadonlyMap<string, number>>(readsRef.current);
  /** Entries up to this id have been looked at. The badge counts the entries
   *  still in the bell above it — not a running total — so an entry that
   *  resolves itself takes its unit off the badge with it. */
  const [readMark, setReadMark] = useState(0);
  /** Entries another window of this app has looked at (`BellSync` «seen»):
   *  matched by session + hub time, since this page's ids are its own. */
  const [seenElsewhere, setSeenElsewhere] = useState<BellStamp[]>([]);
  const unread = useMemo(
    () =>
      notifications.filter((n) => n.id > readMark && !seenElsewhere.some((s) => stampCovers(s, n))).length,
    [notifications, readMark, seenElsewhere],
  );
  /** The other windows and tabs of this app on this device (`BellSync`). */
  const bellPeers = useRef<BroadcastChannel | null>(null);
  /** Entries another window cleared. Kept, not just applied: the channel and
   *  the hub socket share no order, so a throttled background window can get
   *  the «clear» before the activity frame that raises the entry. */
  const clearedElsewhere = useRef<BellStamp[]>([]);
  const tellPeers = useCallback((kind: BellSync['kind'], items: NotifItem[]) => {
    if (!items.length) return;
    try {
      bellPeers.current?.postMessage({ kind, stamps: items.map(bellStamp) } satisfies BellSync);
    } catch {
      // A closed channel or a browser without it: the bell stays per window.
    }
  }, []);
  /** The app's transient toast — hub refusals, a lost connection, a failed
   *  dictation. Window-wide: a pane's refusal is still shown here. */
  const [error, setError] = useState<string | null>(null);
  const [resumeEpoch, setResumeEpoch] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  /** Has this page ever had an open socket? Separates "still starting" from
   *  "lost the connection" — see the note in `send`. */
  const everOpenRef = useRef(false);
  const idRef = useRef(0);

  const pendingRpc = useRef(new PendingRegistry<unknown, RpcMethod>());
  // Memory reads answer the hub's own store, not a machine, so they get their
  // own registries rather than riding the machine-RPC lane.
  // A reasoning model over a whole-turn digest, possibly queued behind another
  // pane's request on the hub: seconds to tens of seconds, never the RPC's 30.
  const pendingEnrich = useRef(new PendingRegistry<Enrichment | null, null>(120_000));
  // Latched on the first "enrichment not configured": a hub without a gateway
  // answers that forever, and re-asking per turn would be request spam.
  const enrichUnavailable = useRef(false);
  const pendingMemoryList = useRef(new PendingRegistry<MemoryEntry[], null>());
  const pendingMemoryRead = useRef(new PendingRegistry<string, null>());
  const pendingMemoryDelete = useRef(new PendingRegistry<void, null>());
  // Opens are correlated by a browser-allocated id (not FIFO), so concurrent
  // mirror opens never bind a response to the wrong subscriber. Each
  // pending entry also carries a timeout + is rejected if the socket drops.
  const mirrorOpens = useRef(new PendingRegistry<MirrorHandle, MirrorHandle>());
  const mirrorSubs = useRef(new Map<string, MirrorSubs>());

  // Attention diffing: last-seen state per runId, to emit notifications only on
  // genuine transitions. `seeded` prevents a notification storm on first load.
  const prevRunState = useRef(new Map<string, AttentionState>());
  const seeded = useRef(false);

  const nextId = () => ++idRef.current;
  // One timer for the transient error toast: a new error replaces the old one
  // instead of letting a stale timer clear a fresher message early.
  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whether the toast currently on screen is the connection one — the only
   *  kind a successful reconnect is allowed to retract. */
  const connErrRef = useRef(false);
  const flashError = useCallback((message: string, ms = 6000) => {
    setError(message);
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setError(null), ms);
  }, []);

  /**
   * Returns whether the message actually left the browser. Callers that set
   * optimistic state (open/takeover/sendInput) must check this — silently
   * dropping a user action while disconnected left a permanent "working…".
   * `quiet` suppresses the toast for automatic senders (pollers, cleanup)
   * that would otherwise spam it every tick while disconnected.
   */
  /**
   * Whether a content frame must be sealed, and for which machine. The key
   * ring decides, not the hub: a hub that says "not private" must not make a
   * browser that holds this machine's key type into it in the clear. The hub's
   * flag only says a machine needs a key this browser lacks.
   *  - `{machineId}`: seal (key held) or refuse with the pairing hint (hub says
   *    private, no key);
   *  - `'unresolved'`: a content frame that could not be placed on any machine
   *    while the ring holds keys - fail closed, send nothing;
   *  - undefined: send as is.
   */
  const privateTarget = (
    msg: BrowserToCentral,
    machineHint?: string,
  ): { machineId: string } | 'unresolved' | 'conflict' | undefined => {
    if (!needsSeal(msg)) return undefined;
    const m = msg as unknown as Record<string, unknown>;
    // Every machine this frame could be for. What the hub says may only ADD a
    // reason to seal, never take one away: if ANY candidate is a machine whose
    // key this browser holds, the frame is sealed for it.
    const candidates = new Set<string>();
    const add = (id: unknown) => {
      if (typeof id === 'string' && id) candidates.add(id);
    };
    add(m['machineId']);
    if (typeof m['runId'] === 'string') {
      add(runMachine.current.get(m['runId']));
      add(machineHint);
      add(activeRunsRef.current.find((r) => r.runId === m['runId'])?.machineId);
    }
    if (typeof m['termId'] === 'string') add(termMachine.current.get(m['termId']));
    const keyed = [...candidates].filter((id) => hasKeyFor(id));
    if (keyed.length > 1) return 'conflict';
    if (keyed.length === 1) return { machineId: keyed[0]! };
    const flagged = [...candidates].find(
      (id) => machinesRef.current.find((x) => x.machine.machineId === id)?.machine.private === true,
    );
    if (flagged) return { machineId: flagged };
    // No candidate says "private". With no candidate at all, only a frame that
    // really carries the person's words is held back (a mode switch or a bare
    // approval of an ordinary machine goes through).
    if (candidates.size === 0 && hasAnyKey() && hasRealContent(msg)) return 'unresolved';
    return undefined;
  };

  /** The machine this browser attributes an incoming frame to - from its own
   *  bookkeeping of what it asked for, not from a field the hub chose. */
  const machineOfFrame = (f: Record<string, unknown>): string | undefined => {
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    switch (f['type']) {
      case 'rpc_response':
        return rpcMachine.current.get(str(f['requestId']) ?? '');
      case 'mirror_data':
        return mirrorMachine.current.get(str(f['mirrorId']) ?? '');
      case 'term_data':
        return termMachine.current.get(str(f['termId']) ?? '');
      default: {
        const runId = str(f['runId']);
        if (!runId) return undefined;
        return runMachine.current.get(runId) ?? activeRunsRef.current.find((r) => r.runId === runId)?.machineId;
      }
    }
  };

  /** True for a content frame in the CLEAR about a run of a machine whose key is
   *  in the ring (see the call site). */
  const clearContentForKeyedRun = (msg: CentralToBrowser): boolean => {
    const m = msg as unknown as Record<string, unknown>;
    if (msg.type === 'rpc_response') {
      // Attributed by our own request, not by anything the hub says.
      const machine = rpcMachine.current.get(msg.requestId);
      if (!machine || !hasKeyFor(machine)) return false;
      return clearRpcContent(pendingRpc.current.context(msg.requestId) ?? '', m);
    }
    const runId = typeof m['runId'] === 'string' ? m['runId'] : undefined;
    if (!runId) return false;
    const machine = runMachine.current.get(runId) ?? activeRunsRef.current.find((r) => r.runId === runId)?.machineId;
    if (!machine || !hasKeyFor(machine)) return false;
    switch (msg.type) {
      case 'stream': {
        const ev = (m['event'] ?? {}) as Record<string, unknown>;
        return !ev['e2e'] && (Boolean(ev['text']) || ev['raw'] !== undefined || ev['data'] !== undefined);
      }
      case 'tool_request':
        // The agent seals EVERY tool_request of a keyed machine (`input` is
        // always present, so the seal always fires). One without an envelope is
        // the hub's own: even an empty one, or the person would approve a
        // «Bash» card with nothing in it and the sealed decision, bound to this
        // requestId, would run a command nobody saw.
        return !m['e2e'];
      case 'user_turn':
        return (
          !m['e2e'] &&
          (Boolean(m['text']) || Boolean(m['images']) || (Array.isArray(m['files']) && m['files'].length > 0))
        );
      default:
        return false;
    }
  };

  /** A forged clear answer must not leave its caller waiting for the timeout. */
  const refuseForgedRpc = (msg: CentralToBrowser) => {
    if (msg.type !== 'rpc_response') return;
    pendingRpc.current.reject(msg.requestId, new Error('Ответ машины пришёл незашифрованным — он отброшен.'));
  };

  /** A frame `send` had accepted (returned true) never left: say so, and tell
   *  the composer so it gives the text back (`cc-send-failed`). */
  const sendFailed = (msg: BrowserToCentral, why: string) => {
    flashError(why);
    try {
      window.dispatchEvent(new CustomEvent('cc-send-failed', { detail: { type: msg.type } }));
    } catch {
      /* no window (tests) */
    }
  };

  const send = useCallback(
    (msg: BrowserToCentral, quiet = false, machineHint?: string): boolean => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (msg.type === 'term_open') termMachine.current.set(msg.termId, msg.machineId);
        if (msg.type === 'rpc_request') {
          if (rpcMachine.current.size > 5000) rpcMachine.current.clear();
          rpcMachine.current.set(msg.requestId, msg.machineId);
        }
        if (msg.type === 'mirror_open') mirrorMachine.current.set(msg.mirrorId, msg.machineId);
        if ((msg.type === 'open' || msg.type === 'new_session' || msg.type === 'takeover') && msg.ref) {
          pendingOpen.current.set(msg.ref, msg.machineId);
        }
        const found = privateTarget(msg, machineHint);
        if (found === 'unresolved' || found === 'conflict') {
          if (!quiet) {
            flashError(
              found === 'conflict'
                ? 'Хаб указал две зашифрованные машины для одного сообщения — оно не отправлено.'
                : 'Не удалось определить машину для зашифрованной отправки — сообщение не отправлено.',
            );
          }
          return false;
        }
        const target = found?.machineId;
        if (target !== undefined) {
          // A private machine takes content only sealed. No key here: say so
          // and send nothing (the hub would refuse plaintext anyway).
          if (!hasKeyFor(target)) {
            if (!quiet) {
              flashError('Эта машина зашифрована — введите код пары, чтобы работать в ней.');
              requestPairDialog({ machineId: target });
            }
            return false;
          }
          sealing.current += 1;
          sealChain.current = sealChain.current
            .then(async () => {
              try {
                const sealed = await sealFrame(
                  msg,
                  target,
                  e2eeKeys,
                  machinesRef.current.find((x) => x.machine.machineId === target)?.machine.e2eEpoch,
                );
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(sealed));
                else sendFailed(msg, 'Связь с хабом потеряна — сообщение не отправлено.');
              } catch {
                sendFailed(msg, 'Не удалось зашифровать сообщение — оно не отправлено.');
              }
            })
            .finally(() => {
              sealing.current -= 1;
            });
          return true;
        }
        if (sealing.current > 0) {
          // Behind a message still being sealed: keep the order.
          sealChain.current = sealChain.current.then(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
            else sendFailed(msg, 'Связь с хабом потеряна — сообщение не отправлено.');
          });
          return true;
        }
        ws.send(JSON.stringify(msg));
        return true;
      }
      // Before the socket has EVER opened we are not disconnected, we are
      // starting up — and on a cold PWA launch that is four sequential network
      // steps (bundle, /api/me, WS handshake + snapshot, then the history RPC).
      // Anything that fires on mount during that window used to raise a red
      // toast on a screen that was about to work perfectly; `useFiles.ts` has a
      // comment saying exactly that about exactly this. A real drop — the
      // socket was open and went away — still says so.
      if (!quiet && everOpenRef.current) {
        connErrRef.current = true;
        flashError('Связь с хабом потеряна — восстанавливаем; повторите через мгновение.');
      }
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flashError],
  );

  const watchStats = useCallback(() => {
    statsWatchers.current += 1;
    if (statsWatchers.current === 1) send({ type: 'stats_interest', on: true }, true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      statsWatchers.current -= 1;
      if (statsWatchers.current === 0) send({ type: 'stats_interest', on: false }, true);
    };
  }, [send]);

  // ---- the views sharing this socket ------------------------------------------
  //
  // The shell's own session view and every session pane of the split are
  // `ChannelPort`s on THIS one socket (sessionChannel.ts). The fleet, RPC and
  // mirrors stay here, once.
  const ports = useRef(new Map<string, ChannelPort>());
  /** Which views follow which run on the current socket — so closing one pane
   *  does not unsubscribe the socket from a run another pane still shows. */
  const holders = useRef(new Map<string, Set<string>>());
  /** The view that last sent something, for a refusal from a hub too old to
   *  name the view it answers (`ref`). */
  const lastSender = useRef<string | null>(null);
  const activeRunsRef = useRef<ActiveRunInfo[]>([]);
  activeRunsRef.current = activeRuns;

  // Reconcile a fresh active-run list: the board, the inbox, then each view.
  const ingestActivity = useCallback((rawRuns: ActiveRunInfo[]) => {
    const result = reconcileActivity({
      rawRuns,
      active: null,
      attachedRunId: null,
      previousStates: prevRunState.current,
      seeded: seeded.current,
      notify: notifyRef.current,
      viewerId: viewerIdRef.current,
      now: Date.now(),
      nextId,
    });
    activeRunsRef.current = result.runs;
    setActiveRuns(result.runs);
    prevRunState.current = result.nextStates;
    seeded.current = true;
    for (const port of ports.current.values()) port.activity(rawRuns);
    // A run some view on screen is following does not ring: that view shows it.
    const followed = new Set([...ports.current.values()].map((p) => p.runId()).filter(Boolean));
    const fresh = result.notifications.filter((n) => !followed.has(n.runId));
    // One entry per session (see `mergeInbox`), and every entry whose cause
    // is gone leaves — answered on any device, moved on, or on screen now
    // (`pruneInbox`). The same run list decides both, so a question answered
    // on the phone clears the desktop's bell on the very next frame.
    const merged = fresh.length ? mergeInbox(inboxRef.current, fresh).items : inboxRef.current;
    const pruned = dropStamped(
      pruneInbox(merged, result.runs, (n) => followed.has(n.runId)),
      clearedElsewhere.current,
    );
    if (pruned !== inboxRef.current) {
      inboxRef.current = pruned;
      setNotifications(pruned);
    }
    if (fresh.length) announce(fresh);
  }, []);

  const link = useMemo<HubLink>(
    () => ({
      send: (msg, quiet, machineHint) => {
        const ref = (msg as { ref?: string }).ref;
        if (ref) lastSender.current = ref;
        return send(msg, quiet, machineHint);
      },
      register: (port) => {
        ports.current.set(port.id, port);
        // A view that arrives on an already-open socket has missed nothing it
        // could have used, but it may follow a run that is live right now.
        if (activeRunsRef.current.length) port.activity(activeRunsRef.current);
        return () => {
          ports.current.delete(port.id);
        };
      },
      hold: (runId, viewId) => {
        let set = holders.current.get(runId);
        if (!set) holders.current.set(runId, (set = new Set()));
        set.add(viewId);
      },
      release: (runId, viewId) => {
        const set = holders.current.get(runId);
        set?.delete(viewId);
        if (set && set.size) return;
        holders.current.delete(runId);
        // Quiet: leaving a session is the shell following the URL, and a
        // socket mid-reconnect forgets the subscription on its own.
        send({ type: 'unsubscribe', runId }, true);
      },
      activeRuns: () => activeRunsRef.current,
      flashError: (m, ms) => flashError(m, ms),
    }),
    [send, flashError],
  );

  // The shell's own session view — the one route `/w/s/…` shows.
  const main = useSessionChannel(link);

  // Held in a ref on purpose: the socket effect below must NOT list this in its
  // dependencies — a caller passing an inline function would reconnect the hub
  // socket on every render.
  const onHandshakeFailing = useRef(opts?.onHandshakeFailing);
  onHandshakeFailing.current = opts?.onHandshakeFailing;

  /** What a snapshot carries per machine besides its sessions — usage, runtime
   *  status, profile, telemetry — merged into the maps (a machine that has not
   *  re-reported keeps its last-known figures). Shared by the live snapshot
   *  and the one read back from this device's cache. */
  const foldExtras = useCallback((list: MachineSnapshot[]) => {
    // Fold any usage carried on the snapshot into the map (merge, so a
    // machine that hasn't re-reported yet keeps its last-known figures).
    setUsage((prev) => {
      const next = { ...prev };
      for (const m of list) if (m.usage) next[m.machine.machineId] = m.usage;
      return next;
    });
    setCodexUsage((prev) => {
      const next = { ...prev };
      for (const m of list) if (m.codexUsage) next[m.machine.machineId] = m.codexUsage;
      return next;
    });
    setRuntimes((prev) => {
      const next = { ...prev };
      for (const m of list) if (m.runtimes) next[m.machine.machineId] = m.runtimes;
      return next;
    });
    // Same fold for builder profiles carried on the snapshot.
    setProfiles((prev) => {
      const next = { ...prev };
      for (const m of list) if (m.profile) next[m.machine.machineId] = m.profile;
      return next;
    });
    setMachineStats((prev) => {
      const next = { ...prev };
      for (const m of list) if (m.stats) next[m.machine.machineId] = m.stats;
      return next;
    });
  }, []);

  /** The team machines' first samples (stats, runtimes) ride the snapshot; the
   *  live ones arrive as `machine_stats` / `runtime_status` for the same ids. */
  const foldTeam = useCallback((list: TeamMachine[] | undefined) => {
    if (!list?.length) return;
    setRuntimes((prev) => {
      const next = { ...prev };
      for (const t of list) if (t.runtimes) next[t.machine.machineId] = t.runtimes;
      return next;
    });
    setMachineStats((prev) => {
      const next = { ...prev };
      for (const t of list) if (t.stats) next[t.machine.machineId] = t.stats;
      return next;
    });
  }, []);

  // `hydrated` is sticky across RECONNECTS, never across workspaces: a snapshot
  // of the personal workspace says nothing about what the organization holds,
  // and treating it as loaded is what let «Эта машина недоступна в текущем
  // воркспейсе» flash while the right socket was still on its way.
  const hydratedFor = useRef<string | undefined>(opts?.workspaceId);
  /** `hydrated`, readable from a promise callback that outlives the render. */
  const liveRef = useRef(false);
  liveRef.current = hydrated;
  const enabled = opts?.enabled !== false;

  // ---- the fleet as this device last saw it ---------------------------------
  //
  // Drawn before the socket has said anything, so the session list, a pane's
  // session and its title exist on the first frames of a reload. Display-only:
  // it never sets `hydrated` — a cached «online» is not the machine saying so —
  // and the live snapshot replaces it wholesale the moment it lands.
  const cacheOwner = opts?.cacheOwner;
  useEffect(() => {
    const ws = opts?.workspaceId;
    if (!cacheOwner || !ws) return;
    let alive = true;
    void LocalCache.snapshot(cacheOwner, ws).then((snap) => {
      if (!alive || !snap || liveRef.current) return;
      setMachines(snap.machines);
      foldExtras(snap.machines);
    });
    return () => {
      alive = false;
    };
  }, [cacheOwner, opts?.workspaceId, foldExtras]);
  // …and written back from the live one, at most every few seconds: `machines`
  // moves on every inventory delta, and a write per delta would be a write per
  // second on a busy fleet.
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const ws = opts?.workspaceId;
    if (!cacheOwner || !ws || !hydrated || saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (hydratedFor.current === ws) // A private machine's decrypted titles are not parked in the local cache.
      LocalCache.saveSnapshot(cacheOwner, ws, machinesRef.current.filter((m) => m.machine.private !== true));
    }, 3_000);
  }, [machines, hydrated, cacheOwner, opts?.workspaceId]);
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  useEffect(() => {
    if (hydratedFor.current !== opts?.workspaceId) {
      hydratedFor.current = opts?.workspaceId;
      liveRef.current = false;
      setHydrated(false);
      setTeamMachines([]);
    }
    if (!enabled) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Did THIS socket ever reach `onopen`, and how many in a row have not.
    let opened = false;
    let handshakeFails = 0;

    const connect = () => {
      if (stopped) return;
      const query = new URLSearchParams();
      if (token) query.set('token', token);
      if (opts?.workspaceId) query.set('workspaceId', opts.workspaceId);
      const url = `${defaultCentralUrl()}/ui?${query.toString()}`;
      setStatus('connecting');
      seeded.current = false;
      prevRunState.current = new Map();
      ws = new WebSocket(url);
      wsRef.current = ws;
      opened = false;

      ws.onopen = () => {
        retry = 0;
        opened = true;
        handshakeFails = 0;
        everOpenRef.current = true;
        // The banner says «восстанавливаем». This is the moment it was — so it
        // stops saying so, rather than sitting out its six seconds over a
        // working app. Only OUR banner: an error about something else is still
        // the freshest thing the person was told.
        if (connErrRef.current) {
          connErrRef.current = false;
          if (errTimer.current) clearTimeout(errTimer.current);
          setError(null);
        }
        setStatus('open');
        // Identify as the web client so the hub tags runs we open with origin=web
        // (the board splits App vs Web on this). First frame, before any `open`;
        // re-sent on every reconnect because the hub drops the kind on disconnect.
        // `caps` asks the hub for per-machine session deltas instead of a whole
        // snapshot every time any machine moves. Opt-in on purpose: a build that
        // did not ask keeps getting snapshots, so the hub can ship ahead of the
        // clients. Handled by `machine_sessions` below.
        try {
          ws?.send(
            JSON.stringify({
              type: 'hello',
              client: 'web',
              caps: ['sessionDelta', 'sessionPatch', CAP_STATS_ON_DEMAND],
            }),
          );
          // The hub forgets the interest with the old socket: say it again if a
          // screen is still showing hardware.
          if (statsWatchers.current > 0) ws?.send(JSON.stringify({ type: 'stats_interest', on: true }));
        } catch {
          /* ignore */
        }
        // A hush belongs to ONE socket. If the link dropped while we were away
        // and reconnected here, the hub knows nothing about it and would start
        // fanning snapshots at a page that still is not draining them — so say
        // it again while the page is still hidden.
        if (document.hidden) hush();
        // Every view re-attaches to the run it follows, unconditionally: a hub
        // that RESTARTED has no memory of who was watching what, and a
        // reconnected socket is a new subscriber either way. Each view also
        // drops its gapped streaming tail here (see `keepUnansweredTail`).
        holders.current.clear();
        for (const port of ports.current.values()) port.socketOpened();
      };
      ws.onclose = () => {
        wsRef.current = null;
        holders.current.clear();
        // The hub dropped its side of the gate with the connection.
        paused = false;
        setStatus('closed');
        if (!opened) {
          handshakeFails += 1;
          // One failed upgrade is a hub restarting — it happens several times on
          // a busy deploy day and the reconnect banner is the right answer. Two
          // in a row is worth asking about: a session the hub no longer accepts
          // fails here forever, and this loop used to be the only thing that
          // happened next, leaving an empty screen that read as a hung hub.
          if (handshakeFails >= 2) onHandshakeFailing.current?.();
        }
        scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
      ws.onmessage = (ev) => {
        let msg: CentralToBrowser;
        try {
          msg = decodeCentralToBrowser(ev.data as string);
        } catch {
          return;
        }
        // A machine whose key this browser holds speaks to it only sealed. Clear
        // assistant text, tool prompts or user turns for such a run are the hub's
        // own invention (it cannot read the real ones): dropped, never shown.
        if (clearContentForKeyedRun(msg)) {
          console.warn(`[e2ee] dropped a clear ${msg.type} frame for a machine this browser holds the key of`);
          refuseForgedRpc(msg);
          return;
        }
        // Private machine: envelopes are opened here, once, so everything
        // downstream sees the frames it always saw. Opening is asynchronous, so
        // while any frame is being opened the rest queue behind it - order is
        // the transcript.
        // A tool prompt always takes the queue: until the key ring has loaded
        // from IndexedDB `hasKeyFor` says false, so the clear-content check
        // above cannot be trusted for it yet (see the re-check below).
        if (
          opening.current > 0 ||
          mayCarryE2e(ev.data as string) ||
          msg.type === 'tool_request' ||
          msg.type === 'rpc_response'
        ) {
          opening.current += 1;
          const frame = msg;
          openChain.current = openChain.current
            .then(async () => {
              // Only a failure to OPEN falls back to the envelope; a throwing
              // handler must not apply the same frame a second time.
              let out = frame;
              try {
                await ringReady();
                out = await openFrame(frame, e2eeKeys, machineOfFrame);
              } catch {
                /* keep the envelope: the UI shows the placeholder */
              }
              // Now the ring is loaded: the check that ran on arrival may have
              // seen no key yet. Same rule, decided with the keys in hand.
              if (clearContentForKeyedRun(frame)) {
                console.warn(`[e2ee] dropped a clear ${frame.type} frame for a machine this browser holds the key of`);
                refuseForgedRpc(frame);
                return;
              }
              // A tool prompt is the one frame a placeholder must never stand
              // in for: a card whose envelope did not open (damaged, wrong key)
              // would still take an «Allow» for the real, unseen request.
              if (out.type === 'tool_request' && (out as unknown as Record<string, unknown>)['e2e']) {
                console.warn('[e2ee] dropped a tool_request whose envelope did not open');
                flashError('Агент спросил разрешение, но запрос не расшифровался — проверьте код пары этой машины.');
                return;
              }
              handle(out);
            })
            .catch((e) => console.error('[central] frame handler failed', e))
            .finally(() => {
              opening.current -= 1;
            });
          return;
        }
        handle(msg);
      };
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      // Each view keeps the run it follows — the hub owns the run lifecycle
      // and this socket is only a replaceable subscriber — but stops showing
      // it as busy and freezes its streaming tail.
      for (const port of ports.current.values()) port.socketClosed();
      // Fail every in-flight request whose reply can never arrive now, so
      // callers see a rejection instead of hanging until their own timeout —
      // and tell established mirror panes they are dead, not quiet.
      const closed = new Error('соединение закрыто');
      pendingRpc.current.rejectAll(closed);
      pendingEnrich.current.rejectAll(closed);
      pendingMemoryList.current.rejectAll(closed);
      pendingMemoryRead.current.rejectAll(closed);
      pendingMemoryDelete.current.rejectAll(closed);
      mirrorOpens.current.rejectAll(closed);
      for (const [, s] of mirrorSubs.current) s.onExit?.();
      mirrorSubs.current.clear();
      const delay = Math.min(10_000, 1000 * 2 ** retry);
      retry += 1;
      timer = setTimeout(connect, delay);
    };

    function handle(msg: CentralToBrowser) {
      if ((msg.type === 'opened' || msg.type === 'session_started') && (paused || resyncing)) lateLive = true;
      switch (msg.type) {
        case 'snapshot':
          setMachines(cleanSnapshot(msg.machines));
          setTeamMachines(mergeTeamMachines(msg.teamMachines, msg.machines));
          foldTeam(msg.teamMachines);
          liveRef.current = true;
          setHydrated(true);
          if (msg.viewer) setViewer(msg.viewer);
          foldExtras(msg.machines);
          if (msg.activeRuns) ingestActivity(msg.activeRuns);
          if (resyncing) {
            resyncing = false;
            if (lateLive) {
              lateLive = false;
              setResumeEpoch((n) => n + 1);
              for (const port of ports.current.values()) port.woke();
            }
          }
          break;
        case 'machine_sessions': {
          // One machine's list, in place of a whole-fleet snapshot. Title
          // sanitising has to happen here too, or a delta would undo what
          // `cleanSnapshot` did on the way in.
          const [fresh] = cleanSnapshot([msg.machine]);
          if (!fresh) break;
          // The entry carries the machine's usage / profile / stats / runtimes
          // too (an agent registering sends it instead of a snapshot): fold
          // them into the maps the screens prefer over the entry.
          foldExtras([fresh]);
          setMachines((prev) => {
            const at = prev.findIndex(
              (m) => m.machine.machineId === fresh.machine.machineId,
            );
            if (at < 0) return [...prev, fresh];
            const next = [...prev];
            next[at] = fresh;
            return next;
          });
          break;
        }
        case 'session_updates': {
          // Only the sessions that changed. Upsert WHOLE entries — never merge
          // field by field, or an optional the agent stopped reporting (a
          // `livePid` that just died) would survive and keep offering a
          // take-over against a process that is gone.
          const fresh = cleanSessions(msg.sessions);
          const dropped = new Set(msg.removed ?? []);
          setMachines((prev) =>
            prev.map((m) => {
              if (m.machine.machineId !== msg.machineId) return m;
              const by = new Map(m.sessions.map((s) => [s.sessionId, s]));
              for (const id of dropped) by.delete(id);
              for (const s of fresh) by.set(s.sessionId, s);
              // The hub's ordering does not survive a patch, and several screens
              // read this list newest-first before sorting their own view.
              const sessions = [...by.values()].sort(
                (a, b) => b.lastModified - a.lastModified,
              );
              return { ...m, sessions };
            }),
          );
          break;
        }
        case 'activity':
          ingestActivity(msg.runs);
          break;
        case 'session_completions':
          // The web's «готово» is the bell, raised live from `activity`; the
          // durable list is for clients that keep unread dots (iOS).
          break;
        case 'session_reads': {
          readsRef.current = mergeReads(readsRef.current, msg.reads);
          setReads(readsRef.current);
          const pruned = dropReadNotifications(inboxRef.current, readsRef.current);
          if (pruned !== inboxRef.current) {
            inboxRef.current = pruned;
            setNotifications(pruned);
          }
          break;
        }
        case 'usage':
          setUsage((prev) => ({ ...prev, [msg.machineId]: msg.usage }));
          break;
        case 'codex_usage':
          setCodexUsage((prev) => ({ ...prev, [msg.machineId]: msg.usage }));
          break;
        case 'machine_stats':
          setMachineStats((prev) => ({ ...prev, [msg.machineId]: msg.stats }));
          break;
        case 'runtime_status':
          setRuntimes((prev) => ({ ...prev, [msg.machineId]: msg.runtimes }));
          break;
        case 'session_stage':
          setMachines((prev) =>
            prev.map((m) =>
              m.machine.machineId !== msg.machineId
                ? m
                : {
                    ...m,
                    sessions: m.sessions.map((s) =>
                      s.sessionId === msg.sessionId ? { ...s, stage: msg.stage } : s,
                    ),
                  },
            ),
          );
          break;
        case 'session_committed':
          setCommitted((prev) => ({ ...prev, [`${msg.machineId}::${msg.sessionId}`]: true }));
          break;
        case 'builder_profile':
          setProfiles((prev) => ({ ...prev, [msg.machineId]: msg.profile }));
          break;
        case 'opened': {
          // The answer to an open this browser made must name the machine it
          // asked for; one that names another is the hub's doing and is dropped.
          // `ref` names the column, not the request: a subscribe's ack and a
          // fresh open's can cross. A mismatch only matters (and is only
          // dropped) when a keyed machine is involved; the entry stays for the
          // answer that does match.
          const asked = msg.ref ? pendingOpen.current.get(msg.ref) : undefined;
          if (asked !== undefined && asked !== msg.machineId) {
            if (hasKeyFor(asked) || hasKeyFor(msg.machineId)) {
              console.warn(`[e2ee] dropped an 'opened' for ${msg.machineId}: this browser asked for ${asked}`);
              flashError('Хаб ответил за другую машину — ответ отброшен.');
              break;
            }
          } else if (msg.ref) pendingOpen.current.delete(msg.ref);
          const known = runMachine.current.get(msg.runId);
          if (known !== undefined && known !== msg.machineId) break;
          if (asked === msg.machineId) runMachine.current.set(msg.runId, msg.machineId);
          // The ack of an open or a subscribe. With a `ref` it answers one
          // view; without (a hub that predates it) every view checks whether
          // it is the one looking at that session. Nobody claiming it means a
          // late ack for a session already left — stop streaming it at us.
          let claimed = false;
          for (const port of ports.current.values()) {
            if (msg.ref && msg.ref !== port.id) continue;
            if (port.frame(msg)) claimed = true;
          }
          if (!claimed && !holders.current.get(msg.runId)?.size) {
            send({ type: 'unsubscribe', runId: msg.runId }, true);
          }
          break;
        }
        case 'session_started':
        case 'stream':
        case 'tool_request':
        case 'tool_resolved':
        case 'user_turn':
        case 'context_usage':
        case 'run_settings':
        case 'run_mode':
        case 'run_status':
          // Each view keeps what is about the run IT follows (sessionChannel).
          for (const port of ports.current.values()) port.frame(msg);
          break;
        case 'enrich_result':
          if (msg.ok) pendingEnrich.current.resolve(msg.requestId, msg.enrichment ?? null);
          else if (msg.error === 'enrichment not configured') {
            enrichUnavailable.current = true;
            pendingEnrich.current.resolve(msg.requestId, null);
          } else pendingEnrich.current.reject(msg.requestId, new Error(msg.error ?? 'enrich failed'));
          break;
        case 'memory_list_result':
          if (msg.ok) pendingMemoryList.current.resolve(msg.requestId, msg.memories ?? []);
          else pendingMemoryList.current.reject(msg.requestId, new Error(msg.error ?? 'не удалось получить список памяти'));
          break;
        case 'memory_read_result':
          if (msg.ok) pendingMemoryRead.current.resolve(msg.requestId, msg.content ?? '');
          else pendingMemoryRead.current.reject(msg.requestId, new Error(msg.error ?? 'не удалось прочитать заметку'));
          break;
        case 'memory_delete_result':
          if (msg.ok) pendingMemoryDelete.current.resolve(msg.requestId, undefined);
          else pendingMemoryDelete.current.reject(msg.requestId, new Error(msg.error ?? 'не удалось удалить заметку'));
          break;
        case 'rpc_response': {
          const method = pendingRpc.current.context(msg.requestId);
          if (!method) break;
          if (!msg.ok) {
            pendingRpc.current.reject(msg.requestId, new Error(msg.error ?? 'запрос к машине не удался'));
            break;
          }
          try {
            pendingRpc.current.resolve(msg.requestId, RpcResultSchemas[method].parse(msg.result));
          } catch (error) {
            pendingRpc.current.reject(
              msg.requestId,
              new Error(`машина ответила на ${method} в непонятном виде: ${(error as Error).message}`),
            );
          }
          break;
        }
        case 'mirror_opened': {
          const handle = mirrorOpens.current.context(msg.mirrorId);
          if (handle) mirrorOpens.current.resolve(msg.mirrorId, handle);
          break;
        }
        case 'mirror_data':
          mirrorSubs.current.get(msg.mirrorId)?.sink(msg.replace, msg.messages);
          break;
        case 'mirror_exit': {
          const s = mirrorSubs.current.get(msg.mirrorId);
          mirrorSubs.current.delete(msg.mirrorId);
          s?.onExit?.();
          break;
        }
        case 'error': {
          // A refusal is an answer to one view: the one that asked (`ref`),
          // or — from a hub too old to say — the one that last sent anything.
          const to =
            (msg.ref && ports.current.get(msg.ref)) ||
            (lastSender.current && ports.current.get(lastSender.current)) ||
            ports.current.get(main.id);
          if (to) to.frame(msg);
          else flashError(msg.message);
          break;
        }
      }
    }

    // ---- backgrounded tab: hush the hub, and come back without the backoff --
    //
    // The hub fans a FULL snapshot at every UI socket several times a minute
    // (one per agent inventory), and on a real fleet that frame is hundreds of
    // KB. A phone freezes this page the moment you leave it, so those frames
    // pile up in the hub's outbound channel until it hits OUT_CHANNEL_CAP and
    // deliberately drops us as a slow peer (`send_raw` in server-rs/src/hub.rs)
    // — which is what "the hub disconnects every time I switch apps" actually
    // was. The protocol has carried the fix since the iOS client hit the same
    // wall (CentralClient's scenePhase hooks): `pause` stops hub->socket
    // traffic, `resume` lifts it and is answered with one fresh snapshot.
    //
    // Only where the page really does get frozen. A hidden DESKTOP tab keeps
    // running, and hushing it would silence the OS notifications that are the
    // entire reason for leaving it open in the background.
    //
    // Inside the native shell that reasoning inverts, and the inversion is the
    // root fix for the batches. The shell's window does not CLOSE, it hides
    // (`CloseRequested` in windows/src-tauri/src/main.rs), so this page can sit
    // hidden for hours with its socket open while WebView2 freezes it — and the
    // hub keeps queueing full run lists at it, up to OUT_CHANNEL_CAP. Every one
    // of those frames is reconciled on the way out of the freeze, replaying the
    // entire missed history one interruption at a time. Nothing was lost by
    // staying connected either, because the shell's own socket never paused and
    // its tray has been notifying the whole time. So: hush, and let `resume`
    // answer with one fresh snapshot instead of a queue.
    const freezes = () =>
      NATIVE_SHELL ||
      (typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(max-width: 720px), (pointer: coarse)').matches);
    let paused = false;
    // Was anything STREAMING into us when we went quiet — a followed run, or a
    // mirror tailing a transcript? If not, the fresh snapshot on resume is the
    // whole catch-up and no pane needs to re-read.
    let pausedLive = false;
    // Between `resume` and its snapshot. The hub sends in order, so anything
    // handled before that snapshot arrived while we were paused.
    let resyncing = false;
    // An `opened` / `session_started` reached us paused: its view's turn
    // streamed into the void, and nothing at wake time knew it had a run.
    let lateLive = false;

    // `frozen` = the browser told us outright that this page is about to stop
    // running, which is reason enough to hush on any platform. Otherwise we go
    // by the media query above.
    const hush = (frozen = false) => {
      const s = wsRef.current;
      if (paused || (!frozen && !freezes()) || !s || s.readyState !== WebSocket.OPEN) return;
      paused = true;
      pausedLive = [...ports.current.values()].some((p) => !!p.runId()) || mirrorSubs.current.size > 0;
      try {
        // `acks`: keep the answers to our own requests coming (hub
        // `passes_pause`) — a session started just before the window hid
        // must still learn its run and its name.
        s.send(JSON.stringify({ type: 'pause', acks: true }));
      } catch {
        /* the socket died first — the resume path reconnects */
      }
    };

    const wake = () => {
      // Re-seed, always — whether or not we hushed.
      //
      // `seeded` and `prevRunState` were reset only in `connect()`, so a page
      // coming back from a freeze diffed the first frame it saw against a map
      // that could be hours old, and announced every run that had moved in the
      // meantime, all at once, while `document.hidden` was still true. That is
      // the same batch by a second route, and it needs the same answer the
      // phone already gives (`CentralClient.swift` resets its seed on every
      // reconnect): what changed while you were away is the inbox's business,
      // not an interruption's.
      seeded.current = false;
      prevRunState.current = new Map();
      if (!paused) {
        // Never hushed (desktop), but the socket can still have died while we
        // were away. Reconnect NOW rather than sitting out the backoff.
        if (!wsRef.current && !stopped) {
          clearTimeout(timer);
          retry = 0;
          connect();
        }
        return;
      }
      paused = false;
      const s = wsRef.current;
      if (s && s.readyState === WebSocket.OPEN) {
        s.send(JSON.stringify({ type: 'resume' }));
        // Frames queued during a freeze are handled only now, after this
        // wake: a view PLACED on a run while we were quiet (the hub lets
        // `opened` / `session_started` through our pause) is caught up when the
        // resume's snapshot lands — see `lateLive`.
        resyncing = true;
        // Frames were DROPPED, not queued, so a run we were following streamed
        // into a void. Take the gapped tail off screen and let the transcript
        // panes re-read the file — the same trade `ws.onopen` makes.
        if (pausedLive) setResumeEpoch((n) => n + 1);
        // And every view asks for its run again: `subscribe` is idempotent,
        // and it is the only thing that makes the hub replay a tool approval
        // raised while the phone was asleep. Without it the prompt was simply
        // gone — the run sat in needs_attention, the modal never appeared, and
        // an hour later the agent denied it for us.
        if (pausedLive) for (const port of ports.current.values()) port.woke();
      } else if (!stopped) {
        clearTimeout(timer);
        retry = 0;
        connect();
      }
      pausedLive = false;
    };

    const onVisibility = () => (document.hidden ? hush() : wake());
    const onFreeze = () => hush(true);
    const onWake = () => wake();
    document.addEventListener('visibilitychange', onVisibility);
    // Chrome's page-lifecycle pair. `freeze` is the only honest signal that the
    // tab is about to stop draining its socket; Safari never sends it, which is
    // why `visibilitychange` above carries the phone case.
    window.addEventListener('freeze', onFreeze);
    window.addEventListener('resume', onWake);
    // Waking from bfcache does not always fire visibilitychange.
    window.addEventListener('pageshow', onWake);

    connect();
    // Keep the /ui socket warm. Once agents stop flapping the hub broadcasts
    // far less, so an idle browser link would otherwise get reaped by a NAT /
    // load-balancer on the path (same idle-timeout that flapped the agents).
    // A raw ping every 25s resets those timers; the hub ignores unknown types.
    // A hushed socket still gets these: the gate is on hub->client traffic, and
    // the path in between still has to be kept from being reaped.
    const keepalive = setInterval(() => {
      const s = wsRef.current;
      if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'ping' }));
    }, 25_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(keepalive);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('freeze', onFreeze);
      window.removeEventListener('resume', onWake);
      window.removeEventListener('pageshow', onWake);
      if (ws) {
        holders.current.clear();
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
    };
  }, [token, opts?.workspaceId, enabled, ingestActivity]);

  const transcribe = useCallback(
    async (blob: Blob, project?: string, extra?: TranscribeOptions): Promise<string> => {
      // Same-origin as /ui: swap the ws(s):// scheme for http(s)://.
      const base = defaultCentralUrl().replace(/^ws/, 'http');
      const q = new URLSearchParams();
      if (token) q.set('token', token);
      // The project label lets the hub build a recognition prompt.
      const label = transcribeProject(project);
      if (label) q.set('project', label);
      // Clip length (how long the hub may wait for the GPU before racing a cloud
      // engine) and session vocabulary for the recognition prompt.
      if (extra?.durSec !== undefined && Number.isFinite(extra.durSec) && extra.durSec > 0) q.set('dur', extra.durSec.toFixed(1));
      if (extra?.hints) q.set('hints', extra.hints);
      const qs = q.toString();
      const suffix = qs ? `?${qs}` : '';
      const res = await fetch(`${base}/transcribe${suffix}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (!res.ok) throw new Error(`не удалось распознать запись (${res.status})`);
      // Extra fields (`engine`, …) are ignored on purpose.
      const data = (await res.json()) as { text?: string };
      return typeof data.text === 'string' ? data.text : '';
    },
    [token],
  );

  /** The hub said it has no polisher (503) — stop paying a round trip per
   *  recording until the page reloads. */
  const polishOffRef = useRef(false);
  const polish = useCallback(
    async (req: PolishRequest): Promise<PolishResult> => {
      if (polishOffRef.current) return { kind: 'off' };
      if (!req.text.trim()) return { kind: 'ok', text: req.text };
      const body = PolishRequest.safeParse(req);
      if (!body.success) return { kind: 'failed' };
      const base = defaultCentralUrl().replace(/^ws/, 'http');
      const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
      // The raw text is already in hand: a rewrite that takes longer than this
      // costs more than it gives. Measured 1–3s on the fast model.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), POLISH_DEADLINE_MS);
      try {
        const res = await fetch(`${base}/polish${suffix}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body.data),
          signal: ctl.signal,
        });
        if (res.status === 503) {
          polishOffRef.current = true;
          return { kind: 'off' };
        }
        if (!res.ok) return { kind: 'failed' };
        const data = PolishResponse.safeParse(await res.json());
        // polished:false = the hub handed the text back untouched = failure;
        // polished:true with the same text is «nothing to fix» (the caller compares).
        return data.success && data.data.polished && data.data.text.trim()
          ? { kind: 'ok', text: data.data.text }
          : { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      } finally {
        clearTimeout(timer);
      }
    },
    [token],
  );

  // quiet: the cooperative-takeover poller calls this every 2.5s — a closed
  // socket must not turn that into a toast storm.
  const rescan = useCallback((machineId: string) => send({ type: 'rescan', machineId }, true), [send]);

  const setStage = useCallback(
    (machineId: string, sessionId: string, stage?: string) => {
      send({ type: 'set_stage', machineId, sessionId, stage });
      // Optimistic: move the card immediately; the session_stage delta confirms.
      setMachines((prev) =>
        prev.map((m) =>
          m.machine.machineId !== machineId
            ? m
            : {
                ...m,
                sessions: m.sessions.map((s) =>
                  s.sessionId === sessionId ? { ...s, stage } : s,
                ),
              },
        ),
      );
      // A stage change resolves the "ready to close" nudge for this card.
      setCommitted((prev) => {
        const key = `${machineId}::${sessionId}`;
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [send],
  );

  const endSession = useCallback(
    (machineId: string, sessionId: string) => send({ type: 'end_session', machineId, sessionId }),
    [send],
  );

  const enrich = useCallback(
    (
      machineId: string,
      sessionId: string,
      source: 'claude' | 'codex' | undefined,
      uuid: string,
      text: string,
      userText?: string,
      digest?: string,
    ): Promise<Enrichment | null> => {
      if (enrichUnavailable.current) return Promise.resolve(null);
      // Suggestions would send the conversation to a model: never from a
      // private machine (docs/E2EE.md).
      // The decrypted text is on THIS screen only: a machine whose key this
      // browser holds counts as private here even if the hub says otherwise.
      if (
        hasKeyFor(machineId) ||
        machinesRef.current.find((m) => m.machine.machineId === machineId)?.machine.private === true
      ) {
        return Promise.resolve(null);
      }
      const requestId = uuidish();
      const pending = pendingEnrich.current.wait(requestId, null, 'enrich timeout');
      if (
        !send({
          type: 'enrich_request',
          requestId,
          machineId,
          sessionId,
          ...(source ? { source } : {}),
          uuid,
          text,
          ...(userText ? { userText } : {}),
          ...(digest ? { digest } : {}),
        }, true)
      ) {
        pendingEnrich.current.reject(requestId, new Error(NO_HUB));
      }
      return pending;
    },
    [send],
  );

  const memoryList = useCallback((): Promise<MemoryEntry[]> => {
    const requestId = uuidish();
    const pending = pendingMemoryList.current.wait(requestId, null, 'память не ответила вовремя');
    if (!send({ type: 'memory_list', requestId })) {
      pendingMemoryList.current.reject(requestId, new Error(NO_HUB));
    }
    return pending;
  }, [send]);

  const memoryRead = useCallback(
    (scope: MemoryScope, scopeKey: string, path: string): Promise<string> => {
      const requestId = uuidish();
      const pending = pendingMemoryRead.current.wait(requestId, null, 'заметка не пришла вовремя');
      if (!send({ type: 'memory_read', requestId, scope, scopeKey, path })) {
        pendingMemoryRead.current.reject(requestId, new Error(NO_HUB));
      }
      return pending;
    },
    [send],
  );

  const memoryDelete = useCallback(
    (scope: MemoryScope, scopeKey: string, path: string): Promise<void> => {
      const requestId = uuidish();
      const pending = pendingMemoryDelete.current.wait(requestId, null, 'удаление не подтвердилось вовремя');
      if (!send({ type: 'memory_delete', requestId, scope, scopeKey, path })) {
        pendingMemoryDelete.current.reject(requestId, new Error(NO_HUB));
      }
      return pending;
    },
    [send],
  );

  /**
   * `quiet` is for calls the APP makes on its own — reading a transcript when a
   * session opens, asking a machine for its model list. Those fire on mount and
   * on every reconnect, which is exactly when the socket may be a beat behind:
   * the read fails, the caller retries a moment later, and nobody needed to be
   * told. Without it the person watching a session gets a red banner about a
   * connection problem they do not have, for an action they did not take.
   */
  const rpc = useCallback(
    <T,>(machineId: string, method: RpcMethod, params: Record<string, unknown>, quiet = false): Promise<T> => {
      const requestId = uuidish();
      const validatedMethod = RpcMethodSchema.parse(method);
      const pending = pendingRpc.current.wait(requestId, validatedMethod, RPC_TIMEOUT) as Promise<T>;
      if (!send({ type: 'rpc_request', requestId, machineId, method: validatedMethod, params }, quiet)) {
        pendingRpc.current.reject(requestId, new Error(NO_HUB));
      }
      return pending;
    },
    [send],
  );

  const openMirror = useCallback(
    (
      machineId: string,
      sessionId: string,
      cwd: string,
      onData: MirrorSink,
      onExit?: () => void,
    ): Promise<MirrorHandle> => {
      const mirrorId = uuidish();
      mirrorSubs.current.set(mirrorId, { sink: onData, onExit });
      const handle: MirrorHandle = {
        close: () => {
          mirrorSubs.current.delete(mirrorId);
          send({ type: 'mirror_close', mirrorId }, true); // cleanup path — never toast
        },
      };
      const pending = mirrorOpens.current.wait(
        mirrorId,
        handle,
        'живой просмотр не открылся вовремя',
        () => mirrorSubs.current.delete(mirrorId),
      );
      // A keyed / private machine's folder is content: the agent finds it from
      // the session id in its own inventory, so none goes to the hub.
      const hideCwd =
        hasKeyFor(machineId) || machinesRef.current.find((x) => x.machine.machineId === machineId)?.machine.private === true;
      if (!send({ type: 'mirror_open', machineId, mirrorId, sessionId, cwd: hideCwd ? '' : cwd })) {
        mirrorOpens.current.reject(mirrorId, new Error(NO_HUB));
      }
      return pending;
    },
    [send],
  );

  // Empty string = back to the account default, which `set_model` expresses by
  // omitting the field (the SDK's own `setModel(undefined)`). Sending `''` would
  // instead ask the CLI for a model literally named "".
  const setModel = useCallback(
    (runId: string, model?: string) =>
      send({ type: 'set_model', runId, ...(model ? { model } : {}) }),
    [send],
  );
  const setPermissionMode = useCallback(
    (runId: string, mode: PermissionMode, machineId?: string) =>
      send({ type: 'set_permission_mode', runId, mode }, false, machineId),
    [send],
  );
  const setEffort = useCallback(
    (runId: string, effort?: EffortLevel, ultracode?: boolean) =>
      send({ type: 'set_effort', runId, effort, ultracode }),
    [send],
  );

  const runFor = useCallback(
    (machineId: string, sessionId: string) =>
      activeRuns.find((r) => r.machineId === machineId && r.sessionId === sessionId),
    [activeRuns],
  );
  const markRead = useCallback(() => {
    setReadMark(inboxRef.current.reduce((max, n) => Math.max(max, n.id), 0));
    // App also calls this by itself while the panel stays open and news
    // lands — in a window behind others too. That one has not been looked at.
    if (inFront()) tellPeers('seen', inboxRef.current);
  }, [tellPeers]);
  const clearNotifications = useCallback(() => {
    tellPeers('clear', inboxRef.current);
    inboxRef.current = [];
    setNotifications([]);
  }, [tellPeers]);
  const dismissOnScreen = useCallback(
    (keys: ReadonlySet<string>) => {
      if (!keys.size || !inboxRef.current.length) return;
      const before = inboxRef.current;
      const pruned = pruneInbox(before, activeRunsRef.current, (n) =>
        keys.has(sessionKey(n.machineId, n.sessionId)),
      );
      if (pruned === before) return;
      inboxRef.current = pruned;
      setNotifications(pruned);
      // Only a window the person is actually in speaks for the others: one
      // left open behind them with the same session restored has not shown it.
      if (inFront()) tellPeers('clear', before.filter((n) => !pruned.includes(n)));
    },
    [tellPeers],
  );
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let ch: BroadcastChannel;
    try {
      ch = new BroadcastChannel('hegai-bell');
    } catch {
      return;
    }
    bellPeers.current = ch;
    ch.onmessage = (e: MessageEvent) => {
      const msg = parseBellSync(e.data);
      if (!msg || !msg.stamps.length) return;
      if (msg.kind === 'clear') {
        clearedElsewhere.current = mergeStamps(clearedElsewhere.current, msg.stamps);
        const pruned = dropStamped(inboxRef.current, msg.stamps);
        if (pruned !== inboxRef.current) {
          inboxRef.current = pruned;
          setNotifications(pruned);
        }
        return;
      }
      setSeenElsewhere((prev) => mergeStamps(prev, msg.stamps));
    };
    return () => {
      bellPeers.current = null;
      ch.close();
    };
  }, []);
  const readTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** What App last said is on screen. A timer re-checks it when it fires: a
   *  session that left the screen in the meantime was not looked at. */
  const readOnScreen = useRef<ReadonlySet<string>>(new Set());
  /** A read mark clears the «finished» dot on the person's OTHER devices, so a
   *  wrong one loses an answer they have not seen (20.10.2026: a desktop window
   *  left open behind others, or waking with four columns restored, cleared the
   *  phone's green dots). So a mark needs the window in front AND focused —
   *  `visibilityState` alone stays «visible» for a window behind others — and
   *  the session kept there for `READ_DWELL_MS` after the last change: every
   *  call starts the count over, so a result that lands mid-count gets its own
   *  three seconds. The mark goes the moment the count completes; that spacing
   *  is also the throttle (the hub rebroadcasts anything ≥ 2 s apart). */
  const markSessionsRead = useCallback(
    (keys: ReadonlySet<string>) => {
      readOnScreen.current = keys;
      for (const t of readTimers.current.values()) clearTimeout(t);
      readTimers.current.clear();
      if (!inFront()) return;
      for (const key of keys) {
        const sep = key.indexOf('::');
        if (sep < 0) continue;
        const machineId = key.slice(0, sep);
        const sessionId = key.slice(sep + 2);
        if (!sessionId) continue;
        readTimers.current.set(
          key,
          setTimeout(() => {
            readTimers.current.delete(key);
            if (!readOnScreen.current.has(key) || !inFront()) return;
            send({ type: 'session_read', machineId, sessionId }, true);
          }, READ_DWELL_MS),
        );
      }
    },
    [send],
  );
  // A mark sent while the socket was down is lost: announce what is on screen
  // again on every successful (re)connection — and when the window comes back
  // to the front, since nothing is marked while it is not.
  useEffect(() => {
    if (status === 'open') markSessionsRead(readOnScreen.current);
  }, [status, markSessionsRead]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const again = () => markSessionsRead(readOnScreen.current);
    // Focus moving into an iframe of the page (the cloud browser's screen)
    // blurs the window too; a tick later `hasFocus()` says it never left.
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(again, 0);
    };
    window.addEventListener('focus', again);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', again);
    return () => {
      clearTimeout(blurTimer);
      window.removeEventListener('focus', again);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', again);
    };
  }, [markSessionsRead]);
  useEffect(
    () => () => {
      for (const t of readTimers.current.values()) clearTimeout(t);
      readTimers.current.clear();
    },
    [],
  );
  const requestNotifyPermission = useCallback(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, []);

  return {
    status,
    resumeEpoch,
    machines: visibleMachines,
    teamMachines,
    hydrated,
    findSession,
    automatedHidden,
    showAutomated,
    setShowAutomated,
    closedHidden,
    showClosed,
    setShowClosed,
    viewer,
    usage,
    codexUsage,
    profiles,
    machineStats,
    watchStats,
    runtimes,
    committed,
    activeRuns,
    listedRuns,
    notifications,
    unread,
    reads,
    markSessionsRead,
    // The shell's own session view; a pane of the split brings its own
    // (`useSessionChannel(central.link)`) and overlays these.
    ...main,
    link,
    error,
    notifyError: flashError,
    transcribe,
    polish,
    rescan,
    setStage,
    endSession,
    rpc,
    enrich,
    memoryList,
    memoryRead,
    memoryDelete,
    openMirror,
    setModel,
    setPermissionMode,
    setEffort,
    runFor,
    markRead,
    clearNotifications,
    dismissOnScreen,
    requestNotifyPermission,
  };
}
