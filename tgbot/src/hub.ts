/**
 * The hub's `/ui` socket, as a client.
 *
 * This is the same endpoint the web SPA and the iOS app speak; nothing here is
 * Telegram-specific, and nothing here changes the protocol. Three contracts
 * from `shared/src/web-protocol.ts` are copied faithfully because getting them
 * wrong shows up as a UI that is quietly stale rather than as an error:
 *
 *  - `hello.caps` must announce `sessionDelta`/`sessionPatch`, or the hub falls
 *    back to re-sending the WHOLE fleet snapshot on every session-list move.
 *  - `session_updates` entries REPLACE a session wholesale (an absent `livePid`
 *    means the process died — field-merging would resurrect it), `removed` are
 *    deletes, and the list is re-sorted newest-first by the client.
 *  - Subscriptions do not survive a reconnect. The hub releases nothing on a
 *    socket drop, so the client must re-`subscribe` to keep seeing a live run.
 */
import { WebSocket } from 'ws';
import {
  RpcResultSchemas,
  decodeCentralToBrowser,
  type ActiveRunInfo,
  type BrowserToCentral,
  type CentralToBrowser,
  type MachineSnapshot,
  type RpcMethod,
  type SessionSummary,
  type ViewerContext,
} from '@cc-remote/shared';

type Frame<T extends CentralToBrowser['type']> = Extract<CentralToBrowser, { type: T }>;

export type StreamFrame = Frame<'stream'>;
export type ToolRequestFrame = Frame<'tool_request'>;
export type RunStatusFrame = Frame<'run_status'>;
export type OpenedFrame = Frame<'opened'>;
export type SessionStartedFrame = Frame<'session_started'>;
export type EnrichFrame = Frame<'enrich_result'>;

export interface HubHandlers {
  onReady(viewer: ViewerContext | undefined): void;
  onStream(frame: StreamFrame): void;
  onToolRequest(frame: ToolRequestFrame): void;
  onRunStatus(frame: RunStatusFrame): void;
  onOpened(frame: OpenedFrame): void;
  onSessionStarted(frame: SessionStartedFrame): void;
  onActivity(runs: ActiveRunInfo[]): void;
  onEnrich(frame: EnrichFrame): void;
  onHubError(message: string): void;
  /** The hub refused the credential. The caller re-mints and reconnects. */
  onUnauthorized(): void;
}

const PING_MS = 25_000;
/** Marks a subscribe the CLIENT sent on its own (after a reconnect) rather
 *  than one a person asked for. The hub copies it onto its reply, so a refusal
 *  of it is a log line, not a message in somebody's chat. */
export const AUTO_REF = 'tg-resub:';
/** A run the hub LISTS but still refuses (access withdrawn) is not retried
 *  forever on every activity frame. */
const RESUB_TRIES = 3;
const RPC_TIMEOUT_MS = 45_000;

