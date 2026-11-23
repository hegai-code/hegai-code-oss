import { CLAUDE_DISABLED_MESSAGE, claudeDisabled } from './runtimes-allowed.js';
import { isBeingRemoved } from './worktree-ops.js';
import { confinePrefix, cwdUnitKey, unitScratchDir } from './confine.js';
import { randomUUID } from 'node:crypto';
import type { ActiveEffortLevel, AgentToCentral, EffortLevel, FileInput, ImageInput, ModelInfoLite, PermissionMode, RunBy, SlashCommandInfo } from '@cc-remote/shared';
import { claudeTranscriptSize } from './history.js';
import { codexRolloutSize } from './codex.js';
import { createRunState, recordRunInput, removeRunState } from './run-state.js';

import {
  ClaudeSessionRun,
  CONTROL_SLOW_NOTICE_MS,
  type RunOptions,
  type SessionRun,
  type ToolApprovalDecision,
  type StreamEvent,
} from './claude-session.js';
import { CodexSessionRun, KILL_GRACE_MS } from './codex-run.js';
import { processStartToken, sameStartToken } from './proc-start.js';
import { TurnGitSignals } from './git-signals.js';
import { AttachmentStore } from './attachments.js';
import {
  findLivePidForSession,
  isPidAlive,
  readLiveSessions,
} from './sessions.js';
import { terminatePid } from './kill-pid.js';
import { policy } from './policy.js';
import { describeWriter } from './orphans.js';

/**
 * How long a tool call waits on a human before the agent gives up and denies.
 *
 * An hour. It was five minutes, which suits someone sitting in front of the
 * session and nobody else: this product is driven from a phone, and a person
 * who put it down for six minutes came back to a model that had been told
 * «Approval timed out» and had carried on without the tool — a refusal nobody
 * made, in a session that then read as having gone wrong on its own. The
 * editor waits as long as it takes; so does this, within reason. A machine
 * that hosts deliberately asynchronous approvals (a backend spec approved
 * hours later) raises it further via `CC_REMOTE_APPROVAL_TIMEOUT_MS`.
 *
 * The value is declared to the hub at register (`approvalTimeoutMs`), which
 * replays a pending prompt to late subscribers only while it is younger than
 * this — so the two sides cannot disagree about whether a card is still live.
 */
const TOOL_APPROVAL_TIMEOUT_MS = envTimeoutMs('CC_REMOTE_APPROVAL_TIMEOUT_MS', 60 * 60_000);

/**
 * Tools whose «approval» is not a permission at all but a QUESTION addressed to
 * the person: the model asking something (`AskUserQuestion`) and a plan offered
 * for acceptance (`ExitPlanMode`). Both travel the same `canUseTool` →
 * `tool_request` path as a permission — which is why auto-approval has to know
 * the difference, or the one channel the model has for talking to a human would
 * answer itself.
 *
 * Measured, not assumed: under `bypassPermissions` the SDK still calls
 * `canUseTool` for `AskUserQuestion` while skipping ordinary permissions
 * (probe of 20.09.2026, memory `ccremote-sdk-signals`). So these two keep
 * reaching the person in every mode, and that is deliberate.
 */
const HUMAN_QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Answer a tool approval without a human, instead of holding the turn until one
 * appears.
 *
 * The floor is `bypassPermissions` now (`defaultPermissionMode`), so in the
 * normal case nothing reaches here at all. This covers the case that bit us on
 * 24.09.2026: a run put into another mode — by a picker, by a remembered
 * client-side pick, by an env on one box — asks, and then a session waits on a
 * card nobody is looking at. It waited 12.5 minutes before it was killed, and
 * the deadline it was actually heading for was twelve hours.
 *
 * `CC_REMOTE_AUTO_APPROVE=0` restores the wait for a machine that wants it.
 */
export function autoApproves(
  tool: string,
  // Chat-only turns every tool call back into a question to a person.
  enabled: boolean = AUTO_APPROVE_TOOLS && !policy().chatOnly,
): boolean {
  return enabled && !HUMAN_QUESTION_TOOLS.has(tool);
}

/**
 * What a hub's answer may carry on a chat-only machine. An `allow` with
 * `updatedInput` REPLACES the tool's input — for a question that is how the
 * answers travel, for `Bash` it would be the hub rewriting the command the
 * person approved. So only the question tools keep it; for every other tool it
 * is dropped and the call runs with the input the card showed. Dropped, not
 * refused: clients echo the input back on a plain «allow» (tgbot does), and
 * that must keep working. Nobody switches the run into bypass from a card.
 */
export function chatOnlyDecision(
  tool: string,
  decision: ToolApprovalDecision,
  chatOnly: boolean = policy().chatOnly,
): ToolApprovalDecision {
  if (!chatOnly || !decision.allow) return decision;
  const { updatedInput, permissionMode, ...rest } = decision;
  return {
    ...rest,
    ...(updatedInput !== undefined && HUMAN_QUESTION_TOOLS.has(tool) ? { updatedInput } : {}),
    ...(permissionMode !== undefined && permissionMode !== 'bypassPermissions' ? { permissionMode } : {}),
  };
}

const AUTO_APPROVE_TOOLS = !['0', 'false'].includes(process.env['CC_REMOTE_AUTO_APPROVE'] ?? '');

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  // A malformed override silently becoming 0 would deny every tool call
  // instantly — the least debuggable failure this file could have.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[agent] ignoring ${name}=${raw} (want a positive number of ms)`);
    return fallback;
  }
  return parsed;
}
/**
 * Refuse to resume a transcript larger than this.
 *
 * One gigabyte — which is to say, practically never. It was 25 MB, on the
 * theory that the CLI ships the whole history before its first token and a
 * huge file therefore hangs. The theory confused the file with the context:
 * the CLI reads the file, but what it SENDS is whatever sits after the last
 * compaction, which is small however large the file has grown. The editor has
 * no such cap and opens 57 MB transcripts every day. Meanwhile the CLI writes
 * every pasted screenshot into the `.jsonl` as base64 — measured at 43% of a
 * 57 MB transcript — so the old cap was reached by ordinary use, and a session
 * past it was dead for good: nothing ever shrinks the file. Five transcripts
 * on one machine were already over it when this changed.
 *
 * What remains is a guard against the pathological (a runaway tool dumping
 * hundreds of megabytes), where the CLI's own memory is the real limit. A
 * refusal carries `code: resume_refused` so the client gives the message and
 * its attachments back instead of losing them with the refusal.
 */
const RESUME_MAX_BYTES = 1024 * 1024 * 1024;

export type RunSource = 'claude' | 'codex';

/**
 * Which CLI a `new_session` that names no source starts (`CC_REMOTE_DEFAULT_SOURCE`).
 *
 * Unset = Claude, as it always was. A community sandbox has no Claude login and
 * the hub pins Codex only for workspace `member`s — the sandbox's owner is an
 * owner there, so without this their first session would fail to start. The
 * env is read once, per machine; the fleet is untouched.
 */
export function defaultSourceFromEnv(
  raw: string | undefined = process.env['CC_REMOTE_DEFAULT_SOURCE'],
): RunSource | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'codex' || value === 'claude') return value;
  console.warn(`[agent] ignoring CC_REMOTE_DEFAULT_SOURCE=${raw} (want 'claude' or 'codex')`);
  return undefined;
}

/** What `closeRun` leaves behind: the promise that says when the runtime
 *  process is confirmed gone. Present only for a runtime that can outlive the
 *  close (`SessionRun.exited`) — which is exactly when the hub must be told
 *  the writer may still be exiting (`closing`). */
interface ClosedRun {
  exited?: Promise<void>;
}

interface RunEntry {
  runId: string;
  /** Hub user who started/resumed this run (fixed for the coder process). */
  startedBy?: RunBy;
  /** Author recorded for the turn most recently handed over: undefined = no
   *  turn yet, null = unknown or mixed. See `deliver`. */
  lastInputBy?: RunBy | null;
  /** Turns handed to the runtime and not yet answered by a result. `state`
   *  alone is not enough: `markIdle` fires on ANY result or non-fatal error
   *  while another person's queued turn may still be pending. Only a result
   *  decrements it, so a runtime that merges queued inputs into one turn leaves
   *  it above zero — a mixed run then stays mixed (fail closed). */
  turnsInFlight: number;
  taskStartedAt?: number;
  run: SessionRun;
  sessionId: string;
  cwd: string;
  /** Scratch copies of this run's non-image attachments (see attachments.ts).
   *  Lives for the run, so a file dropped early stays readable later. */
  attachments: AttachmentStore;
  /** The run's live model / reasoning settings, mirrored here because nothing
   *  else remembers them: the `set_` controls travel one way, so a client that
   *  reloads has no way to learn what the session is actually on. Reported as
   *  `run_settings` whenever one of these changes. */
  settings: RunSettings;
  /**
   * What the hub should believe about this run right now, kept here because a
   * frame sent into a dead socket is gone: a turn that finished during a blip
   * lost its `idle`, and the hub showed the run busy for the rest of its life.
   * Re-announced after every reconnect (`announceState`).
   */
  state: 'working' | 'idle';
  /** The tool approval the runtime is blocked on, if any — re-issued after a
   *  reconnect for the same reason. */
  pendingRequest?: { requestId: string; tool: string; input: Record<string, unknown>; title?: string };
  /** The last `background_tasks` event while it was non-empty: the CLI still
   *  runs something that will wake it. Such a run is NOT quiet even when a
   *  failed turn left it idle — restarting the agent (self-update) would kill
   *  the task — and the list is re-told after a reconnect, so a restarted hub
   *  can still show it to whoever opens the session. */
  background?: StreamEvent;
  /** The last `subagents` level (the cards and the panel rows). The hub keeps
   *  it only in memory, so it is re-told after a reconnect like `background`:
   *  a quiet child may send nothing more for minutes. */
  subagents?: StreamEvent;
  /** The last `plan_progress` (`0/0` included — it is the hub's reset), told
   *  again on reconnect: the hub keeps the count only for the Live Activity
   *  row, and a hub restart or a frame lost on a dead socket would leave it
   *  empty or stale until the model's next plan call. */
  plan?: StreamEvent;
  /** The last permission mode reported for this run (`run_mode`). Kept for the
   *  same reason as `settings`: the hub remembers it only in memory, so after
   *  a hub restart every live run showed «Сначала спросить» — the picker's
   *  fallback — until something changed the mode again (10.10.2026). */
  mode?: PermissionMode;
}