export class HubClient {
  private ws: WebSocket | undefined;
  private ping: NodeJS.Timeout | undefined;
  private backoff = 1000;
  private closing = false;
  private readonly pending = new Map<
    string,
    { method: RpcMethod; resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  /** Runs whose stream we want, across reconnects. */
  private readonly subscriptions = new Set<string>();
  /**
   * Of those, the ones THIS socket is subscribed to.
   *
   * They used to be re-sent blindly the moment the socket opened. After a hub
   * restart — every deploy, a dozen a day — the bot is back within a second
   * and the agents are not: the hub has no such run yet, answers «Run not
   * found (already closed?)», and that sentence landed in the chat after every
   * deploy. Worse, the subscription was then simply gone, so when the agent
   * re-registered a few seconds later and the run came back, nobody was
   * listening to it. Now a run is subscribed when the hub actually lists it
   * (`sync`), whichever frame that is.
   */
  private readonly attached = new Set<string>();
  private readonly refused = new Map<string, number>();
  /** Causes of dropped frames already logged (see `onMessage`), and how many
   *  frames went that way in total. */
  private readonly undecodable = new Set<string>();
  private dropped = 0;
  private rpcSeq = 0;

  readonly machines = new Map<string, MachineSnapshot>();
  readonly runs = new Map<string, ActiveRunInfo>();
  viewer: ViewerContext | undefined;

  constructor(
    private readonly wsBase: string,
    private session: string,
    private readonly handlers: HubHandlers,
  ) {}

  setSession(session: string): void {
    this.session = session;
  }

  connect(): void {
    if (this.closing) return;
    const ws = new WebSocket(`${this.wsBase}/ui`, {
      headers: { authorization: `Bearer ${this.session}` },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 1000;
      console.log('[hub] connected');
      this.send({ type: 'hello', client: 'app', caps: ['sessionDelta', 'sessionPatch'] });
      // Nothing is re-subscribed here: the snapshot that answers this socket
      // says which of our runs exist right now, and `sync` takes it from there.
      this.attached.clear();
      this.ping = setInterval(() => this.send({ type: 'ping' }), PING_MS);
      this.ping.unref?.();
    });

    ws.on('message', (raw) => this.onMessage(String(raw)));

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        console.warn(`[hub] handshake ${res.statusCode} — session rejected`);
        this.handlers.onUnauthorized();
      } else {
        console.warn(`[hub] handshake ${res.statusCode}`);
      }
    });

    ws.on('error', (err) => console.warn('[hub] socket error:', String(err)));

    ws.on('close', () => {
      this.attached.clear();
      if (this.ping) clearInterval(this.ping);
      this.ping = undefined;
      this.failPending('hub disconnected');
      if (this.closing) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30_000);
      console.warn(`[hub] disconnected; reconnecting in ${Math.round(wait / 1000)}s`);
      setTimeout(() => this.connect(), wait).unref?.();
    });
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
  }

  send(msg: BrowserToCentral): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  subscribe(runId: string): void {
    this.subscriptions.add(runId);
    this.attached.add(runId);
    this.send({ type: 'subscribe', runId });
  }

  unsubscribe(runId: string): void {
    this.subscriptions.delete(runId);
    this.attached.delete(runId);
    this.send({ type: 'unsubscribe', runId });
  }

  /** Subscribe this socket to every run we follow that the hub lists now. */
  private sync(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const runId of this.subscriptions) {
      if (this.attached.has(runId) || !this.runs.has(runId)) continue;
      if ((this.refused.get(runId) ?? 0) >= RESUB_TRIES) continue;
      this.attached.add(runId);
      this.send({ type: 'subscribe', runId, ref: AUTO_REF + runId });
    }
  }

  /** One RPC to a machine, validated against the method's result schema. */
  async rpc<M extends RpcMethod>(
    machineId: string,
    method: M,
    params: Record<string, unknown> = {},
  ): Promise<ReturnType<(typeof RpcResultSchemas)[M]['parse']>> {
    const requestId = `tg-${++this.rpcSeq}-${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timed out`));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ type: 'rpc_request', requestId, machineId, method, params });
    });
  }

  /** Machines the viewer may start work on, most recently active first. */
  startableMachines(): MachineSnapshot[] {
    return [...this.machines.values()]
      .filter((m) => m.online && m.canStart !== false)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  sessionsFor(machineId: string, cwd?: string): SessionSummary[] {
    const sessions = this.machines.get(machineId)?.sessions ?? [];
    return cwd ? sessions.filter((s) => s.cwd === cwd) : sessions;
  }

  session_(machineId: string, sessionId: string): SessionSummary | undefined {
    return this.machines.get(machineId)?.sessions.find((s) => s.sessionId === sessionId);
  }

  runForSession(sessionId: string): ActiveRunInfo | undefined {
    for (const run of this.runs.values()) if (run.sessionId === sessionId) return run;
    return undefined;
  }

  // ---------------------------------------------------------------- internals

  private onMessage(raw: string): void {
    let msg: CentralToBrowser;
    try {
      msg = decodeCentralToBrowser(raw);
    } catch (err) {
      // Not JSON, or not a frame this build understands: drop THIS frame and
      // keep the socket. Said once per cause — a hub newer than the bot would
      // otherwise repeat the line for every stream frame.
      // The key is the frame's `type` plus the first line of the cause with
      // numbers blanked: zod names array indexes and lengths, and keying on
      // the raw message let one odd session burn the cap with twenty
      // «different» causes, after which a real protocol break went unsaid.
      const cause = err instanceof Error ? err.message : String(err);
      const key = `${frameTypeOf(raw)}: ${cause.split('\n')[0]?.replace(/\d+/g, '#').slice(0, 160)}`;
      this.dropped += 1;
      if (this.undecodable.size < 20 && !this.undecodable.has(key)) {
        this.undecodable.add(key);
        console.warn(`[hub] dropped an undecodable frame (${key}): ${cause.slice(0, 300)}`);
      } else if (this.dropped % 100 === 0) {
        console.warn(`[hub] ${this.dropped} undecodable frames dropped so far`);
      }
      return;
    }
    switch (msg.type) {
      case 'snapshot': {
        this.machines.clear();
        // A private machine (docs/E2EE.md) is end-to-end encrypted: the bot
        // holds no key, so it neither lists nor drives it.
        for (const machine of msg.machines) {
          if (!machine.machine.private) this.machines.set(machine.machine.machineId, machine);
        }
        this.runs.clear();
        for (const run of msg.activeRuns ?? []) this.runs.set(run.runId, run);
        this.viewer = msg.viewer;
        this.handlers.onReady(msg.viewer);
        this.sync();
        break;
      }
      case 'machine_sessions':
        if (msg.machine.machine.private) this.machines.delete(msg.machine.machine.machineId);
        else this.machines.set(msg.machine.machine.machineId, msg.machine);
        break;
      case 'session_updates':
        this.applySessionUpdates(msg.machineId, msg.sessions, msg.removed);
        break;
      case 'activity':
        this.runs.clear();
        for (const run of msg.runs) this.runs.set(run.runId, run);
        this.handlers.onActivity(msg.runs);
        this.sync();
        break;
      case 'stream':
        this.handlers.onStream(msg);
        break;
      case 'tool_request':
        this.handlers.onToolRequest(msg);
        break;
      case 'run_status':
        this.handlers.onRunStatus(msg);
        break;
      case 'opened':
        this.subscriptions.add(msg.runId);
        this.attached.add(msg.runId);
        this.refused.delete(msg.runId);
        this.handlers.onOpened(msg);
        break;
      case 'session_started':
        this.handlers.onSessionStarted(msg);
        break;
      case 'rpc_response': {
        const pending = this.pending.get(msg.requestId);
        if (!pending) break;
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (!msg.ok) {
          pending.reject(new Error(msg.error ?? 'rpc failed'));
          break;
        }
        const schema = RpcResultSchemas[pending.method];
        const parsed = schema.safeParse(msg.result);
        if (parsed.success) pending.resolve(parsed.data);
        else pending.reject(new Error(`${pending.method}: unexpected result shape`));
        break;
      }
      case 'enrich_result':
        this.handlers.onEnrich(msg);
        break;
      case 'error':
        // A refused automatic re-subscribe: the run ended while we were away,
        // or is not back yet — `sync` tries again when it is listed. Not news.
        if (msg.ref?.startsWith(AUTO_REF)) {
          const runId = msg.ref.slice(AUTO_REF.length);
          this.attached.delete(runId);
          this.refused.set(runId, (this.refused.get(runId) ?? 0) + 1);
          console.warn(`[hub] re-subscribe to ${runId} refused: ${msg.message}`);
          break;
        }
        this.handlers.onHubError(msg.message);
        break;
      default:
        break;
    }
  }

  /**
   * Replace-then-remove-then-sort. Field-merging an update would resurrect a
   * dead `livePid` and make the session look permanently locked by an editor.
   */
  private applySessionUpdates(
    machineId: string,
    sessions: SessionSummary[],
    removed: string[] | undefined,
  ): void {
    const machine = this.machines.get(machineId);
    if (!machine) return;
    const byId = new Map(machine.sessions.map((s) => [s.sessionId, s]));
    for (const session of sessions) byId.set(session.sessionId, session);
    for (const id of removed ?? []) byId.delete(id);
    machine.sessions = [...byId.values()].sort((a, b) => b.lastModified - a.lastModified);
  }

  private failPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/** The `type` of a frame that did not decode, for the drop log; `?` when
 *  even that is unreadable. */
function frameTypeOf(raw: string): string {
  try {
    const type = (JSON.parse(raw) as { type?: unknown }).type;
    return typeof type === 'string' ? type : '?';
  } catch {
    return '?';
  }
}