/**
 * What a client picked BEFORE the first turn — the start screen's counterpart
 * to the `set_` controls.
 *
 * All three are optional and none can fail a launch: a machine that cannot
 * honour one opens the session under its own default instead of refusing, on
 * the grounds that a session lost to a stale picker is worse than a session
 * that ignored it. Only `permissionMode` predates the picker; it arrived for
 * the headless backend-spec intake, which opens a session in `plan` with nobody
 * watching.
 */
interface StartupSettings {
  requireGateway?: boolean;
  /** Hub user who started/resumed this run; see RunBy in shared/src/protocol.ts. */
  runBy?: RunBy;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: EffortLevel;
}

/** Absent model/effort = no explicit pick; the account default is in force. */
interface RunSettings {
  model?: string;
  activeModel?: string;
  effort?: EffortLevel;
  /** What the runtime is ACTUALLY running at — the twin of `activeModel`. See
   *  the field's note in shared/src/protocol.ts. Wider than `effort`: `max` can
   *  be in force without being settable. */
  activeEffort?: ActiveEffortLevel;
  ultracode?: boolean;
}

/** A user turn held while a run is still settling liveness (resume/takeover). */
interface PendingInput {
  /** Who typed it (hub UI), if known. */
  by?: RunBy;
  text: string;
  images?: ImageInput[];
  files?: FileInput[];
}

interface PendingTool {
  runId: string;
  /** What is being approved — decides whether an answer may carry a
   *  replacement input (only a question's answers may, in chat-only). */
  tool: string;
  resolve: (decision: ToolApprovalDecision) => void;
  timer: NodeJS.Timeout;
  /** Asked after the turn ended (Codex's plan offer) — see `ToolApprovalRequest.afterTurn`. */
  afterTurn?: boolean;
}

interface LiveWriter {
  pid: number;
  entrypoint?: string;
  /** The CLI's process-start token for `pid`; `terminatePid` re-reads it before
   *  each signal so a reused pid is never signalled (see `sessions.sameProcess`). */
  procStart?: string;
}

type RunFactory = (source: RunSource | undefined, options: RunOptions) => SessionRun;

export interface RunManagerOptions {
  send: (message: AgentToCentral) => boolean;
  refreshInventory: () => void;
  scheduleInventory: () => void;
  createRun?: RunFactory;
  findLiveWriter?: (sessionId: string) => Promise<LiveWriter | undefined>;
  readLiveWriters?: () => Promise<Map<string, LiveWriter>>;
  pidIsAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  approvalTimeoutMs?: number;
  /** Source for a `new_session` that names none. Default: the env, then Claude. */
  defaultSource?: RunSource;
  /** `CC_REMOTE_DISABLE_CLAUDE`: refuse to start, resume or take over Claude here. */
  claudeDisabled?: boolean;
  /** Turn-end git observer; injected by tests with a fake probe. */
  gitSignals?: TurnGitSignals;
  recordSessionOrigin?: (runId: string, sessionId: string | null) => void;
  /** A turn ended (result or a failed turn) — its answer is on disk now. */
  turnEnded?: (sessionId: string) => void;
}

/**
 * Owns every writable session run on the agent.
 *
 * Keeping this state behind one boundary makes the single-writer invariant
 * explicit: resume/takeover liveness checks, queued inputs, tool approvals and
 * terminal cleanup all mutate the same registry instead of being spread across
 * the WebSocket client.
 */
export class RunManager {
  private readonly send: RunManagerOptions['send'];
  private readonly refreshInventory: RunManagerOptions['refreshInventory'];
  private readonly scheduleInventory: RunManagerOptions['scheduleInventory'];
  private readonly createRun: RunFactory;
  private readonly findLiveWriter: NonNullable<RunManagerOptions['findLiveWriter']>;
  /** Deletes in flight per session — `launch` refuses a session while any
   *  is. Counted, not a set: a double-pressed «Удалить» runs two deletes, and
   *  the first to finish must not lift the refusal the second still needs. */
  private readonly deleting = new Map<string, number>();
  /** Confined units whose session is being deleted: no run may START in them. */
  private readonly unitLocks = new Map<string, number>();
  /** Runs closed but whose process has not exited yet (cwd kept active). */
  private readonly closingCwds = new Set<{ cwd: string }>();

  /**
   * Confinement: deleting a rollout re-resolves a path inside a unit home that a
   * run of the same unit can write, so nothing may start in that unit while the
   * delete runs (the live-run check alone is a snapshot). Returns the release
   * function; a no-op when confinement is off or the cwd is not a unit.
   */
  lockUnitForDelete(cwd: string | undefined): () => void {
    const key = cwd ? cwdUnitKey(cwd) : undefined;
    if (key === undefined) return () => {};
    this.unitLocks.set(key, (this.unitLocks.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.unitLocks.get(key) ?? 1) - 1;
      if (left > 0) this.unitLocks.set(key, left);
      else this.unitLocks.delete(key);
    };
  }
  private readonly readLiveWriters: NonNullable<RunManagerOptions['readLiveWriters']>;
  private readonly pidIsAlive: NonNullable<RunManagerOptions['pidIsAlive']>;
  private readonly killProcess: NonNullable<RunManagerOptions['killProcess']>;
  private readonly sleep: NonNullable<RunManagerOptions['sleep']>;
  private readonly approvalTimeoutMs: number;
  private readonly defaultSource: RunSource | undefined;
  private readonly claudeDisabled: boolean;
  private readonly gitSignals: TurnGitSignals;
  private readonly recordSessionOrigin: NonNullable<RunManagerOptions['recordSessionOrigin']>;
  private readonly turnEnded: NonNullable<RunManagerOptions['turnEnded']>;

  private readonly runs = new Map<string, RunEntry>();
  private readonly pendingStarts = new Map<string, PendingInput[]>();
  private readonly pendingTools = new Map<string, PendingTool>();
  /**
   * sessionId -> the previous writer's confirmed exit (`SessionRun.exited`).
   * `end()` reports `ended` to the hub at once — the hub releases its lock on
   * that, and the update/shutdown path depends on it going out within the
   * quarter second before exit — but the process behind a Codex run lingers
   * for up to KILL_GRACE_MS after SIGTERM, and nothing in `~/.claude` says so.
   * A resume of the same session on this machine waits here instead, so the
   * old app-server is gone before the new one opens the rollout.
   */
  private readonly dying = new Map<string, Promise<void>>();

  constructor(options: RunManagerOptions) {
    this.recordSessionOrigin = options.recordSessionOrigin ?? (() => {});
    this.turnEnded = options.turnEnded ?? (() => {});
    this.send = options.send;
    this.refreshInventory = options.refreshInventory;
    this.scheduleInventory = options.scheduleInventory;
    this.createRun = options.createRun ?? ((source, runOptions) =>
      source === 'codex' ? new CodexSessionRun(runOptions) : new ClaudeSessionRun(runOptions));
    this.findLiveWriter = options.findLiveWriter ?? findLivePidForSession;
    this.readLiveWriters = options.readLiveWriters ?? readLiveSessions;
    this.pidIsAlive = options.pidIsAlive ?? isPidAlive;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? TOOL_APPROVAL_TIMEOUT_MS;
    this.claudeDisabled = options.claudeDisabled ?? (claudeDisabled() || confinePrefix() !== undefined);
    // With Claude off, a session that names no CLI goes to Codex rather than
    // failing at start — whatever the older default says (Telegram never names one).
    this.defaultSource = this.claudeDisabled ? 'codex' : (options.defaultSource ?? defaultSourceFromEnv());
    this.gitSignals = options.gitSignals ?? new TurnGitSignals(this.send);
  }

  /** A Codex run is mid-turn, waiting on a person or starting. Idle runs do not count. */
  hasBusyCodexRun(): boolean {
    if (this.pendingStarts.size) return true;
    for (const entry of this.runs.values()) {
      if (!(entry.run instanceof CodexSessionRun)) continue;
      if (entry.state !== 'idle' || entry.pendingRequest || entry.background) return true;
    }
    return false;
  }

  /** Close idle Codex runs: the next message resumes them on the current config. */
  closeIdleCodexRuns(): void {
    for (const [runId, entry] of [...this.runs]) {
      if (entry.run instanceof CodexSessionRun && entry.state === 'idle') this.end(runId, 'ended');
    }
  }

  get activeCount(): number {
    return this.runs.size;
  }

  /**
   * True when stopping every run now would interrupt nothing: no turn in
   * progress, no approval or question waiting on a person, no start still
   * launching. An `idle` run is fine to close — the session resumes on the next
   * message. Used by self-update to pick its moment.
   */
  isQuiet(): boolean {
    if (this.pendingStarts.size) return false;
    for (const entry of this.runs.values()) {
      // An after-turn card holds no turn: closing the run just refuses it.
      const card = entry.pendingRequest ? this.pendingTools.get(entry.pendingRequest.requestId) : undefined;
      if (entry.state !== 'idle' || (entry.pendingRequest && !card?.afterTurn) || entry.background) return false;
    }
    return true;
  }

  /** Working directories of every run this agent is driving — the cwds a
   *  `projects.remove` must refuse to move out from under. */
  activeCwds(): string[] {
    return [...[...this.runs.values()].map((entry) => entry.cwd), ...[...this.closingCwds].map((c) => c.cwd)];
  }

  /** A commit in `cwd` was already announced for this session by another path
   *  (the commit-signal hook, the Git panel's git.commit) — keep the turn-end
   *  observer from announcing the same sha again. */
  noteExternalCommit(sessionId: string, cwd?: string): void {
    this.gitSignals.noteExternalCommit(sessionId, cwd);
  }

  /** How long this agent waits on a human before auto-denying a tool call.
   *  Declared at register so the hub replays pending approvals by THIS
   *  machine's deadline rather than a fleet-wide guess. */
  get approvalTimeout(): number {
    return this.approvalTimeoutMs;
  }

  /**
   * Runs still driving a live subprocess here. Declared on `register` so the hub
   * can re-adopt them after a socket blip instead of releasing them: the writer
   * never stopped, so re-adoption resurrects nothing and the single-writer
   * invariant is untouched.
   */
  /**
   * End every run (`ended`) and resolve once each run's PROCESS is confirmed
   * gone — or the kill escalation's bound has passed. For the update/restart
   * path: the `writer_released` frames then leave on this socket before the
   * process exits, instead of the hub waiting out its closing guard.
   */
  async endAllAndAwaitExit(): Promise<void> {
    this.draining = true;
    this.pendingStarts.clear();
    const exits: Promise<void>[] = [];
    for (const [runId, entry] of [...this.runs]) {
      const exited = entry.run.exited;
      this.end(runId, 'ended');
      if (exited) exits.push(exited.then(() => undefined, () => undefined));
    }
    if (exits.length === 0) return;
    await Promise.race([Promise.all(exits).then(() => undefined), this.sleep(KILL_GRACE_MS + 1_500)]);
  }

  /** The session a live run drives, if the run exists (E2EE command checks). */
  sessionOf(runId: string): string | undefined {
    return this.runs.get(runId)?.sessionId;
  }

  liveRuns(): { runId: string; sessionId: string; cwd: string }[] {
    return [...this.runs.entries()].map(([runId, entry]) => ({
      runId,
      sessionId: entry.sessionId,
      // Carried so a hub that has NO record of this run (its map starts empty
      // after a restart) can rebuild it instead of ordering it closed.
      cwd: entry.cwd,
    }));
  }

  /**
   * Run ids this process is actually driving, for the periodic reconciliation
   * (`run_inventory`). The hub closes anything it holds for us that is absent
   * from this list, so the honest answer is the LAUNCHED runs and nothing else.
   *
   * Reserved-but-unlaunched starts (`pendingStarts`) are deliberately OMITTED.
   * Including them would have re-opened the very hole this closes: a start that
   * never completes would keep claiming the run forever and the hub would go on
   * believing in a writer that does not exist. Leaving them out is safe because
   * the hub orders the run closed before it forgets it, and `end()` deletes the
   * pending start — so a slow start that loses the race is cancelled, not left
   * to launch a writer whose lock has already been freed.
   */
  heldRunIds(): string[] {
    return [...this.runs.keys()];
  }

  async resume(
    runId: string,
    sessionId: string,
    cwd: string,
    source?: RunSource,
    /** Model / effort picked in the composer BEFORE the session was continued
     *  (27.09.2026) — the same pair `new_session` carries, applied the same way. */
    startup?: StartupSettings,
  ): Promise<void> {
    if (this.refuseDisabledClaude(runId, sessionId, source, 'resume_refused')) return;
    if (this.refuseWhileDraining(runId, sessionId, 'resume_refused')) return;
    if (!this.reserveStart(runId)) return;
    // Codex sessions have no editor-writer pid to race (liveness lives in
    // ~/.claude only), so skip the pre-check and launch immediately.
    // A FAILED check is not a clean one. `.catch(() => undefined)` used to make
    // an unreadable liveness directory indistinguishable from an empty one, and
    // the invariant this guard exists for then depended on a filesystem read
    // never failing. Cannot prove the session is free -> refuse; the person
    // retries and gets their message back, which is the cheap failure.
    let hit: LiveWriter | undefined;
    try {
      // Codex sessions have no editor-writer pid to race, so there is nothing
      // to look up for them.
      hit = source === 'codex' ? undefined : await this.findLiveWriter(sessionId);
    } catch (error) {
      this.releaseStart(runId);
      const why = (error as Error).message;
      console.warn(`[agent] run ${runId} refused: liveness check failed (${why})`);
      this.send({
        type: 'run_status',
        sessionId,
        runId,
        state: 'yielded',
        code: 'resume_refused',
        error: `couldn't check whether this session is open somewhere else (${why}) — refused rather than risk a second writer`,
      });
      return;
    }
    // A writer THIS process ended a moment ago may still be exiting (see
    // `dying`); bounded, and only ever set for runtimes that report it.
    if (!(await this.awaitDying(sessionId))) {
      this.releaseStart(runId);
      console.warn(`[agent] run ${runId} refused: a previous process of ${sessionId} has not exited`);
      this.send({
        type: 'run_status',
        sessionId,
        runId,
        state: 'yielded',
        code: 'resume_refused',
        error: RunManager.STILL_EXITING,
      });
      return;
    }
    const size = await this.transcriptSize(sessionId, source, cwd).catch(() => 0);
    const queued = this.releaseStart(runId);
    if (!queued) return; // cancelled (close / disconnect) while checking
    const mb = (n: number) => `${Math.round(n / (1024 * 1024))}MB`;
    // Either refusal below carries `resume_refused`: the message the person
    // sent with the `open` is sitting in `queued`, it is about to be dropped
    // with the run, and the only copy left is the one the client kept — the
    // code is what tells it to put that copy back in the composer.
    if (size > RESUME_MAX_BYTES) {
      this.send({
        type: 'run_status',
        sessionId,
        runId,
        state: 'error',
        code: 'resume_refused',
        error: `transcript is ${mb(size)} (limit ${mb(RESUME_MAX_BYTES)}) — too large to resume. Its history stays readable here, but this session can no longer be continued: start a new one and paste in what matters.`,
      });
      console.warn(`[agent] run ${runId} refused: transcript ${mb(size)} over the resume cap`);
      return;
    }
    if (hit) {
      this.send({
        type: 'run_status',
        sessionId,
        runId,
        state: 'yielded',
        code: 'resume_refused',
        // `describeWriter` tells an editor from a child of a dead agent. Both
        // refuse a resume for the same reason, but only one of them has a
        // person behind it, and the answer differs accordingly.
        error: `session is held by ${describeWriter(hit)} — refused to start a second writer. Send again to take it over: that ends the other writer first.`,
      });
      console.warn(`[agent] run ${runId} refused: session ${sessionId} live (pid ${hit.pid})`);
      return;
    }
    this.launch(runId, sessionId, cwd, source, startup);
    // The hub sends `resume` and its first `input` back to back: judge the
    // launch BEFORE a word reaches the transcript, so a writer that appeared
    // while the SDK was spawning never shares a write with us — and the text
    // goes back to the composer (`resume_refused`) instead of into a run that
    // was yielded a moment later.
    // Inputs that land while the launch is judged queue behind the earlier
    // ones (the start is reserved again for the duration of the read); an
    // input that reached the run directly would precede both the check and
    // the messages typed before it.
    this.pendingStarts.set(runId, queued);
    const alive = await this.checkYields({ runId, code: 'resume_refused' });
    this.pendingStarts.delete(runId);
    if (!alive) return;
    this.yieldBurst(runId);
    this.drainPendingInputs(this.runs.get(runId), queued);
  }

  /** Compact a live run's context on demand. */
  async compact(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) {
      // The hub believed the run was alive; we do not hold it. Say so, the
      // same way `input` does — a silent return left a button that did
      // nothing and a person who could not tell whether it had.
      console.warn(`[agent] compact for run ${runId} dropped — no such run here`);
      this.send({
        type: 'run_status',
        sessionId: '',
        runId,
        state: 'error',
        code: 'run_gone',
        error: 'That session is no longer running here — nothing to compact.',
      });
      return;
    }
    try {
      await entry.run.compact?.();
    } catch (error) {
      // The caller invokes this as `void compact(...)`, so a rejection used to
      // reach the process-wide handler and die in the log. The person had
      // already been told "compacting context…" and never learned it failed.
      const text = `⚠ compaction failed: ${(error as Error).message}`;
      console.error(`[agent] compact ${runId} failed:`, (error as Error).message);
      this.send({
        type: 'stream',
        sessionId: entry.sessionId,
        runId,
        event: { kind: 'status', code: 'compact_failed', text },
      });
    }
  }

  /**
   * Context budget for every live run, for the periodic report. Runs that
   * can't answer (older runtime, mid-teardown) are simply absent — a missing
   * reading is not worth an error.
   *
   * Asked in parallel, not in turn: each query is bounded (see
   * `CONTROL_TIMEOUT_MS`), but one run that takes the whole bound must not
   * delay every other run's reading by that much on every tick.
   */
  async contextUsage(): Promise<
    { runId: string; sessionId: string; usage: NonNullable<Awaited<ReturnType<NonNullable<SessionRun['contextUsage']>>>> }[]
  > {
    const readings = await Promise.all(
      [...this.runs].map(async ([runId, entry]) => ({
        runId,
        sessionId: entry.sessionId,
        usage: await entry.run.contextUsage?.().catch(() => undefined),
      })),
    );
    const out = [];
    for (const { runId, sessionId, usage } of readings) {
      if (!usage) continue;
      // The same poll is how a run learns which model it is on: the `system`
      // init message names it too, but a session nobody has spoken to yet never
      // emits one — and that is precisely when the picker has nothing to show.
      if (usage.model) this.updateSettings(runId, { activeModel: usage.model });
      out.push({ runId, sessionId, usage });
    }
    return out;
  }

  /**
   * Re-announce the state of every live run, and re-issue any approval it is
   * blocked on. Called once the hub confirms it is tracking us again
   * (`register_ack`): frames sent while the socket was down were dropped, not
   * queued, so the hub's picture of a carried run is whatever it was before
   * the outage — or `working`, if it had to adopt the run from nothing.
   */
  announceState(): void {
    for (const [runId, entry] of this.runs) {
      // Before the state, so a viewer attaching on that state already has it.
      if (entry.background) {
        this.send({ type: 'stream', sessionId: entry.sessionId, runId, event: entry.background });
      }
      if (entry.subagents) {
        this.send({ type: 'stream', sessionId: entry.sessionId, runId, event: entry.subagents });
      }
      if (entry.plan) {
        this.send({ type: 'stream', sessionId: entry.sessionId, runId, event: entry.plan });
      }
      this.send({
        type: 'run_status',
        sessionId: entry.sessionId,
        runId,
        state: entry.state === 'working' ? 'started' : 'idle',
        ...(entry.taskStartedAt ? { taskStartedAt: entry.taskStartedAt } : {}),
      });
      const p = entry.pendingRequest;
      if (p) {
        this.send({
          type: 'tool_request',
          sessionId: entry.sessionId,
          runId,
          requestId: p.requestId,
          tool: p.tool,
          input: p.input,
          title: p.title,
          // Asked before this socket existed: not news for anyone's phone.
          replay: true,
        });
      }
    }
  }

  /** A turn is being fed to the runtime — the run is working from here. */
  private markWorking(runId: string): void {
    const entry = this.runs.get(runId);
    if (entry) entry.state = 'working';
  }

  /** Stop one sub-agent of this session's live run. False when no run here
   *  knows that id — the agent is gone, or another machine holds the run. */
  async stopSubagent(sessionId: string, id: string): Promise<boolean> {
    for (const entry of this.runs.values()) {
      if (entry.sessionId !== sessionId || !entry.run.stopSubagent) continue;
      if (await entry.run.stopSubagent(id).catch(() => false)) return true;
    }
    return false;
  }

  /** The «/» list of the live run on this session, if one is held here. */
  async supportedCommands(sessionId: string): Promise<SlashCommandInfo[] | undefined> {
    for (const entry of this.runs.values()) {
      if (entry.sessionId !== sessionId) continue;
      const cmds = await entry.run.supportedCommands?.().catch(() => undefined);
      if (cmds?.length) return cmds;
    }
    return undefined;
  }

  /** Ask any live run what models this runtime offers. */
  async supportedModels(): Promise<ModelInfoLite[] | undefined> {
    for (const entry of this.runs.values()) {
      const models = await entry.run.supportedModels?.().catch(() => undefined);
      if (models?.length) return models;
    }
    return undefined;
  }

  /** Bytes on disk for a session's transcript, by source. */
  private async transcriptSize(sessionId: string, source?: RunSource, cwd?: string): Promise<number> {
    return source === 'codex'
      ? codexRolloutSize(sessionId, cwd)
      : claudeTranscriptSize(sessionId);
  }

  startNew(
    runId: string,
    cwd: string,
    message?: string,
    images?: ImageInput[],
    source?: RunSource,
    startup?: StartupSettings,
    files?: FileInput[],
  ): void {
    if (this.runs.has(runId) || this.pendingStarts.has(runId)) return;
    // Only a brand-new session consults the machine default: a resume or a
    // takeover names the CLI that wrote the transcript, and that is not a choice.
    const effective = source ?? this.defaultSource;
    if (this.refuseDisabledClaude(runId, '', effective, 'session_not_created')) return;
    if (this.refuseWhileDraining(runId, '', 'session_not_created')) return;
    if (startup?.requireGateway && effective !== 'codex') {
      this.send({ type: 'run_status', runId, sessionId: '', state: 'error',
        code: 'session_not_created', error: 'Internal gateway jobs require Codex.' });
      return;
    }
    this.launch(runId, '', cwd, effective, startup);
    this.sendInitialInput(this.runs.get(runId), message, images, files);
    console.log(`[agent] new session run ${runId} in ${cwd}${effective === 'codex' ? ' (codex)' : ''}`);
  }

  async takeover(
    runId: string,
    sessionId: string,
    cwd: string,
    message?: string,
    images?: ImageInput[],
    source?: RunSource,
    files?: FileInput[],
    startup?: StartupSettings,
  ): Promise<void> {
    // Before the reservation and long before the kill loop: on a Claude-off
    // machine a takeover must not displace anybody's editor just to refuse.
    if (this.refuseDisabledClaude(runId, sessionId, source, 'resume_refused')) return;
    if (this.refuseWhileDraining(runId, sessionId, 'resume_refused')) return;
    if (!this.reserveStart(runId)) return;
    const status = (text: string) =>
      this.send({ type: 'stream', sessionId, runId, event: { kind: 'status', text } });
    const abort = (error: string) => {
      this.pendingStarts.delete(runId);
      // Nothing launched, so the first message rode on this takeover for
      // nothing — the code sends it back to the composer.
      this.send({ type: 'run_status', sessionId, runId, state: 'error', code: 'resume_refused', error });
    };

    // Displace every external writer, but bound the loop so a churning editor
    // cannot keep the takeover alive forever.
    for (let attempt = 0; ; attempt++) {
      // Same reasoning as `resume`, and it bites harder here: a takeover's whole
      // job is to CONFIRM death, and a failed lookup used to end the kill loop
      // and launch — declaring the field clear because it could not look at it.
      let hit: LiveWriter | undefined;
      try {
        hit = await this.findLiveWriter(sessionId);
      } catch (error) {
        abort(`couldn't check for live writers (${(error as Error).message}) — aborted rather than risk two`);
        console.warn(`[agent] takeover ${runId} aborted: liveness check failed`);
        return;
      }
      if (!hit) break;
      if (attempt >= 5) {
        abort(`session keeps re-acquiring live writers (last pid ${hit.pid}) — aborted to avoid two writers`);
        console.warn(`[agent] takeover ${runId} aborted: live pids kept appearing`);
        return;
      }
      status(`releasing ${describeWriter(hit)}…`);
      if (!(await this.terminatePid(hit.pid, hit.procStart))) {
        abort(`couldn't release the editor session (pid ${hit.pid}) — aborted to avoid two writers`);
        console.warn(`[agent] takeover ${runId} aborted: pid ${hit.pid} would not die`);
        return;
      }
    }

    if (!(await this.awaitDying(sessionId))) {
      abort(RunManager.STILL_EXITING);
      console.warn(`[agent] takeover ${runId} aborted: a previous process of ${sessionId} has not exited`);
      return;
    }
    this.refreshInventory();
    const queued = this.releaseStart(runId);
    if (!queued) return; // cancelled during the kill loop
    this.launch(runId, sessionId, cwd, source, startup);
    this.pendingStarts.set(runId, queued);
    const alive = await this.checkYields({ runId, code: 'resume_refused' });
    this.pendingStarts.delete(runId);
    if (!alive) return;
    this.yieldBurst(runId);
    const entry = this.runs.get(runId);
    this.sendInitialInput(entry, message, images, files);
    this.drainPendingInputs(entry, queued);
  }

  input(runId: string, text: string, images?: ImageInput[], files?: FileInput[], by?: RunBy): void {
    const queued = this.pendingStarts.get(runId);
    if (queued) {
      queued.push({ text, images, files, ...(by ? { by } : {}) });
      return;
    }
    const entry = this.runs.get(runId);
    if (!entry) {
      // The hub still believed this run was alive — it forwarded the message —
      // but our writer is already gone (closed a moment earlier, or it ended and
      // our `ended` is still in flight). `deliver` used to be handed `undefined`
      // here and returned quietly, so the person's message vanished with nothing
      // logged anywhere. Whatever else happens, this must not be silent.
      console.warn(`[agent] input for run ${runId} dropped — no such run here`);
      this.send({
        type: 'run_status',
        sessionId: '',
        runId,
        state: 'error',
        code: 'run_gone',
        error: 'That session is no longer running — your message was not delivered.',
      });
      return;
    }
    this.deliver(entry, text, images, files, by ?? null);
  }

  interrupt(runId: string): void {
    const entry = this.runs.get(runId);
    entry?.run.interrupt().catch((error) => {
      this.send({
        type: 'stream',
        sessionId: entry.sessionId,
        runId,
        event: { kind: 'status', code: 'control_failed', text: `interrupt failed: ${(error as Error).message}` },
      });
    });
  }

  decideTool(
    requestId: string,
    decision: ToolApprovalDecision,
    /** The hub user who answered (UI path); absent for any other source. */
    by?: RunBy,
  ): void {
    const pending = this.pendingTools.get(requestId);
    if (!pending) return;
    this.pendingTools.delete(requestId);
    clearTimeout(pending.timer);
    const entry = this.runs.get(pending.runId);
    if (entry) this.noteDecisionAuthor(entry, by ?? null, pending.afterTurn === true && decision.allow);
    if (entry?.pendingRequest?.requestId === requestId) {
      entry.pendingRequest = undefined;
      // An after-turn card holds no turn: the answer starts one or it does not.
      if (!pending.afterTurn) entry.state = 'working';
    }
    pending.resolve(chatOnlyDecision(pending.tool, decision));
  }

  /**
   * An answer can shape or launch a turn (AskUserQuestion, a plan accepted —
   * Codex then sends «Implement the plan.» itself, bypassing `deliver`), so it
   * counts for authorship: anyone but the recorded author makes it mixed
   * (null); the same person changes nothing. An accepted plan is a turn handed
   * to the runtime and is counted in flight like one.
   */
  private noteDecisionAuthor(entry: RunEntry, by: RunBy | null, launchesTurn: boolean): void {
    if (entry.lastInputBy !== undefined) {
      const same = !!by && !!entry.lastInputBy && by.userId === entry.lastInputBy.userId;
      if (!same && entry.lastInputBy !== null) {
        entry.lastInputBy = null;
        recordRunInput(entry.runId, entry.startedBy, null);
      }
    }
    if (launchesTurn) entry.turnsInFlight += 1;
  }

  setModel(runId: string, model?: string): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    const what = `модель ${model ?? '(по умолчанию)'}`;
    this.watchSlowControl(runId, what, entry.run.setModel(model))
      // Recorded only once the CLI accepted it — reporting the intent would put
      // a model in the picker that the run is not on.
      .then(() => this.updateSettings(runId, { model }))
      .catch((error) => {
        console.error(`[agent] set_model failed for ${runId}:`, (error as Error).message);
        this.controlFailed(runId, `${what}: ${(error as Error).message}`);
      });
  }

  /**
   * Say so when a setting change is slow, and again when it lands.
   *
   * A CLI that is still booting or busy between steps answers a control late
   * — 20–40 s into a fresh session on a dev box — and the change then applies.
   * Without a line the picker just sits on the old value; with a failure line
   * (what a 10 s bound used to produce) the person is told the opposite of
   * what happens. The promise itself is passed through untouched.
   */
  private watchSlowControl<T>(runId: string, what: string, change: Promise<T>): Promise<T> {
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      this.controlStatus(runId, 'control_pending', `${what}: Claude ещё не ответил — применится, как только освободится`);
    }, CONTROL_SLOW_NOTICE_MS);
    timer.unref?.();
    return change.then(
      (value) => {
        clearTimeout(timer);
        if (slow) this.controlStatus(runId, 'control_applied', `${what}: применено`);
        return value;
      },
      (error: unknown) => {
        clearTimeout(timer);
        throw error;
      },
    );
  }

  /** A `set_` control the runtime refused or never answered — said in the
   *  transcript, because a picker that silently stays on the old value reads
   *  as a control that does nothing. */
  private controlFailed(runId: string, text: string): void {
    this.controlStatus(runId, 'control_failed', text);
  }

  private controlStatus(runId: string, code: 'control_failed' | 'control_pending' | 'control_applied', text: string): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    this.send({
      type: 'stream',
      sessionId: entry.sessionId,
      runId,
      event: { kind: 'status', code, text },
    });
  }

  setPermissionMode(runId: string, mode: Parameters<SessionRun['setPermissionMode']>[0]): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    this.watchSlowControl(runId, `режим ${mode}`, entry.run.setPermissionMode(mode)).catch((error) => {
      console.error(`[agent] set_permission_mode failed for ${runId}:`, (error as Error).message);
      // A refused mode has to reach the person who picked it. Silently logging
      // here leaves a picker showing a mode the run never entered — the failure
      // reads as "the control does nothing", which is the harder bug to find.
      this.controlFailed(runId, `режим ${mode}: ${(error as Error).message}`);
    });
  }

  setEffort(
    runId: string,
    effort?: Parameters<SessionRun['setEffort']>[0],
    ultracode?: boolean,
  ): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    this.watchSlowControl(runId, `усилие ${ultracode ? 'ultracode' : effort ?? '(по умолчанию)'}`, entry.run.setEffort(effort, ultracode))
      // Both fields, always: `setEffort` applies one and clears the other, so a
      // patch that omitted `ultracode` would leave a stale flag in the record.
      .then(() => this.updateSettings(runId, { effort, ultracode: !!ultracode }))
      .catch((error) => {
        console.error(`[agent] set_effort failed for ${runId}:`, (error as Error).message);
        this.controlFailed(runId, `усилие ${ultracode ? 'ultracode' : effort ?? '(по умолчанию)'}: ${(error as Error).message}`);
      });
  }

  /**
   * Fold a change into the run's remembered settings and report the whole set.
   * Whole set, not a delta: the message is also what a reconnecting client is
   * replayed, so a partial one would leave the other control showing a stale
   * value. Silent when nothing actually moved.
   */
  /**
   * Re-announce what every live run is set to.
   *
   * `updateSettings` is EDGE-triggered: it sends a frame only when a value
   * changes. For a run that outlives a reconnect the edge falls exactly where
   * the frame cannot land — the hub is still assembling its record of the run,
   * `agent_run_settings` finds nothing to retain it on, and the frame is gone.
   * Nothing changes again afterwards, so every client watching that run shows
   * composer defaults for its whole life. Measured 19.09.2026: four resumed
   * runs on one machine reported neither model nor effort, while a run started
   * a minute earlier reported both.
   *
   * Called once the hub confirms it is tracking us (`register_ack`), which is
   * the first moment a frame has somewhere to land.
   */
  announceSettings(): void {
    for (const [runId, entry] of this.runs) {
      this.sendSettings(runId);
      if (entry.mode) this.send({ type: 'run_mode', sessionId: entry.sessionId, runId, mode: entry.mode });
    }
  }

  /** The `run_settings` frame for one run, or nothing if it is still blank. */
  private sendSettings(runId: string): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    const s = entry.settings;
    if (!s.model && !s.activeModel && !s.effort && !s.activeEffort && !s.ultracode) return;
    this.send({
      type: 'run_settings',
      sessionId: entry.sessionId,
      runId,
      // zod `optional` is "absent", never null — omit what is not set.
      ...(s.model ? { model: s.model } : {}),
      ...(s.activeModel ? { activeModel: s.activeModel } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.activeEffort ? { activeEffort: s.activeEffort } : {}),
      ...(s.ultracode ? { ultracode: true } : {}),
    });
  }

  private updateSettings(runId: string, patch: RunSettings): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    const next: RunSettings = { ...entry.settings, ...patch };
    // `ultracode` IS xhigh plus orchestration, so it replaces a plain effort
    // rather than sitting beside it.
    if (next.ultracode) delete next.effort;
    if (
      next.model === entry.settings.model &&
      next.activeModel === entry.settings.activeModel &&
      next.effort === entry.settings.effort &&
      next.activeEffort === entry.settings.activeEffort &&
      !!next.ultracode === !!entry.settings.ultracode
    ) {
      return;
    }
    entry.settings = next;
    this.sendSettings(runId);
  }

  end(runId: string, state: 'ended' | 'error'): void {
    this.pendingStarts.delete(runId);
    const entry = this.runs.get(runId);
    if (!entry) return;
    this.runs.get(runId)?.attachments.cleanup();
    this.runs.delete(runId);
    removeRunState(runId);
    this.gitSignals.forget(runId);
    this.settleRunTools(runId, 'Run ended before approval was answered.');
    const closed = this.closeRun(entry);
    this.sendTerminalStatus(entry.sessionId, runId, { state }, closed);
    console.log(`[agent] run ${runId} ${state}`);
  }

  /**
   * Abort starts that have not launched yet, without touching runs that are
   * already driving a subprocess. Used when the uplink drops: a `resume` still
   * awaiting its liveness check would otherwise launch a writer moments later,
   * for a run the hub has already released — a writer holding no lock. The
   * launch paths detect the cancellation because `releaseStart` no longer finds
   * their entry. Live runs are deliberately left alone; they are what the
   * reconnect reclaims.
   */
  cancelPendingStarts(): void {
    if (!this.pendingStarts.size) return;
    console.warn(`[agent] cancelling ${this.pendingStarts.size} unlaunched start(s)`);
    this.pendingStarts.clear();
  }

  /**
   * Say goodbye to every live run before the socket goes away.
   *
   * A restart used to be indistinguishable from a hang: the working indicator
   * stopped, no line appeared, and the tool call that died with the process was
   * recorded by the runtime as «User rejected tool use» — a refusal nobody made.
   * On 19.09.2026 five restarts in a row read as silence on the phone and as
   * five rejections in the transcript, on both sides of the same session.
   *
   * Deliberately only a status LINE, not a `run_status`: the hub learns the
   * runs are gone when this process re-registers without them (it fails each
   * with «agent reconnected without this run»), and every client then offers
   * «Продолжить». Nothing re-resumes a session on its own — a restart costs
   * the person one send, and this line is what tells them why.
   */
  announceShutdown(reason: string): void {
    for (const [runId, entry] of this.runs) {
      this.send({
        type: 'stream',
        sessionId: entry.sessionId,
        runId,
        event: { kind: 'status', code: 'agent_restart', text: reason },
      });
    }
  }

  /** Stop all local activity without emitting statuses on a dead connection. */
  reset(reason = 'Agent disconnected before approval was answered.'): void {
    this.pendingStarts.clear();
    for (const entry of this.runs.values()) {
      // `end()` cleans attachments; this path did not, so every disconnect that
      // outlived the reconnect grace left its `ccr-files-*` dir on disk with no
      // one holding a reference to it any more.
      entry.attachments.cleanup();
      // No terminal `run_status` from here, so no `closing` and no
      // `writer_released` either: the socket is going away (stop) or has been
      // gone past the lease (startRunGrace), and a frame into it is lost. The
      // hub learns these runs are over from the dropped socket, whose
      // reconnect grace outlasts the kill grace; the local `dying` map still
      // keeps this machine from reopening the session over a living process.
      this.closeRun(entry);
    }
    this.runs.clear();
    this.gitSignals.forgetAll();
    for (const [requestId, pending] of this.pendingTools) {
      clearTimeout(pending.timer);
      pending.resolve({ allow: false, message: reason });
      this.pendingTools.delete(requestId);
    }
  }

  /**
   * Yield every run whose session an external writer now holds. With `only`,
   * judge that one run right after its launch and tag the yield
   * `resume_refused`, so the client puts the unsent text back. Returns whether
   * the `only` run is still alive (true when none was named or the writers
   * could not be read — the burst and the watcher judge again).
   */
  async checkYields(only?: { runId: string; code: 'resume_refused' }): Promise<boolean> {
    if (this.runs.size === 0) return false;
    let live: Map<string, LiveWriter>;
    try {
      live = await this.readLiveWriters();
    } catch {
      return only ? this.runs.has(only.runId) : true;
    }
    for (const [runId, entry] of [...this.runs]) {
      if (only && runId !== only.runId) continue;
      const hit = live.get(entry.sessionId);
      if (!hit) continue;
      const reason = `session opened in ${hit.entrypoint ?? 'an editor'} (pid ${hit.pid}) — stopped to avoid corrupting the transcript`;
      this.runs.get(runId)?.attachments.cleanup();
      this.runs.delete(runId);
    removeRunState(runId);
      this.gitSignals.forget(runId);
      this.settleRunTools(runId, reason);
      const closed = this.closeRun(entry);
      this.sendTerminalStatus(
        entry.sessionId,
        runId,
        { state: 'yielded', error: reason, ...(only ? { code: only.code } : {}) },
        closed,
      );
      console.log(`[agent] run ${runId} yielded: ${reason}`);
    }
    return only ? this.runs.has(only.runId) : true;
  }

  async endExternalSession(sessionId: string): Promise<void> {
    for (const entry of this.runs.values()) {
      if (entry.sessionId === sessionId) return;
    }
    const hit = await this.findLiveWriter(sessionId);
    if (!hit) {
      console.log(`[agent] end_external_session: no live pid for ${sessionId}`);
      return;
    }
    // The same identity check `terminatePid` makes before each signal: the
    // pid found a moment ago must still be the process the record named.
    if (hit.procStart !== undefined) {
      const now = await processStartToken(hit.pid, { fresh: true });
      if (now !== undefined && !sameStartToken(now, hit.procStart)) {
        console.warn(
          `[agent] end_external_session: pid ${hit.pid} is another process now — not signalled (${sessionId})`,
        );
        return;
      }
    }
    try {
      this.killProcess(hit.pid, 'SIGTERM');
      console.log(
        `[agent] end_external_session: SIGTERM pid ${hit.pid} (${hit.entrypoint ?? 'editor'}) for ${sessionId}`,
      );
      this.scheduleInventory();
    } catch (error) {
      console.error('[agent] end_external_session kill failed:', (error as Error).message);
    }
  }

  /**
   * Make a session safe to delete: nobody may be left writing its transcript.
   *
   * Deleting used to remove the `.jsonl` and leave our run alive. The CLI keeps
   * the conversation in memory, so its next write re-created the file — holding
   * only the turns after the delete, their parent pointing at nothing. The
   * session stayed in the list (the run was still live), the person pressed
   * «Удалить» again, found no file this time, and got the SDK's "not found in
   * project directory" (28.09.2026, reproduced 1:1 with a throwaway session).
   *
   * Our own run is ended and awaited; a CLI that has not gone within the
   * bound fails the delete instead of having its file removed from under it
   * (the hub takes its "deleted" mark back on the error). A writer we do not
   * drive — an editor, a terminal `claude` — is refused too: its process is
   * the person's, and deleting under it resurrects the file the same way.
   *
   * From here until `finishDelete` the session is marked, and `launch`
   * refuses it: `end()` has already released the hub's lock, so another
   * device's `open` could otherwise start a fresh writer on the file that is
   * about to go.
   */
  async releaseForDelete(sessionId: string, exitWaitMs = KILL_GRACE_MS + 1_500): Promise<void> {
    this.deleting.set(sessionId, (this.deleting.get(sessionId) ?? 0) + 1);
    const runId = this.runIdForSession(sessionId);
    if (runId) {
      // The PROCESS must be gone before the file goes, not just the stream:
      // `completed` settles the moment `close()` is called, while a Codex
      // app-server lives on for up to the kill grace.
      const run = this.runs.get(runId)?.run;
      const exited = (run?.exited ?? run?.completed)?.then(
        () => true,
        () => true,
      );
      this.end(runId, 'ended');
      let timer: NodeJS.Timeout | undefined;
      const gone = await Promise.race([
        exited ?? Promise.resolve(true),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => done(false), exitWaitMs);
        }),
      ]);
      clearTimeout(timer);
      if (!gone) {
        throw new Error(`процесс сессии не завершился за ${Math.round(exitWaitMs / 1000)} с — удаление отменено, повторите`);
      }
      return;
    }
    const writer = await this.findLiveWriter(sessionId);
    if (writer) {
      throw new Error(
        `сессия сейчас открыта на машине в другом клиенте (${writer.entrypoint ?? 'pid ' + writer.pid}) — закройте её там и удалите снова`,
      );
    }
  }

  /** The delete is over, whichever way it went (`releaseForDelete`). */
  finishDelete(sessionId: string): void {
    const left = (this.deleting.get(sessionId) ?? 0) - 1;
    if (left > 0) this.deleting.set(sessionId, left);
    else this.deleting.delete(sessionId);
  }

  /** Claude is off here (`CC_REMOTE_DISABLE_CLAUDE`): refuse a non-Codex run
   *  before anything else happens. The code tells clients to give the
   *  undelivered message back. Returns true when it refused. */
  /**
   * Set by `endAllAndAwaitExit` for the seconds the agent waits for its
   * processes before exiting (self-update). A run started in that window would
   * be killed by the exit moments later, with its first message lost; refusing
   * sends the text back to the composer instead (`resume_refused` /
   * `session_not_created`), and the restarted agent takes the next attempt.
   */
  private draining = false;

  private refuseWhileDraining(
    runId: string,
    sessionId: string,
    code: 'resume_refused' | 'session_not_created',
  ): boolean {
    if (!this.draining) return false;
    this.send({
      type: 'run_status',
      runId,
      sessionId,
      state: 'error',
      code,
      error: 'агент перезапускается после обновления — повторите через несколько секунд',
    });
    return true;
  }

  private refuseDisabledClaude(
    runId: string,
    sessionId: string,
    source: RunSource | undefined,
    code: 'resume_refused' | 'session_not_created',
  ): boolean {
    if (!this.claudeDisabled || source === 'codex') return false;
    this.send({ type: 'run_status', runId, sessionId, state: 'error', code, error: CLAUDE_DISABLED_MESSAGE });
    return true;
  }

  /** The one way a run's process is told to go: close it, and remember the
   *  session until the process is confirmed gone (`dying`). Every path that
   *  ends a run goes through here — a site that forgot `rememberDying` was
   *  a second writer waiting to happen. */
  private closeRun(entry: RunEntry): ClosedRun {
    entry.run.close();
    const { exited } = entry.run;
    this.rememberDying(entry.sessionId, exited);
    if (exited) {
      // The process outlives close() for up to the kill grace and may still be
      // writing in its cwd: that cwd stays "active" until it is really gone.
      const closing = { cwd: entry.cwd };
      this.closingCwds.add(closing);
      void exited.then(() => undefined, () => undefined).then(() => this.closingCwds.delete(closing));
    }
    return exited ? { exited } : {};
  }

  /**
   * The terminal `run_status` of a run `closeRun` just closed (or of a run that
   * was already gone: `closed` absent). When the runtime process may outlive
   * the close (`closed.exited`) the frame says `closing: true` — the hub then
   * keeps the session's writer guard — and `writer_released` follows once
   * `exited` confirms the process gone. The frame goes out at once either way:
   * the update/shutdown path needs it to leave within a quarter second, and a
   * hub that never gets `writer_released` (this agent exited first, the socket
   * was down) frees the guard on its own deadline (`RUN_CLOSING_MAX_MS`).
   *
   * A run without `exited` (Claude: its writers show in `~/.claude/sessions`)
   * sends exactly the frame it always did — `closing` absent, not `false`.
   */
  private sendTerminalStatus(
    sessionId: string,
    runId: string,
    status: { state: 'ended' | 'error' | 'yielded'; error?: string; code?: string },
    closed?: ClosedRun,
  ): void {
    const exited = closed?.exited;
    this.send({
      type: 'run_status',
      sessionId,
      runId,
      ...status,
      ...(exited ? { closing: true } : {}),
    });
    if (!exited) return;
    const released = () => {
      this.send({ type: 'writer_released', sessionId, runId });
    };
    void exited.then(released, released);
  }

  private rememberDying(sessionId: string, exited: Promise<void> | undefined): void {
    if (!sessionId || !exited) return;
    const settled = exited.then(
      () => undefined,
      () => undefined,
    );
    this.dying.set(sessionId, settled);
    void settled.then(() => {
      if (this.dying.get(sessionId) === settled) this.dying.delete(sessionId);
    });
  }

  /**
   * True once no process of a previous run is left on this session — or at
   * once when none was dying. False when the bound passes first: the process
   * outlived SIGKILL (a stuck write, a zombie), and the caller REFUSES rather
   * than starts a second writer next to it. The entry stays until the process
   * really goes, so the next attempt is judged the same way.
   */
  private async awaitDying(sessionId: string): Promise<boolean> {
    const dying = this.dying.get(sessionId);
    if (!dying) return true;
    return Promise.race([
      dying.then(() => true),
      this.sleep(KILL_GRACE_MS + 1_500).then(() => false),
    ]);
  }

  /** Why a resume/takeover was refused while the previous process lingers. */
  private static readonly STILL_EXITING =
    'предыдущий процесс этой сессии ещё завершается — повторите через несколько секунд';

  private reserveStart(runId: string): boolean {
    if (this.runs.has(runId) || this.pendingStarts.has(runId)) return false;
    this.pendingStarts.set(runId, []);
    return true;
  }

  private releaseStart(runId: string): PendingInput[] | undefined {
    const queued = this.pendingStarts.get(runId);
    this.pendingStarts.delete(runId);
    return queued;
  }

  /**
   * The single-writer invariant, enforced locally. The hub's `lock_by_key` stops
   * a second run being opened THROUGH it, but that lock can be absent exactly
   * when it matters — a restarted hub holds none, and it may hand out a fresh
   * runId for a session this process is already driving. Without this check one
   * agent happily runs two writers into the same transcript and corrupts it.
   */
  private runIdForSession(sessionId: string): string | undefined {
    if (!sessionId) return undefined;
    for (const [runId, entry] of this.runs) {
      if (entry.sessionId === sessionId) return runId;
    }
    return undefined;
  }

  private launch(
    runId: string,
    sessionIdInit: string,
    cwd: string,
    source?: RunSource,
    startup?: StartupSettings,
  ): void {
    if (this.runs.has(runId)) return;
    if (isBeingRemoved(cwd)) {
      this.send({
        type: 'run_status',
        sessionId: sessionIdInit,
        runId,
        state: 'error',
        code: sessionIdInit ? 'resume_refused' : 'session_not_created',
        error: 'эта папка (worktree) сейчас удаляется',
      });
      return;
    }
    if (this.unitLocks.size > 0) {
      const key = cwdUnitKey(cwd);
      if (key !== undefined && this.unitLocks.has(key)) {
        this.send({
          type: 'run_status',
          sessionId: sessionIdInit,
          runId,
          state: 'error',
          code: sessionIdInit ? 'resume_refused' : 'session_not_created',
          error: 'в этом деле сейчас удаляется сессия — повторите через несколько секунд',
        });
        return;
      }
    }
    if (sessionIdInit && this.deleting.has(sessionIdInit)) {
      console.warn(`[agent] run ${runId} refused: session ${sessionIdInit} is being deleted`);
      this.send({
        type: 'run_status',
        sessionId: sessionIdInit,
        runId,
        state: 'yielded',
        code: 'resume_refused',
        error: 'session is being deleted',
      });
      return;
    }
    const holder = this.runIdForSession(sessionIdInit);
    if (holder) {
      console.warn(
        `[agent] run ${runId} refused: session ${sessionIdInit} already driven by run ${holder}`,
      );
      this.send({
        type: 'run_status',
        sessionId: sessionIdInit,
        runId,
        state: 'yielded',
        code: 'resume_refused',
        error: 'session already has a writer on this machine — refused to start a second',
      });
      return;
    }
    let sessionId = sessionIdInit;
    // Identity file the coder's env points at; exists before the coder does.
    const runStateFile = createRunState(runId, startup?.runBy);
    const runOptions: RunOptions = {
      ...(startup?.requireGateway ? { requireGateway: true } : {}),
      ...(startup?.runBy ? { runBy: startup.runBy } : {}),
      ...(runStateFile ? { runStateFile } : {}),
      sessionId: sessionIdInit || undefined,
      cwd,
      // zod `optional` is "absent", never null — and the same holds going the
      // other way into the runtimes: an explicit `undefined` model would read
      // as "clear the model" rather than "nothing was picked".
      ...(startup?.permissionMode ? { permissionMode: startup.permissionMode } : {}),
      ...(startup?.model ? { model: startup.model } : {}),
      ...(startup?.effort ? { effort: startup.effort } : {}),
      handlers: {
        onSessionId: (id) => {
          if (!id || id === sessionId) return;
          if (!sessionIdInit) this.recordSessionOrigin(runId, id);
          sessionId = id;
          const entry = this.runs.get(runId);
          if (entry) entry.sessionId = id;
          this.send({ type: 'session_started', runId, sessionId: id });
          console.log(`[agent] run ${runId} session id ${id}`);
        },
        onEvent: (event) => {
          if (!sessionIdInit && !sessionId && event.code === 'session_not_created' && event.fatal) {
            this.recordSessionOrigin(runId, null);
          }
          if (event.code === 'background_tasks') {
            const entry = this.runs.get(runId);
            const tasks = event.data?.['tasks'];
            if (entry) {
              entry.background = Array.isArray(tasks) && tasks.length
                ? { kind: event.kind, text: event.text ?? '', code: event.code, data: event.data }
                : undefined;
            }
          }
          if (event.code === 'plan_progress') {
            const entry = this.runs.get(runId);
            if (entry) entry.plan = event;
          }
          if (event.code === 'subagents') {
            const entry = this.runs.get(runId);
            const agents = event.data?.['agents'];
            if (entry) {
              entry.subagents = Array.isArray(agents) && agents.length
                ? { kind: event.kind, text: event.text ?? '', code: event.code, data: event.data }
                : undefined;
            }
          }
          this.send({
            type: 'stream',
            sessionId,
            runId,
            // zod `optional` is "absent", never null — omit what is unset.
            event: {
              kind: event.kind,
              text: event.text,
              ...(event.code ? { code: event.code } : {}),
              ...(event.data ? { data: event.data } : {}),
            },
          });
          if (event.kind === 'result') {
            this.markIdle(runId);
            this.send({ type: 'run_status', sessionId, runId, state: 'idle' });
            // The turn is over for Claude and Codex alike — the one place to
            // ask git what the session did. Fire-and-forget: it never delays
            // the idle, and a failed probe is silence, not an error.
            void this.gitSignals.turnEnded(runId, sessionId, cwd);
            this.turnEnded(sessionId);
          } else if (event.kind === 'error' && !event.fatal) {
            // ONE TURN failed — an API error, a tool that crashed, max turns.
            // The runtime is alive and waiting for the next message, exactly
            // as a terminal would be, so the run stays open and goes idle.
            // Closing it here — which is what happened before — turned every
            // transient 5xx into a dead run: the next message had to resume
            // from scratch, and if the transcript was over the cap, could not.
            console.warn(`[agent] run ${runId} turn failed (session ${sessionId}): ${event.text ?? 'no reason given'}`);
            this.markIdle(runId);
            this.send({ type: 'run_status', sessionId, runId, state: 'idle' });
            this.turnEnded(sessionId);
          } else if (event.kind === 'error') {
            // The RUN died: the subprocess exited, the stream threw, a stop
            // went unanswered. Only this ends the run.
            const entry = this.runs.get(runId);
            let closed: ClosedRun | undefined;
            console.error(`[agent] run ${runId} failed (session ${sessionId}): ${event.text ?? 'no reason given'}`);
            if (entry) {
              entry.attachments.cleanup();
              this.runs.delete(runId);
    removeRunState(runId);
              this.gitSignals.forget(runId);
              this.settleRunTools(runId, event.text ?? 'Run failed.');
              // A quota refusal or a thread/resume timeout ends the run while
              // the app-server may still be mid-write; «Продолжить» must wait
              // for it the same way `end()` makes a reopen wait.
              closed = this.closeRun(entry);
            }
            this.sendTerminalStatus(
              sessionId,
              runId,
              { state: 'error', error: event.text, ...(event.code ? { code: event.code } : {}) },
              closed,
            );
          } else if (event.code === 'plan_accepted') {
            // The runtime starts the implementing turn itself, past `deliver`:
            // say it here, with a fresh clock, as `deliver` would.
            const entry = this.runs.get(runId);
            if (entry) {
              entry.state = 'working';
              entry.taskStartedAt = Date.now();
              this.send({ type: 'run_status', sessionId, runId, state: 'started', taskStartedAt: entry.taskStartedAt });
            }
          } else if (event.kind === 'partial' || event.kind === 'assistant' || event.kind === 'tool_use'
                     || event.code === 'turn_started') {
            this.markWorking(runId);
          }
        },
        approveTool: (request) => this.requestToolApproval(runId, sessionId, request),
        onModeChange: (mode) => {
          const entry = this.runs.get(runId);
          if (entry) entry.mode = mode;
          this.send({ type: 'run_mode', sessionId, runId, mode });
        },
        onActiveModel: (activeModel) => {
          this.updateSettings(runId, { activeModel });
        },
        // The SDK hands back a bare string. `max` is reported by the CLI and
        // cannot be set from here — it used to be DROPPED for that reason, which
        // meant a session actually running at it reported nothing and the picker
        // said «unknown». The wire now carries it (ActiveEffortLevel), so report
        // what is true and let the control decide what it can offer.
        onActiveEffort: (level) => {
          // Mirrors ActiveEffortLevel in shared/src/protocol.ts. A level missing
          // here is dropped silently and the control goes blank, so the two
          // lists have to move together.
          const known = ['low', 'medium', 'high', 'xhigh', 'max', 'none', 'ultra'] as const;
          const hit = known.find((k) => k === level);
          console.log(`[agent] run ${runId} effort reported: ${level}${hit ? '' : ' (not on the wire)'}`);
          if (hit) this.updateSettings(runId, { activeEffort: hit });
        },
        onRequestedSettingsChange: ({ model, effort }) => {
          this.updateSettings(runId, { model, effort });
        },
      },
    };

    let run: SessionRun;
    try {
      // The one gate for new, resumed and taken-over sessions alike: a Claude
      // transcript on a Codex-only machine stays readable, not continuable.
      if (this.claudeDisabled && source !== 'codex') throw new Error(CLAUDE_DISABLED_MESSAGE);
      run = this.createRun(source, runOptions);
    } catch (error) {
      this.send({
        type: 'run_status',
        sessionId,
        runId,
        state: 'error',
        error: (error as Error).message,
      });
      return;
    }
    this.runs.set(runId, {
      runId,
      run,
      ...(startup?.runBy ? { startedBy: startup.runBy } : {}),
      sessionId,
      cwd,
      settings: {},
      turnsInFlight: 0,
      attachments: new AttachmentStore(unitScratchDir(cwd)),
      // A fresh run is `started` to the hub, i.e. working, until its first
      // result — which matches what the hub assumes when it adopts one.
      state: 'working',
      ...(startup?.permissionMode ? { mode: startup.permissionMode } : {}),
    });
    // Report what the session was opened ON, or the pickers show the machine
    // default while the run is somewhere else. Nothing downstream would say it
    // otherwise: Claude announces the model it RESOLVED to, never the alias
    // that was asked for, and Codex announces neither. No-ops when nothing was
    // picked, which is the usual case.
    this.updateSettings(runId, { model: startup?.model, effort: startup?.effort });
    // The mode, for the same reason and by a different route: `run_mode` is
    // otherwise only ever emitted from the runtime's own readback — Claude's
    // SDK `system` init, Codex's `onModeChange` — and Claude's init does not
    // arrive until the first turn is processed. A session opened in `plan` and
    // looked at before anything is typed would show «спросить сначала», which
    // is not a stale label but a wrong answer to "what will this do next".
    // The runtime's readback lands later and wins.
    if (startup?.permissionMode) {
      this.send({ type: 'run_mode', sessionId, runId, mode: startup.permissionMode });
    }
    this.gitSignals.observe(runId, cwd);
    void run.completed.then(() => {
      const entry = this.runs.get(runId);
      if (!entry || entry.run !== run) return;
      this.runs.get(runId)?.attachments.cleanup();
      this.runs.delete(runId);
    removeRunState(runId);
      this.gitSignals.forget(runId);
      this.settleRunTools(runId, 'Run ended before approval was answered.');
      if (run.finishedWith !== 'error') {
        this.send({ type: 'run_status', sessionId, runId, state: 'ended' });
        console.log(`[agent] run ${runId} stream ended`);
      }
    });
    this.send({ type: 'run_status', sessionId, runId, state: 'started' });
    console.log(`[agent] run ${runId} started (session ${sessionId || '(new)'})`);
  }

  private requestToolApproval(
    runId: string,
    sessionId: string,
    request: Parameters<NonNullable<RunOptions['handlers']['approveTool']>>[0],
  ): Promise<ToolApprovalDecision> {
    // Answered here, before a card is ever minted: nothing is sent to the hub,
    // nothing is remembered on the run, and no timer is armed.
    if (autoApproves(request.tool)) return Promise.resolve({ allow: true });
    const afterTurn = request.afterTurn === true;
    return new Promise<ToolApprovalDecision>((settle) => {
      // A refused after-turn card leaves nothing running, and nothing else
      // would take the hub's run out of «ждёт ответа». Only if no turn started
      // meanwhile (a message typed instead of an answer is `deliver`'s case).
      const resolve = (decision: ToolApprovalDecision) => {
        settle(decision);
        if (!afterTurn) return;
        // Checked once the runtime has acted on the answer (its continuation
        // runs in microtasks): an accept it did not act on — the mode was
        // switched by hand meanwhile — must not leave the hub on «ждёт ответа».
        setImmediate(() => {
          const current = this.runs.get(runId);
          if (current && current.state !== 'working') {
            this.markIdle(runId);
            this.send({ type: 'run_status', sessionId: current.sessionId, runId, state: 'idle' });
          }
        });
      };
      const requestId = randomUUID();
      const entry = this.runs.get(runId);
      const timer = setTimeout(() => {
        if (!this.pendingTools.delete(requestId)) return;
        if (entry?.pendingRequest?.requestId === requestId) entry.pendingRequest = undefined;
        resolve({
          allow: false,
          message: `Nobody answered the approval within ${Math.round(this.approvalTimeoutMs / 60_000)} minutes — denied.`,
        });
      }, this.approvalTimeoutMs);
      timer.unref?.();
      this.pendingTools.set(requestId, { runId, tool: request.tool, resolve, timer, afterTurn });
      // Remembered on the run so a reconnect can re-issue it (`announceState`).
      // The old behaviour — deny the moment the socket is down — threw away a
      // question the CLI was still waiting on, over a blip that lasted a second.
      // The hold keeps the question; the timeout above is what bounds it. A
      // question means a turn is in progress, whatever the last frame said.
      if (entry) {
        if (!afterTurn) entry.state = 'working';
        entry.pendingRequest = { requestId, tool: request.tool, input: request.input, title: request.title };
      }
      const sent = this.send({
        type: 'tool_request',
        sessionId,
        runId,
        requestId,
        tool: request.tool,
        input: request.input,
        title: request.title,
      });
      if (!sent) console.warn(`[agent] tool_request ${requestId} held until the hub is back`);
    });
  }

  private settleRunTools(runId: string, message: string): void {
    for (const [requestId, pending] of this.pendingTools) {
      if (pending.runId !== runId) continue;
      this.pendingTools.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ allow: false, message });
    }
    const entry = this.runs.get(runId);
    if (entry) entry.pendingRequest = undefined;
  }

  /** A turn ended (result or a failed turn) — the run is idle from here. */
  private markIdle(runId: string): void {
    const entry = this.runs.get(runId);
    if (entry) {
      entry.state = 'idle';
      entry.turnsInFlight = Math.max(0, entry.turnsInFlight - 1);
      entry.pendingRequest = undefined;
    }
  }

  private drainPendingInputs(entry: RunEntry | undefined, queued: PendingInput[]): void {
    for (const item of queued) this.deliver(entry, item.text, item.images, item.files, item.by ?? null);
  }

  /**
   * Hand one turn to the runtime, materialising any non-image attachments first.
   *
   * The single place a turn reaches `sendInput`, so files work identically on
   * every path into a session — a first message, a queued one, a live input —
   * and on both runtimes, neither of which needs to know files exist.
   */
  private deliver(
    entry: RunEntry | undefined,
    text: string,
    images?: ImageInput[],
    files?: FileInput[],
    /** Author of this turn; null = not a signed-in person (bot, fleet). */
    by: RunBy | null = null,
  ): void {
    if (!entry) return;
    // BEFORE the coder sees the turn: a script woken by it reads the author.
    // The file is written when the turn is QUEUED, which can be while another
    // person's turn is still running. So while busy, only the same author keeps
    // the name; anyone else makes it null («mixed») until the run goes idle and
    // a turn starts from there with a single author.
    const busy = entry.turnsInFlight > 0 || (entry.state === 'working' && entry.lastInputBy !== undefined);
    const author: RunBy | null = busy
      ? by && entry.lastInputBy && by.userId === entry.lastInputBy.userId
        ? by
        : null
      : by;
    entry.lastInputBy = author;
    entry.turnsInFlight += 1;
    recordRunInput(entry.runId, entry.startedBy, author);
    const note = files?.length ? entry.attachments.materialize(files) : '';
    entry.state = 'working';
    // A message instead of an answer: the after-turn card is walked past, and
    // its late answer must not start a second turn behind this one.
    for (const [requestId, pending] of this.pendingTools) {
      if (pending.runId !== entry.runId || !pending.afterTurn) continue;
      this.pendingTools.delete(requestId);
      clearTimeout(pending.timer);
      if (entry.pendingRequest?.requestId === requestId) entry.pendingRequest = undefined;
      pending.resolve({ allow: false, message: 'Superseded by a new message.' });
    }
    entry.taskStartedAt = Date.now();
    this.send({ type: 'run_status', runId: entry.runId, sessionId: entry.sessionId,
      state: 'started', taskStartedAt: entry.taskStartedAt });
    entry.run.sendInput(note + text, images);
  }

  private sendInitialInput(
    entry: RunEntry | undefined,
    message?: string,
    images?: ImageInput[],
    files?: FileInput[],
  ): void {
    if ((message && message.trim()) || images?.length || files?.length) {
      // The first turn of a run is the starter's own.
      this.deliver(entry, message ?? '', images, files, entry?.startedBy ?? null);
    }
  }

  /** SIGTERM, escalate to SIGKILL after ~4s; resolve true once the pid is gone.
   *  The loop itself lives in `kill-pid.ts` — the `orphans` CLI ends a writer
   *  the same way, and there must be one implementation of «confirm it died». */
  private terminatePid(pid: number, expectedStart?: string): Promise<boolean> {
    return terminatePid(
      pid,
      {
        killProcess: this.killProcess,
        pidIsAlive: this.pidIsAlive,
        sleep: this.sleep,
      },
      expectedStart,
    );
  }

  /**
   * The window between the last liveness check and the launch cannot be closed
   * without the CLI's cooperation: an editor may write its pid file while the
   * SDK is spawning ours, and the fs watcher only reacts to events (a lost one
   * is never replayed). So the launch is followed by a short burst of checks
   * — at once, and again as the new child comes up — which turns a seconds-long
   * blind spot into a yield within a second or three. Narrowing, not closing;
   * `checkYields` does the actual judging.
   */
  private yieldBurst(runId: string): void {
    for (const ms of [300, 1_000, 3_000]) {
      const timer = setTimeout(() => {
        if (this.runs.has(runId)) void this.checkYields();
      }, ms);
      timer.unref?.();
    }
  }
}
