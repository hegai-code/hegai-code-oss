import { CodexTurnUsage } from './turn-usage.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffortLevel, ImageInput, ModelInfoLite, PermissionMode } from '@cc-remote/shared';
import type {
  ContextUsage,
  RunHandlers,
  RunOptions,
  SessionRun,
  ToolApprovalDecision,
} from './claude-session.js';
import { findCodexTranscript } from './codex.js';
import { imageGenEvent } from './image-gen.js';
import { RolloutImageTail } from './codex-rollout-tail.js';
import { gatewayProvider } from './gateway.js';
import {
  goAvailable,
  goCatalogueMisfit,
  goSpawnArgs,
  goUserAllowed,
  isGoModel,
  rolloutLastModel,
  rolloutUsesGo,
} from './opencode-go.js';
import { AGENT_VERSION } from './config.js';
import { policy } from './policy.js';
import { machineDefaultPermissionMode } from './permission-mode.js';
import { childEnv, runUserEnv } from './child-env.js';
import { CodexNotFound, describeSearch, spawnCodex } from './runtime-locate.js';
import { assertRolloutInUnit, prepareConfinement } from './confine.js';
import { CodexSpawnError, withCodexAppServer } from './codex-rpc.js';
import { asRecord, optionalString } from './json-util.js';
import { BUDGET_EXHAUSTED_TEXT, classifyModelError } from './model-error.js';
import { CodexSubagents, interruptRaceTurnId } from './codex-subagents.js';

/**
 * Drives a resumed OpenAI Codex session through one persistent `codex
 * app-server` process. Unlike `codex exec --json`, app-server exposes the real
 * interactive protocol: plan/default collaboration modes and
 * `item/tool/requestUserInput` requests that can be answered by the web/iOS UI.
 *
 * One instance == one writable run of one Codex thread. The app-server stays
 * alive across turns, so requests that pause a turn for user input keep their
 * original JSON-RPC correlation id and resume in-place after the answer.
 */

type Sandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
type RpcId = string | number;

interface Turn {
  text: string;
  images?: ImageInput[];
  /** Explicit steering refusal: wait for this turn to finish before retrying. */
  waitForTurnId?: string;
  /** Only meaningful inside the turn that is running now (a note about a
   *  stopped sub-agent): dropped rather than started as a turn of its own. */
  steerOnly?: boolean;
}

class CodexRpcError extends Error {}

interface PendingRpc {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CodexQuestion {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description: string }> | null;
  isOther?: boolean;
  isSecret?: boolean;
}

const OUTPUT_CAP = 4000;
const RPC_TIMEOUT_MS = 30_000;
/** How many ended turn ids `endedTurns` remembers — stragglers come from the last few. */
const ENDED_TURNS_KEPT = 16;
/** How long a closing app-server gets to honour SIGTERM before SIGKILL. */
/** SIGTERM to SIGKILL. Exported: RunManager bounds its wait for a dying process on it. */
export const KILL_GRACE_MS = 5_000;

/**
 * Effort for a turn NOBODY named — neither the session (start screen or the
 * composer) nor the machine's `~/.codex/config.toml`.
 *
 * It is not the same as "the model's default". Measured 19.09.2026: a config
 * without `model_reasoning_effort` makes `thread/start` report
 * `reasoningEffort: null` and Codex then runs the turn at `none` — reasoning
 * switched off on a coding model. The gateway installer wrote no such line, so
 * that was every member's machine. A config that DOES name a level arrives here
 * as a non-null `baseEffort` and still wins, which is why this only fills the
 * hole and never overrides a choice.
 *
 * `medium`, not `high`: one shared subscription backs the fleet
 * (`deploy/CAPABILITIES.md` §3.5), and the composer's own control is the way up
 * for a turn that deserves it.
 */
const CODEX_FALLBACK_EFFORT = 'medium';

/**
 * The machine operator's explicit override, or `undefined` if they set none.
 *
 * It used to default to `danger-full-access` when unset, which is how every
 * session ended up unsandboxed regardless of its mode. Unset now means «the
 * session's mode decides» (see `codexApprovalPosture`); a machine that really
 * wants one sandbox for everything still says so with `CODEX_SANDBOX`, and
 * keeps winning.
 */
function sandboxOverride(): Sandbox | undefined {
  const value = process.env['CODEX_SANDBOX'];
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
    ? value
    : undefined;
}

/** The one place `CC_REMOTE_ALLOW_BYPASS` is read on the Codex side. */
function allowBypassEnv(): string | undefined {
  return process.env['CC_REMOTE_ALLOW_BYPASS'];
}

/**
 * May a Codex run on this machine go without approvals and without a sandbox?
 *
 * The Claude side has had `CC_REMOTE_ALLOW_BYPASS=0` since 24.09; the Codex side
 * only used it to pick a DEFAULT, so a client that named `bypassPermissions`
 * (at start or mid-run) still got `danger-full-access`. Chat-only
 * (`policy.ts`) and the env now both hold here, on the machine.
 */
export function codexBypassAllowed(
  forced: string | undefined = allowBypassEnv(),
  chatOnly: boolean = policy().chatOnly,
): boolean {
  if (chatOnly) return false;
  return !(forced === '0' || forced === 'false');
}

/** The mode a run actually gets: bypass asked for where it is not allowed
 *  becomes `default`, the mode that asks. */
export function codexEffectiveMode(mode: PermissionMode, bypass: boolean = codexBypassAllowed()): PermissionMode {
  return mode === 'bypassPermissions' && !bypass ? 'default' : mode;
}

/** Chat-only never runs outside the sandbox, even when the unit file pins
 *  `CODEX_SANDBOX=danger-full-access`. */
function effectiveSandbox(sandbox: Sandbox, chatOnly: boolean = policy().chatOnly): Sandbox {
  return chatOnly && sandbox === 'danger-full-access' ? 'workspace-write' : sandbox;
}

/**
 * What a permission mode MEANS to the Codex app-server.
 *
 * Until now it meant nothing: `approvalPolicy: 'never'` and
 * `sandbox: danger-full-access` were pinned at `thread/start` whatever the mode
 * said, and the picker's «Ask first» never asked. Every Codex session in the
 * fleet was running what the Claude side calls `bypassPermissions`, labelled as
 * the safest option on offer. This is the table that makes the label true.
 *
 * `plan` is deliberately absent: it is not a permission posture but a
 * collaboration mode, and it travels in `collaborationMode` (see
 * `codexCollaborationMode`). Giving it a row here would have it set a sandbox
 * as a side effect of a choice about how to think.
 */
export function codexApprovalPosture(mode: PermissionMode): {
  approvalPolicy: 'on-request' | 'never';
  sandbox: Sandbox;
} {
  switch (mode) {
    case 'acceptEdits':
      // Write inside the workspace without asking; the sandbox is the limit.
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    case 'bypassPermissions':
      // What every Codex session silently did before this existed.
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    default:
      // `default` — and anything unrecognised, because the safe reading of an
      // unknown mode is the one that asks.
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
}

/**
 * The SAME sandbox, in the two different shapes one app-server wants.
 *
 * Measured 23.09.2026 against codex-cli 0.154.0, and this is not a style
 * choice — each spelling is an error at the other end:
 *
 *   thread/start  `sandbox`        → plain string, `'workspace-write'`
 *                                    (an object gives `unknown variant 'type'`)
 *   turn/start    `sandboxPolicy`  → tagged object, `{type:'workspaceWrite'}`
 *                                    (a string gives `expected internally
 *                                     tagged enum SandboxPolicyDeserialize`)
 *
 * Two functions rather than one with a flag: a single «universal» helper is
 * exactly how the wrong form gets sent.
 */
export function codexTurnSandbox(sandbox: Sandbox): Record<string, unknown> {
  const type =
    sandbox === 'read-only' ? 'readOnly' : sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess';
  return { type };
}

/**
 * Network access inside `workspace-write`, which is OFF by default and cannot
 * be turned on through the `sandbox` field at all — only through a config
 * override. Verified both ways: the plain string comes back
 * `networkAccess: false`, and this comes back `true`.
 *
 * Without it `workspace-write` breaks `npm install`, `git push` and `curl` —
 * most of what these sessions exist to do — and the model narrates the failures
 * as if they were bugs in the code.
 */
export function codexSandboxConfig(sandbox: Sandbox): Record<string, unknown> {
  if (sandbox !== 'workspace-write') return {};
  return { config: { sandbox_workspace_write: { network_access: true } } };
}

// `machineDefaultPermissionMode` (the validated `CC_REMOTE_DEFAULT_PERMISSION_MODE`
// read, shared with the Claude path) lives in the SDK-free `permission-mode.ts`.
// Re-exported here because this runtime's tests import it from this module.
export { machineDefaultPermissionMode };

/**
 * What a Codex run starts in when neither the client nor the machine said.
 *
 * The same floor the Claude path got on 24.09.2026 (`defaultPermissionMode` in
 * `claude-session.ts`): nothing means «do not ask». Before it, an unconfigured
 * box fell through to `default` — `approvalPolicy: 'on-request'` — so every
 * community sandbox, which is pinned to Codex and sets no env at all, asked
 * about each command it ran.
 *
 * The machine's own default comes from `machineDefaultPermissionMode`
 * (`permission-mode.ts`), the one validated env read both runtimes share. It is
 * a separate SDK-free module because importing a value out of `claude-session.ts`
 * would drag the Claude SDK into every Codex-only process and test.
 *
 * A pinned `CODEX_SANDBOX` is NOT overruled by this. It outranks the mode in
 * `threadPosture`/`turnPosture`, so such a box gets «never ask, inside the
 * sandbox the operator pinned» — which is the coherent reading of both.
 */
export function codexDefaultPermissionMode(
  configured: PermissionMode | undefined = machineDefaultPermissionMode(),
  forced: string | undefined = allowBypassEnv(),
): PermissionMode {
  if (configured) return codexEffectiveMode(configured, codexBypassAllowed(forced));
  return codexBypassAllowed(forced) ? 'bypassPermissions' : 'default';
}

/**
 * Permission modes this machine offers a CODEX session.
 *
 * Deliberately not `availablePermissionModes` from `claude-session.ts`: that
 * one's gate is about a Claude PreToolUse hook which does not run here, so
 * reusing it would answer this question with evidence about a different
 * runtime.
 *
 * `bypassPermissions` is the only conditional row, and it carries the same
 * meaning it does on the Claude side — no approvals, no sandbox — so it is
 * withheld on exactly the boxes that withhold it there. An operator who has
 * pinned `CODEX_SANDBOX` has already decided the sandbox for every session, and
 * a row that cannot change it is a control that does nothing.
 */
export function availableCodexPermissionModes(
  bypass: boolean,
  pinnedSandbox: Sandbox | undefined = sandboxOverride(),
): PermissionMode[] {
  if (pinnedSandbox) return ['default', 'plan'];
  const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits'];
  if (bypass) modes.push('bypassPermissions');
  return modes;
}

export class CodexSessionRun implements SessionRun {
  private turnUsage = new CodexTurnUsage();
  /** The run's `spawn_agent` children, as the `subagents` level. Fed by the
   *  parent's sub-agent items and by the children's own notifications, which
   *  never reach this run's turn handling (see `onLine`). */
  private readonly subagents = new CodexSubagents(
    () => this.sessionId,
    (agents) => this.handlers.onEvent({ kind: 'status', code: 'subagents', text: '', data: { agents } }),
    { onNewChild: (id) => void this.nameSubagent(id) },
  );
  /** The Codex thread id. Empty until `thread/start` mints one for a brand-new
   *  session; set once, then never changes. */
  private sessionId: string;
  private readonly cwd: string;
  private readonly handlers: RunHandlers;
  private readonly queue: Turn[] = [];
  private readonly pendingRpc = new Map<string, PendingRpc>();
  private readonly cmdHeadered = new Set<string>();
  /** `imageGeneration` item id → when its `started` was seen (the card's clock). */
  private readonly imageGenStarted = new Map<string, number>();
  /** Every picture id announced this turn, by either source (live item or rollout line). */
  private readonly imageGenSeen = new Set<string>();
  /** Follows the rollout for pictures the app-server never announces (see `onImageGeneration`). */
  private readonly imageTail: RolloutImageTail;
  /** The rollout file, once known: from resume, or found after `thread/start`. */
  private rolloutPath: string | undefined;
  private lastRolloutScan = 0;
  /** One app-server question may be re-delivered with a fresh JSON-RPC id.
   * `itemId` is stable, so every delivery shares one modal and one decision. */
  private readonly questionDecisions = new Map<string, Promise<ToolApprovalDecision>>();

  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private threadCreationAttempted = false;
  private running = false;
  private closed = false;
  /** A `thread/compact/start` is in flight; the next turn to finish is its verdict. */
  private compacting = false;
  private nextRpcId = 1;
  private activeTurnId?: string;
  /**
   * Turns that already ended, newest last (`finishTurn`). Codex does not kill
   * what a turn started when the turn is stopped — «any running unified exec
   * processes may still be running in the background» — so a command can
   * report `item/completed` AFTER its turn's `turn/completed`. 28.09.2026 an
   * `nmap` did that 72 s after a stop; forwarded, its output re-opened the
   * finished turn and the session read «работает…» for four hours. Such
   * leftovers are dropped here by `turnId`. Bounded: only recent turns can
   * still have stragglers.
   */
  private readonly endedTurns: string[] = [];
  private readonly imageDirs = new Set<string>();
  private dispatching = false;
  private turnGeneration = 0;
  private stderrTail = '';
  private readonly requireGateway: boolean;
  private readonly runBy?: RunOptions['runBy'];
  private readonly runStateFile?: string;
  private gatewayProviderId?: string;
  /** This app-server runs on OpenCode Go (see opencode-go.ts). Fixed at spawn. */
  private onGo = false;
  /** Go models this app-server's catalogue covers (opencode-go.ts `goSpawnArgs`). */
  private goCatalogue?: ReadonlySet<string>;
  private resumeRollout: string | null = null;
  /** A quota refusal the app-server reported mid-turn. Codex retries 429s on
   *  its own, so the notice alone does not end the run — but if the turn then
   *  fails, this is the reason, even when the final message is generic. */
  private quotaNotice?: string;
  /** Last `thread/tokenUsage/updated` reading — see `contextUsage()`. */
  private tokens?: { used: number; window: number };
  /** A structured Plan item is a fallback, not a second assistant reply. */
  private pendingPlan?: string;
  /**
   * The plan THIS turn proposed, kept for the offer to leave plan mode.
   *
   * Separate from `pendingPlan`, which is cleared the moment the final message
   * repeats it (that is about not printing it twice). This one is about what
   * to put in front of the person once the turn is over.
   */
  private proposedPlan?: string;
  /**
   * Bumped by every new input, so an answer to a plan offer that the person
   * walked past (typed something instead) cannot start an implementation
   * behind the turn they actually asked for.
   */
  private planOffer = 0;
  /** The mode a switch INTO plan left, so accepting the plan returns to it. */
  private modeBeforePlan?: PermissionMode;
  /** Held briefly because automatic context compaction emits its internal
   * handoff as an AgentMessage before the real turn continues. */
  private pendingHandoff?: string;
  private modelMismatchWarned = false;

  private baseModel = '';
  private baseEffort?: string;
  private model?: string;
  private effort?: EffortLevel;
  /**
   * The full mode, not the two-valued shadow it used to be.
   *
   * It was narrowed to `'default' | 'plan'` because anything else had nowhere
   * to go — `collaborationMode` is the only place it was ever sent. Now
   * `codexApprovalPosture` gives `acceptEdits` and `bypassPermissions` a real
   * meaning, so throwing them away at the door would be throwing away the
   * setting itself.
   */
  private permissionMode: PermissionMode;

  readonly completed: Promise<void>;
  private resolveCompleted!: () => void;
  /** The app-server process is gone (its `close` fired), or `close()` gave up
   *  waiting for it: SIGTERM, SIGKILL after KILL_GRACE_MS, and a second more.
   *  RunManager holds a resume of the same session on this until then — the
   *  one writer rule has no pid file to read for Codex. */
  readonly exited: Promise<void>;
  private resolveExited!: () => void;
  finishedWith?: 'end' | 'error';

  constructor(opts: RunOptions) {
    this.requireGateway = opts.requireGateway === true;
    this.runBy = opts.runBy;
    this.runStateFile = opts.runStateFile;
    // Empty sessionId => start a fresh thread; a value => resume that thread.
    this.sessionId = opts.sessionId ?? '';
    this.cwd = opts.cwd;
    this.handlers = opts.handlers;
    this.permissionMode = codexEffectiveMode(opts.permissionMode ?? codexDefaultPermissionMode());
    // Model and effort picked on the start screen cost nothing here: both ride
    // in the per-turn collaboration mode (see `runNext`), so setting the same
    // fields `setModel`/`setEffort` write is all a start-time choice is. The
    // queue is not drained until `start()` has the thread, so the FIRST turn
    // already carries them rather than the second.
    this.model = opts.model;
    this.effort = opts.effort;
    this.completed = new Promise((resolve) => {
      this.resolveCompleted = resolve;
    });
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    const tailMs = Number(process.env['CC_REMOTE_IMAGE_TAIL_MS']);
    this.imageTail = new RolloutImageTail({
      resolve: () => this.resolveRollout(),
      onCall: (payload) => this.onRolloutImage(payload),
      ...(tailMs > 0 ? { intervalMs: tailMs } : {}),
    });
    if (opts.firstMessage) this.queue.push({ text: opts.firstMessage });
    void this.start();
  }

  sendInput(text: string, images?: ImageInput[]): void {
    if (this.closed) return;
    this.planOffer += 1;
    this.queue.push({ text, images });
    void this.runNext();
  }

  /** The unit's private CODEX_HOME when this run is confined. */
  private confineHome: string | undefined;
  /** Its read-only scratch (images), outside the sandbox-writable home. */
  private confineScratch: string | undefined;

  private async start(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      // CC_REMOTE_CONFINE_RUNS: this run sees only its matter folder and its own
      // CODEX_HOME. Throws (run refused) for a cwd outside the prefix.
      const confine = await prepareConfinement(this.cwd, { ...(this.runStateFile ? { runStateFile: this.runStateFile } : {}) });
      await this.resolveGoProvider();
      // That read can take seconds on a big corpus, and close() kills only a
      // child it can see: spawning now would leave an app-server nobody stops.
      if (this.closed) return;
      // One resolver for every codex spawn (runtime-locate.ts): the agent's own
      // PATH is not the person's shell PATH, and a bare `codex` here is how a
      // Mac with nvm ran every Codex session into `spawn codex ENOENT`.
      let providerArgs: string[] = [];
      if (this.onGo) {
        const model = this.model ?? (await rolloutLastModel(this.resumeRollout));
        const go = await goSpawnArgs(this.sessionId || randomUUID(), model);
        if (this.closed) return;
        providerArgs = go.args;
        this.goCatalogue = go.catalogue;
      }
      ({ child } = await spawnCodex([...providerArgs, 'app-server'], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv({
          ...runUserEnv(this.runBy, this.runStateFile),
          ...(confine ? { CODEX_HOME: confine.codexHome } : {}),
        }),
        ...(confine ? { confine } : {}),
      }));
      this.confineHome = confine?.codexHome;
      this.confineScratch = confine?.scratch;
    } catch (error) {
      // No process was started, so nothing can be writing.
      this.resolveExited();
      this.fail(error);
      return;
    }
    this.child = child;
    child.on('error', (error) => this.fail(error));
    // `exit` is the process being gone (it cannot write any more); `close` can
    // lag behind it while a grandchild holds the stdio pipes. Either settles.
    child.once('exit', () => this.resolveExited());
    child.on('close', (code) => {
      this.resolveExited();
      if (this.closed || this.finishedWith) return;
      const tail = this.stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      this.fail(`codex app-server exited ${code ?? '?'}${tail ? `: ${tail}` : ''}`);
    });
    child.stderr.on('data', (data: Buffer) => {
      this.stderrTail = (this.stderrTail + data.toString()).slice(-8000);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.onLine(line));

    try {
      await this.request('initialize', {
        clientInfo: { name: 'cc-remote', title: 'cc-remote', version: AGENT_VERSION },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized');
      if (this.requireGateway) {
        const response = await this.request('config/read', { cwd: this.cwd, includeLayers: false });
        this.gatewayProviderId = gatewayProvider(asRecord(response['config']));
      }
      if (this.sessionId) {
        // Desktop-created rollouts are not always indexed in the standalone
        // CLI's state DB. Supplying the known rollout path makes resume work for
        // those sessions too; app-server validates the path and loads it directly.
        const rolloutPath = this.resumeRollout;
        // Confined: only this unit's own rollout can be resumed here.
        if (this.confineHome) assertRolloutInUnit(rolloutPath, this.confineHome);
        if (rolloutPath) this.rolloutPath = rolloutPath;
        const resumed = await this.requestWithSelectionFallback('thread/resume', {
          threadId: this.sessionId,
          ...(rolloutPath ? { path: rolloutPath } : {}),
          cwd: this.cwd,
          ...this.threadPosture(),
          ...this.threadSelection(),
        });
        this.captureThreadSettings(resumed);
      } else {
        // Pin the start-screen choice on the THREAD itself. Sending it only in
        // turn/start's collaborationMode made thread metadata inherit the
        // machine's Sol default before Astra was applied to the turn.
        this.threadCreationAttempted = true;
        let started: Record<string, unknown>;
        try { started = await this.requestWithSelectionFallback('thread/start', {
          cwd: this.cwd,
          ...this.threadPosture(),
          ...this.threadSelection(),
        }); } catch (error) {
          // A JSON-RPC rejection is conclusive; a timeout/transport failure is
          // not. Never erase an unresolved association after an ambiguous call.
          if (error instanceof CodexRpcError) this.threadCreationAttempted = false;
          throw error;
        }
        this.adoptThreadId(started);
        this.captureThreadSettings(started);
        if (!this.sessionId) throw new Error('codex thread/start returned no thread id');
      }
      if (this.closed || this.finishedWith) return;
      this.ready = true;
      this.handlers.onModeChange?.(this.permissionMode);
      await this.runNext();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Decide the app-server's provider before it is spawned. A resume follows what
   * the rollout recorded, because the thread cannot change provider. A new thread
   * follows the picked model unless this run may not spend the machine's Go plan.
   */
  private async resolveGoProvider(): Promise<void> {
    const allowed = !this.requireGateway && goAvailable() && goUserAllowed(this.runBy?.userId);
    // Kept for the resume in start(): this lookup walks every rollout on the machine.
    this.resumeRollout = this.sessionId ? await findCodexTranscript(this.sessionId, this.cwd) : null;
    const threadOnGo = await rolloutUsesGo(this.resumeRollout);
    if (threadOnGo) {
      if (!allowed) throw new Error('This session runs on OpenCode Go, which is not available to you on this machine.');
      this.onGo = true;
      if (this.model && !isGoModel(this.model)) {
        // A pick left over from the composer, naming a model outside Go.
        this.model = undefined;
        this.handlers.onRequestedSettingsChange?.({ effort: this.effort });
      }
      return;
    }
    if (!isGoModel(this.model)) return;
    const requested = this.model;
    if (!this.sessionId) {
      // Refused, not moved to the machine default: the list cannot tell who is
      // asking, and the person chose OpenCode, not this machine's Codex login.
      if (!allowed) throw new Error('OpenCode is not available to you on this machine.');
      this.onGo = true;
      return;
    }
    this.model = undefined;
    this.handlers.onRequestedSettingsChange?.({ effort: this.effort });
    this.handlers.onEvent({
      kind: 'status',
      code: 'model_error',
      text: `⚠ ${requested} needs a new session: this thread stays on its current provider.`,
    });
  }

  /**
   * Approval policy + sandbox for `thread/start` / `thread/resume`, in the
   * plain-string shape those two take.
   *
   * The machine's `CODEX_SANDBOX` outranks the mode: it is the operator saying
   * what this box permits at all, which is a different question from what this
   * session asked for.
   */
  private threadPosture(): Record<string, unknown> {
    const posture = codexApprovalPosture(this.permissionMode);
    const sandbox = effectiveSandbox(sandboxOverride() ?? posture.sandbox);
    return {
      approvalPolicy: posture.approvalPolicy,
      sandbox,
      ...codexSandboxConfig(sandbox),
    };
  }

  /**
   * The same posture for `turn/start`, where the sandbox is a TAGGED OBJECT and
   * a string is rejected outright — see `codexTurnSandbox`.
   *
   * Sent per turn because both fields are per-turn (verified against codex-cli
   * 0.154.0), which is what lets the composer's mode switch take effect on the
   * next turn instead of demanding a new thread.
   */
  private turnPosture(): Record<string, unknown> {
    const posture = codexApprovalPosture(this.permissionMode);
    const sandbox = effectiveSandbox(sandboxOverride() ?? posture.sandbox);
    return {
      approvalPolicy: posture.approvalPolicy,
      sandboxPolicy: codexTurnSandbox(sandbox),
    };
  }

  /** app-server accepts `model` directly and arbitrary config overrides under
   * `config`; reasoning effort uses the same key as config.toml. */
  private threadSelection(): Record<string, unknown> {
    return {
      ...codexThreadSelection(this.model, this.effort),
      ...(this.gatewayProviderId ? { modelProvider: this.gatewayProviderId } : {}),
    };
  }

  private async requestWithSelectionFallback(
    method: 'thread/start' | 'thread/resume',
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const explicitlySelected = !!this.model || !!this.effort;
    try {
      return await this.request(method, params);
    } catch (error) {
      const reason = errMessage(error);
      // Go has no machine default to fall back to: dropping the model would send
      // config.toml's model to the Go endpoint, on a thread that cannot move away.
      if (this.onGo || !explicitlySelected || !selectionRejected(reason)) throw error;
      const rejected = [this.model, this.effort].filter(Boolean).join(' / ');
      this.handlers.onEvent({
        kind: 'status',
        code: 'model_error',
        text: `⚠ Codex rejected ${rejected || 'the selected settings'}; continuing on the machine default: ${reason}`,
      });
      this.model = undefined;
      this.effort = undefined;
      this.handlers.onRequestedSettingsChange?.({});
      const fallback = { ...params };
      delete fallback['model'];
      delete fallback['config'];
      return this.request(method, fallback);
    }
  }

  /** Consume start/resume responses and `thread/settings/updated`, whose
   * versions differ only in where they nest ThreadSettings. */
  private captureThreadSettings(source: Record<string, unknown> | undefined): void {
    const { model, effort } = codexThreadSettings(source);
    if (model) {
      this.baseModel = model;
      this.handlers.onActiveModel?.(model);
      if (this.model && model !== this.model && !this.modelMismatchWarned) {
        this.modelMismatchWarned = true;
        const requested = this.model;
        this.model = undefined;
        this.handlers.onRequestedSettingsChange?.({ effort: this.effort });
        this.handlers.onEvent({
          kind: 'status',
          code: 'model_error',
          text: `⚠ Codex reported ${model} after ${requested} was selected; the picker now shows the model actually running.`,
        });
      }
    }
    if (effort) this.baseEffort = effort;
    // Announced unconditionally, not only when the app-server volunteered a
    // level: see `announceEffort`.
    this.announceEffort();
  }

  /**
   * The level the NEXT turn will actually be started at.
   *
   * Single expression, used both to tell Codex and to tell the hub, because the
   * two disagreeing is the whole bug this exists to prevent.
   */
  private effectiveEffort(): string {
    return codexEffectiveEffort(this.effort, this.baseEffort);
  }

  /**
   * Say the level out loud.
   *
   * `captureThreadSettings` used to report only what `thread/start` volunteered,
   * and a machine whose `~/.codex/config.toml` names no `model_reasoning_effort`
   * volunteers nothing — so `activeEffort` never reached the hub, the composer's
   * slider had no value to place, and it parked its thumb on the first stop.
   * The session read «low» while the turn ran at `CODEX_FALLBACK_EFFORT`.
   *
   * Unlike Claude, Codex's level is KNOWN before the first turn — it is decided
   * here, not observed from a tool call — so there is no window in which the
   * honest answer is silence.
   *
   * Tied to `codexCollaborationMode` below: both take `effectiveEffort()`. Make
   * the fallback conditional in one and this starts lying.
   */
  private announceEffort(): void {
    this.handlers.onActiveEffort?.(this.effectiveEffort());
  }

  /** Adopt the thread id minted by `thread/start`. The result/notification shape
   *  varies by Codex version (`threadId`, `thread.id`, or `id`); take the first
   *  that lands and report it upstream exactly once. */
  private adoptThreadId(source: Record<string, unknown> | undefined): void {
    if (this.sessionId || !source) return;
    const thread = asRecord(source['thread']);
    const id =
      optionalString(source['threadId']) ??
      optionalString(thread?.['id']) ??
      optionalString(source['id']);
    if (!id) return;
    this.handlers.onSessionId?.(id);
    this.sessionId = id;
  }

  private async runNext(): Promise<void> {
    if (!this.ready || this.closed || this.dispatching || this.compacting) return;
    // Inputs arriving during turn/start wait only for its id, not completion.
    if (this.running && !this.activeTurnId) return;
    if (this.running && this.queue[0]?.waitForTurnId === this.activeTurnId) return;
    const turn = this.queue.shift();
    if (!turn) return;
    if (turn.steerOnly && !this.running) {
      void this.runNext();
      return;
    }

    const steerId = this.running ? this.activeTurnId : undefined;
    const generation = this.turnGeneration;
    this.dispatching = true;
    this.running = true;
    // Steering feeds input INTO the running turn, so none of this is a new
    // turn's state to reset: the usage counter, the command headers, the
    // outstanding question decisions and the held plan/handoff all belong to
    // the turn already in flight. Clearing them mid-steer is how a steered turn
    // loses its own answers.
    if (!steerId) {
      this.turnUsage.reset();
      this.cmdHeadered.clear();
      this.imageGenStarted.clear();
      this.imageGenSeen.clear();
      // Before turn/start: whatever the rollout holds now is old news.
      this.imageTail.begin();
      this.questionDecisions.clear();
      this.pendingPlan = undefined;
      this.proposedPlan = undefined;
      this.pendingHandoff = undefined;
      this.quotaNotice = undefined;
    }
    const input: Array<Record<string, unknown>> = [];

    // Writing the images has to happen INSIDE the try: it touches the disk
    // (mkdtemp + write), and a full or read-only tmpdir throws. Outside, that
    // throw escaped `void runNext()` with `running` already true — the queue
    // then held every later turn forever and the hub was told nothing at all.
    // A silent permanent stall is worse than a failed turn.
    try {
      if (turn.text) input.push({ type: 'text', text: turn.text });
      if (turn.images?.length) {
        // Confined: the sandbox's /tmp is private, so images go in the unit's bound dir.
        const imageBase = this.confineScratch ?? tmpdir();
        mkdirSync(imageBase, { recursive: true, mode: 0o700 });
        const imageDir = mkdtempSync(join(imageBase, 'ccr-codex-'));
        this.imageDirs.add(imageDir);
        turn.images.forEach((image, index) => {
          const ext = image.media_type.split('/')[1] || 'png';
          const path = join(imageDir, `img${index}.${ext}`);
          writeFileSync(path, Buffer.from(image.data, 'base64'));
          input.push({ type: 'localImage', path });
        });
      }
      if (!input.length) input.push({ type: 'text', text: '(continue)' });

      if (steerId) {
        await this.request('turn/steer', {
          threadId: this.sessionId, input, expectedTurnId: steerId,
        });
        return;
      }
      // A Go model the catalogue does not cover, but a shorter slug does, would
      // run with that model's window (opencode-go.ts goCatalogueMisfit).
      const turnModel = this.model || this.baseModel;
      if (goCatalogueMisfit(this.goCatalogue, turnModel)) {
        throw new Error(`${turnModel} appeared after this session started: start a new session for it.`);
      }
      this.handlers.onEvent({ kind: 'status', code: 'turn_started', text: '' });
      // Before the await, so a turn that never starts still reported the level
      // it was attempted at.
      this.announceEffort();
      const result = await this.request('turn/start', {
        threadId: this.sessionId,
        input,
        cwd: this.cwd,
        // Re-sent every turn, which is what makes a mid-session mode switch
        // real: the thread keeps the posture it was started with, the turn
        // carries the one in force now.
        ...this.turnPosture(),
        collaborationMode: codexCollaborationMode(
          this.permissionMode,
          this.model || this.baseModel,
          this.effectiveEffort(),
        ),
      });
      const turnResult = asRecord(result['turn']);
      // A fast turn may finish before its start response arrives. Never restore
      // a completed id or replace the id of a newer turn with that late reply.
      if (this.running && generation === this.turnGeneration) {
        this.activeTurnId = optionalString(turnResult?.['id']) ?? this.activeTurnId;
      }
    } catch (error) {
      if (this.closed || this.finishedWith) return;
      if (steerId) {
        if (turn.steerOnly) {
          // Its turn is gone; so is the reason to say it.
        } else if (error instanceof CodexRpcError) {
          // A definite rejection is safe to retry. Completion can race the RPC;
          // the serialized dispatcher starts a fresh turn if the old one ended.
          this.queue.unshift({ ...turn, waitForTurnId: steerId });
          this.handlers.onEvent({ kind: 'status', text: `Уточнение не вошло в текущий ход и будет отправлено следующим: ${errMessage(error)}` });
        } else {
          // A timeout has an unknown outcome. Replaying could duplicate input
          // already consumed by the model, so report it instead of guessing.
          this.handlers.onEvent({ kind: 'status', text: `Не удалось подтвердить доставку уточнения: ${errMessage(error)}. Проверьте ответ перед повторной отправкой.` });
        }
        return;
      }
      this.running = false;
      this.activeTurnId = undefined;
      this.imageTail.stop();
      this.cleanupImages();
      const reason = errMessage(error);
      if (this.refusedForQuota(reason)) return;
      this.handlers.onEvent({ kind: 'status', text: `⚠ turn failed to start: ${reason}` });
      this.handlers.onEvent({ kind: 'result', text: 'failed' });
    } finally {
      this.dispatching = false;
      if (!this.running || this.closed) this.cleanupImages();
      void this.runNext();
    }
  }

  /**
   * True when a failure needs no further narration: the run is already over
   * (closed by the manager, or failed earlier), or the gateway refused for
   * quota — in which case the run ends here with the machine-readable code
   * instead of a generic failure. The thread itself is untouched; it resumes
   * after the reset. False = an ordinary error, report it as before.
   */
  private refusedForQuota(reason: string): boolean {
    if (this.closed || this.finishedWith) return true;
    const code = classifyModelError(reason) ?? classifyModelError(this.quotaNotice);
    if (!code) return false;
    console.warn(`[agent] codex model call refused for quota: ${this.quotaNotice ?? reason}`);
    this.abort(BUDGET_EXHAUSTED_TEXT, code);
    return true;
  }

  private onLine(line: string): void {
    const raw = line.trim();
    if (!raw || raw[0] !== '{') return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = message['id'];
    const method = message['method'];
    if ((typeof id === 'string' || typeof id === 'number') && typeof method !== 'string') {
      const pending = this.pendingRpc.get(String(id));
      if (!pending) return;
      this.pendingRpc.delete(String(id));
      clearTimeout(pending.timer);
      const error = asRecord(message['error']);
      if (error) pending.reject(new CodexRpcError(stringValue(error['message']) || 'Codex request failed'));
      else pending.resolve(asRecord(message['result']) ?? {});
      return;
    }

    if (typeof method !== 'string') return;
    // A run that already ended (or was closed) must not keep narrating: the
    // manager has dropped it, and a late `turn/completed` would report an idle
    // for a run that no longer exists.
    if (this.closed || this.finishedWith) return;
    const params = asRecord(message['params']) ?? {};
    // A notification from a turn that already ended narrates nothing the
    // person is waiting on (see `endedTurns`). Server REQUESTS still go
    // through: an approval must be answered, whatever turn raised it.
    if (typeof id !== 'string' && typeof id !== 'number') {
      // Codex sub-agents are separate threads whose turns are narrated on this
      // same pipe. Their `turn/started` would replace `activeTurnId` and their
      // `turn/completed` would end OUR turn while it is still running (30.09.2026:
      // the session read idle mid-task). Only this thread's notifications count;
      // until the thread id is known (a fresh `thread/start`) nothing is foreign.
      // `thread/started` names its thread inside `thread`: a child's would
      // otherwise pass as ours and overwrite the session's model with its own.
      const threadId =
        optionalString(params['threadId']) ??
        (method === 'thread/started' ? optionalString(asRecord(params['thread'])?.['id']) : undefined);
      if (threadId && this.sessionId && threadId !== this.sessionId) {
        // Not ours, so it cannot touch our turn — but a child's narration is
        // what its card says («сейчас: …», tokens, how it ended).
        try { this.subagents.childNotification(threadId, method, params); }
        catch (error) { console.warn(`[agent] codex sub-agent notice ignored: ${errMessage(error)}`); }
        return;
      }
      if (this.isEndedTurnNotice(method, params)) return;
    }
    if (typeof id === 'string' || typeof id === 'number') {
      // A reply that cannot be written (the app-server died mid-approval) used
      // to surface as an unhandled rejection and leave its request unanswered;
      // `fail` is idempotent and a no-op once the run is closed.
      this.onServerRequest(id, method, params).catch((error) => this.fail(error));
    } else {
      // Persisting a new session's origin may fail (disk full, permissions).
      // A notification arrives outside start()'s try/catch: fail closed here
      // before its later RPC response can make the run ready for user input.
      try { this.onNotification(method, params); }
      catch (error) { this.fail(error); }
    }
  }

  private async onServerRequest(id: RpcId, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'item/tool/requestUserInput') {
      const questions = normalizeCodexQuestions(params['questions']);
      const itemId = stringValue(params['itemId']);
      try {
        const decide = () =>
          this.handlers.approveTool
            ? this.handlers.approveTool({
                tool: 'AskUserQuestion',
                input: { questions },
                toolUseID: itemId || String(id),
                title: 'Codex needs your input',
              })
            : Promise.resolve<ToolApprovalDecision>({
                allow: false,
                message: 'No interactive client is connected.',
              });
        const decision = await this.decideOnce(itemId, decide);
        this.respond(id, { answers: encodeCodexAnswers(questions, decision) });
      } catch (error) {
        this.respond(id, { answers: encodeCodexAnswers(questions, { allow: false, message: errMessage(error) }) });
      }
      return;
    }

    const approval = codexApprovalRequest(method, params);
    if (approval) {
      const itemId = stringValue(params['itemId']);
      // The SAME `tool_request`/`tool_decision` pair Claude approvals ride, on
      // purpose: the hub, the browser, iOS and Telegram all already carry it. A
      // Codex-only message would have given approvals to the browser and a
      // silent refusal to everyone holding a phone.
      const decide = () =>
        this.handlers.approveTool
          ? this.handlers.approveTool({
              tool: approval.tool,
              input: approval.input,
              toolUseID: itemId || String(id),
              title: approval.title,
            })
          : // Nobody is watching, so nobody can consent. Refusing is the only
            // answer that cannot act on somebody's behalf without them.
            Promise.resolve<ToolApprovalDecision>({
              allow: false,
              message: 'No interactive client is connected.',
            });
      try {
        const decision = await this.decideOnce(itemId, decide);
        this.respond(id, { decision: pickCodexDecision(params['availableDecisions'], decision.allow) });
      } catch (error) {
        this.handlers.onEvent({
          kind: 'status',
          code: 'tool_error',
          text: `⚠ approval failed, refusing: ${errMessage(error)}`,
        });
        this.respond(id, { decision: pickCodexDecision(params['availableDecisions'], false) });
      }
      return;
    }

    // Anything still unknown. Respond explicitly rather than ignoring it: our
    // own RPC_TIMEOUT_MS bounds only OUR outbound calls, so a server request
    // left unanswered hangs the turn with nothing to time it out.
    this.respondError(id, -32601, `Unsupported Codex server request: ${method}`);
  }

  /**
   * One decision per `itemId`, however many times it is asked.
   *
   * The app-server re-delivers a pending request with a fresh JSON-RPC id (on
   * reconnect, and after some turn transitions). `itemId` is the stable one, so
   * every delivery awaits the SAME promise: one modal for the human, one answer
   * back. Without a stable id there is nothing to key on and the request is
   * answered on its own.
   */
  private decideOnce(
    itemId: string,
    make: () => Promise<ToolApprovalDecision>,
  ): Promise<ToolApprovalDecision> {
    if (!itemId) return make();
    const held = this.questionDecisions.get(itemId);
    if (held) return held;
    const pending = make();
    this.questionDecisions.set(itemId, pending);
    return pending;
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'thread/started':
        // Fallback id source for a brand-new thread when the RPC result omits it.
        this.adoptThreadId(params);
        this.captureThreadSettings(params);
        break;
      case 'thread/settings/updated':
        this.captureThreadSettings(params);
        break;
      case 'turn/started': {
        const turn = asRecord(params['turn']);
        this.activeTurnId = optionalString(turn?.['id']) ?? this.activeTurnId;
        void this.runNext();
        break;
      }
      case 'item/started':
        this.onItem(asRecord(params['item']), false);
        break;
      case 'item/completed':
        this.onItem(asRecord(params['item']), true);
        break;
      case 'turn/plan/updated': {
        const plan = Array.isArray(params['plan']) ? params['plan'] : [];
        const rendered = plan
          .map((item) => {
            const step = asRecord(item);
            return step ? `${step['status'] === 'completed' ? '✓' : '○'} ${stringValue(step['step'])}` : '';
          })
          .filter(Boolean)
          .join('\n');
        if (rendered) {
          this.handlers.onEvent({ kind: 'status', code: 'plan_update', text: rendered, raw: params });
        }
        break;
      }
      case 'turn/completed':
        this.finishTurn(asRecord(params['turn']) ?? {});
        break;
      // The context meter's only source. Codex pushes this after every request
      // rather than answering a query, so the run remembers the last reading and
      // `contextUsage()` hands it over when the agent's poll comes round.
      case 'thread/tokenUsage/updated': {
        const reading = parseCodexTokenUsage(asRecord(params['tokenUsage']));
        if (reading) this.tokens = reading;
        if (this.running && !this.compacting && (!this.activeTurnId || !params['turnId'] || params['turnId'] === this.activeTurnId)) {
          const totalTokens = this.turnUsage.receive(params['tokenUsage']);
          if (totalTokens !== undefined) this.handlers.onEvent({ kind: 'status', code: 'turn_usage', text: '', data: { totalTokens } });
        }
        break;
      }
      case 'error': {
        const text = errMessage(params['error'] ?? params['message']);
        // Remembered, not acted on: Codex retries a 429 itself and the turn
        // may still succeed. If it fails instead, finishTurn knows why.
        if (classifyModelError(text)) this.quotaNotice = text;
        this.handlers.onEvent({ kind: 'status', text: `⚠ ${text}` });
        break;
      }
      default:
        break;
    }
  }

  private onItem(item: Record<string, unknown> | undefined, completed: boolean): void {
    if (!item) return;
    const kind = stringValue(item['type']);
    const id = stringValue(item['id']);
    switch (kind) {
      case 'agentMessage':
        if (completed && typeof item['text'] === 'string') {
          const text = item['text'] as string;
          if (text.trimStart().startsWith('## Handoff summary')) {
            this.pendingHandoff = text;
            break;
          }
          // A normal message after a held handoff proves the latter was the
          // compactor talking to the replacement model, not to the user.
          this.pendingHandoff = undefined;
          // The final AgentMessage commonly wraps the Plan in
          // `<proposed_plan>` and a short preface. It supersedes the held
          // structured item; earlier commentary does not.
          if (this.pendingPlan && text.includes(this.pendingPlan)) this.pendingPlan = undefined;
          const proposed = extractProposedPlan(text);
          if (proposed) this.proposedPlan = proposed;
          this.handlers.onEvent({ kind: 'assistant', text, raw: item });
        }
        break;
      case 'plan':
        if (completed && typeof item['text'] === 'string') {
          this.pendingHandoff = undefined;
          this.pendingPlan = item['text'] as string;
          this.proposedPlan = this.pendingPlan;
        }
        break;
      case 'reasoning':
        if (completed) {
          const summary = stringArray(item['summary']).join('\n') || stringArray(item['content']).join('\n');
          if (summary) this.handlers.onEvent({ kind: 'status', text: `💭 ${truncate(summary, 800)}`, raw: item });
        }
        break;
      case 'commandExecution': {
        if (!this.cmdHeadered.has(id)) {
          this.cmdHeadered.add(id);
          this.handlers.onEvent({ kind: 'tool_use', text: `$ ${cleanCmd(stringValue(item['command']))}`, raw: item });
        }
        if (completed) {
          const output = truncate(stringValue(item['aggregatedOutput']), OUTPUT_CAP);
          const status = stringValue(item['status']) || '?';
          // This is the command's stdout/verdict, not something the agent said.
          // The web groups `command_output` with the preceding tool call, so a
          // bare «→ completed» / «→ failed» never becomes a transcript row.
          this.handlers.onEvent({
            kind: 'status',
            code: 'command_output',
            text: `${output}${output ? '\n' : ''}→ ${status}`,
            raw: item,
          });
        }
        break;
      }
      case 'fileChange': {
        if (!completed) break;
        const changes = Array.isArray(item['changes']) ? item['changes'] : [];
        const paths = changes
          .map((change) => stringValue(asRecord(change)?.['path']))
          .filter(Boolean)
          .join(', ');
        this.handlers.onEvent({ kind: 'tool_use', text: `edit ${paths || '(files)'}`, raw: item });
        break;
      }
      case 'imageGeneration':
        // Already announced and finished from the rollout: nothing new.
        if (this.imageGenSeen.has(id) && !this.imageGenStarted.has(id)) break;
        this.onImageGeneration(item, id, completed);
        break;
      case 'webSearch':
        if (completed) this.handlers.onEvent({ kind: 'tool_use', text: `web_search: ${stringValue(item['query'])}`, raw: item });
        break;
      case 'mcpToolCall':
      case 'dynamicToolCall':
        if (completed) this.handlers.onEvent({ kind: 'tool_use', text: `mcp: ${stringValue(item['tool'])}`, raw: item });
        break;
      // Cards, not transcript rows: the child's words stay in its own thread.
      case 'subAgentActivity':
      case 'collabAgentToolCall':
        this.subagents.parentItem(item);
        break;
      default:
        break;
    }
  }

  /**
   * Codex's built-in `image_gen` tool as an `image_gen` status event (one card
   * per item id; the id is the response item's `ig_…`, the same one the
   * rollout's `image_generation_call` carries, so `gen:<id>` is what
   * `loadCodexImage` finds). The bytes never ride the stream: `result` is a
   * 1-3 MB base64 PNG, the client fetches it.
   *
   * codex-cli 0.164 reality (live, 24.10.2026): the app-server emits NO
   * `item/started` / `item/completed` of type `imageGeneration` — this method
   * is reached from `onItem` only if a future Codex does. Today the picture
   * exists only as a rollout `response_item`, which `imageTail` follows during
   * the turn and feeds to `onRolloutImage` (started and done together: the line
   * is written once the picture is finished, so the card is brief). The
   * per-turn `imageGenSeen` keeps the two sources from announcing one id twice.
   */
  private onImageGeneration(item: Record<string, unknown>, id: string, completed: boolean): void {
    if (!id) return;
    this.imageGenSeen.add(id);
    const prompt = optionalString(item['revisedPrompt'])?.trim().slice(0, 4000);
    const promptField = prompt ? { prompt } : {};
    if (!completed) {
      if (this.imageGenStarted.has(id)) return; // a repeated started carries nothing new
      const startedAt = Date.now();
      this.imageGenStarted.set(id, startedAt);
      this.handlers.onEvent(imageGenEvent({ id, state: 'started', startedAt, ...promptField }));
      return;
    }
    const startedAt = this.imageGenStarted.get(id) ?? Date.now();
    this.imageGenStarted.delete(id);
    const base = { id, startedAt, ...promptField };
    const status = stringValue(item['status']);
    const failure = asRecord(item['failure']);
    // Only inline `result` can be shown: the loader serves nothing else from the rollout.
    const hasInline = Boolean(optionalString(item['result']));
    const savedOnly = !hasInline && Boolean(optionalString(item['savedPath']) || optionalString(item['fileId']));
    if (failure || (status !== 'completed' && status !== 'success') || !hasInline) {
      let error = status && status !== 'failed' ? `статус ${status}` : 'генерация не удалась';
      if (!failure && savedOnly && (status === 'completed' || status === 'success')) error = 'картинка сохранена, но показать её нельзя';
      if (stringValue(failure?.['type']) === 'usageLimitExceeded') {
        const resetsAt = failure?.['resetsAt'];
        error =
          typeof resetsAt === 'number'
            ? `лимит генерации исчерпан — сброс ${new Date(resetsAt * 1000).toLocaleString('ru-RU')}`
            : 'лимит генерации исчерпан';
      }
      this.handlers.onEvent(imageGenEvent({ ...base, state: 'failed', error }));
      return;
    }
    this.handlers.onEvent(imageGenEvent({ ...base, state: 'done', ref: `gen:${id}` }));
  }

  /** One `image_generation_call` the rollout tail found: started, then done/failed at once. */
  private onRolloutImage(payload: Record<string, unknown>): void {
    const id = optionalString(payload['id']);
    if (!id || this.imageGenSeen.has(id)) return;
    const item = {
      id,
      status: optionalString(payload['status']) ?? '',
      revisedPrompt: payload['revised_prompt'],
      result: payload['result'],
    };
    this.onImageGeneration(item, id, false);
    this.onImageGeneration(item, id, true);
  }

  /** The rollout of this thread for the tail: known from resume, else found once the thread exists. */
  private async resolveRollout(): Promise<string | null> {
    if (this.rolloutPath) return this.rolloutPath;
    if (!this.sessionId) return null;
    // A miss is a full scan of the machine's rollouts: at most one per 5 s, not
    // one per tick per running session (the «starved by its own sessions» trap).
    if (Date.now() - this.lastRolloutScan < 5_000) return null;
    this.lastRolloutScan = Date.now();
    const path = await findCodexTranscript(this.sessionId, this.cwd);
    if (!path) return null;
    try {
      if (this.confineHome) assertRolloutInUnit(path, this.confineHome);
    } catch {
      return null;
    }
    this.rolloutPath = path;
    return path;
  }

  /**
   * True for a notification that belongs to a turn already over: its
   * `turnId` is one `finishTurn` closed. An `item/*` is also judged against
   * the live turn — with one known, any other id is stale; with none running,
   * dispatching or compacting, nothing can be live.
   */
  private isEndedTurnNotice(method: string, params: Record<string, unknown>): boolean {
    if (method === 'turn/completed') {
      const id = optionalString(asRecord(params['turn'])?.['id']);
      return Boolean(id && this.endedTurns.includes(id));
    }
    const turnId = optionalString(params['turnId']);
    if (turnId && this.endedTurns.includes(turnId)) return true;
    if (!method.startsWith('item/')) return false;
    // A known live turn: an item under any other id is a leftover whose turn
    // has already rolled out of `endedTurns`. Forwarded, it would read as a
    // fresh `tool_use` (the command headers are reset per turn) and re-open
    // the run exactly like the bug this guards against.
    if (turnId && this.activeTurnId) return turnId !== this.activeTurnId;
    // No id known yet: before `turn/started` the dispatch flag carries it.
    return !this.running && !this.dispatching && !this.compacting;
  }

  private finishTurn(turn: Record<string, unknown>): void {
    const id = optionalString(turn['id']);
    if (id && this.activeTurnId && id !== this.activeTurnId) return;
    if (id) {
      this.endedTurns.push(id);
      if (this.endedTurns.length > ENDED_TURNS_KEPT) this.endedTurns.shift();
    }
    this.turnGeneration += 1;
    // Synchronous on purpose: turn completion is the run's core path and must
    // not wait on a file read. A picture written in the last tick before the
    // turn ended is not announced live — the history reload that follows
    // every turn end shows it a moment later.
    this.imageTail.stop();
    // A picture still «started» when its turn ends never gets item/completed
    // (the turn was interrupted): close the card instead of leaving it crawling.
    this.abandonImageGen();
    const status = stringValue(turn['status']) || 'completed';
    const wasCompacting = this.compacting;
    // Codex runs compaction AS a turn (see `compact`), so the turn that ends
    // right after `thread/compact/start` is the compaction's verdict.
    if (this.compacting) {
      this.compacting = false;
      if (status === 'failed') {
        const reason = errMessage(asRecord(turn['error'])?.['message']);
        this.handlers.onEvent({ kind: 'status', code: 'compact_failed', text: `⚠ compaction failed: ${reason}`, raw: turn });
      } else {
        this.handlers.onEvent({ kind: 'status', code: 'compact_done', text: 'context compacted', raw: turn });
      }
    }
    if (status === 'failed') {
      const error = asRecord(turn['error']);
      const reason = errMessage(error?.['message']);
      if (this.refusedForQuota(reason)) return;
      this.handlers.onEvent({ kind: 'status', code: 'turn_failed', text: `⚠ turn failed: ${reason}`, raw: turn });
      this.handlers.onEvent({ kind: 'result', text: 'failed', raw: turn });
    } else {
      if (this.pendingHandoff && !wasCompacting) {
        this.handlers.onEvent({ kind: 'assistant', text: this.pendingHandoff, raw: turn });
      }
      if (this.pendingPlan) {
        this.handlers.onEvent({ kind: 'assistant', text: this.pendingPlan, raw: turn });
      }
      this.handlers.onEvent({ kind: 'result', text: status === 'interrupted' ? 'interrupted' : 'done', raw: turn });
      // The person has the floor — the cue for the suggestion strip. Not after
      // an interruption (they stopped it; they know what they want next) and
      // not after a compaction, which ran as a turn but said nothing.
      if (status === 'completed' && !wasCompacting) {
        this.handlers.onEvent({ kind: 'status', code: 'turn_settled', text: '' });
      }
      // Not when the next turn is already queued: the person spoke past the
      // plan, and a card nothing would clear could later accept a stale one.
      if (status === 'completed' && !wasCompacting && this.permissionMode === 'plan' && this.proposedPlan) {
        const plan = this.proposedPlan;
        // A tick later, once a rejected steer has been re-queued and started.
        setImmediate(() => {
          if (this.closed || this.running || this.queue.length || this.permissionMode !== 'plan') return;
          void this.offerPlan(plan);
        });
      }
    }
    this.running = false;
    this.activeTurnId = undefined;
    this.questionDecisions.clear();
    this.pendingPlan = undefined;
    this.proposedPlan = undefined;
    this.pendingHandoff = undefined;
    // Not while another turn is being dispatched: its images are already
    // written into the same directory this would delete.
    if (!this.dispatching) this.cleanupImages();
    void this.runNext();
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRpc.delete(String(id))) reject(new Error(`${method} timed out`));
      }, RPC_TIMEOUT_MS);
      timer.unref();
      this.pendingRpc.set(String(id), { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pendingRpc.delete(String(id));
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.write(params ? { method, params } : { method });
  }

  private respond(id: RpcId, result: Record<string, unknown>): void {
    this.reply({ id, result });
  }

  private respondError(id: RpcId, code: number, message: string): void {
    this.reply({ id, error: { code, message } });
  }

  /** An answer to a server request. After `close()` there is nobody to answer —
   *  the app-server is being terminated — so a late reply is dropped rather
   *  than thrown: the refuse-on-failure branches in `onServerRequest` reply
   *  from a catch block, and a throw there was a second, unhandled failure. A
   *  reply that fails while the run is still open propagates to the caller. */
  private reply(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.write(message);
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable || this.closed) throw new Error('codex app-server is not writable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: unknown): void {
    if (error instanceof CodexNotFound) {
      // Name the fix, not the syscall. «spawn codex ENOENT» told nobody that
      // the CLI was installed under nvm where a LaunchAgent cannot see it.
      this.abort(
        `codex не найден на машине (${describeSearch({ searched: error.searched, ...(error.envHint ? { envHint: error.envHint } : {}) })}) — ` +
          'установите его: npm install -g @openai/codex, либо укажите путь в CODEX_BIN в окружении агента',
      );
      return;
    }
    const reason = errMessage(error);
    // The app-server can die on a refused request too (a 429 on thread/start).
    if (this.refusedForQuota(reason)) return;
    this.abort(`codex app-server failed: ${reason}`);
  }

  /** End the run with an `error` event. Idempotent; the manager closes us. */
  /** Close every picture still «started»: its turn or run is over, so no
   *  item/completed will come. Idempotent. */
  private abandonImageGen(): void {
    for (const [genId, startedAt] of this.imageGenStarted) {
      this.handlers.onEvent(imageGenEvent({ id: genId, state: 'failed', startedAt, error: 'генерация прервана' }));
    }
    this.imageGenStarted.clear();
  }

  private abort(text: string, code?: string): void {
    if (this.closed || this.finishedWith) return;
    this.imageTail.stop();
    this.abandonImageGen();
    // Say it on the machine too, not only to whoever happens to be watching.
    // This path is how a Codex run dies, and it used to write NOTHING to the
    // journal: the person saw a red line, the box looked perfectly healthy, and
    // there was no way to find out afterwards what had happened. The stderr tail
    // is already folded into `text` by `fail`, so this one line carries the
    // actual cause.
    console.error(
      `[agent] codex run aborted (session ${this.sessionId || 'new'}${code ? `, ${code}` : ''}): ${text}`,
    );
    this.finishedWith = 'error';
    this.ready = false;
    this.running = false;
    this.activeTurnId = undefined;
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(text));
    }
    this.pendingRpc.clear();
    this.cleanupImages();
    this.subagents.close();
    const outcomeCode = !this.sessionId && !this.threadCreationAttempted ? 'session_not_created' : code;
    this.handlers.onEvent({ kind: 'error', text, fatal: true, ...(outcomeCode ? { code: outcomeCode } : {}) });
    this.resolveCompleted();
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurnId || !this.ready) return;
    await this.request('turn/interrupt', { threadId: this.sessionId, turnId: this.activeTurnId });
  }

  /**
   * Stop one sub-agent: interrupt the CHILD thread's turn — the same
   * `turn/interrupt` the parent's stop uses, with the child's thread id, which
   * is how Codex's own TUI stops a sub-agent it is showing. The parent's turn
   * and the other children go on.
   *
   * The child's turn id comes from its `turn/started`. When it is not known,
   * or has moved on, Codex refuses with «expected active turn id A but found
   * B» and the one retry uses B (the TUI does the same).
   */
  async stopSubagent(id: string): Promise<boolean> {
    if (!this.subagents.isRunning(id) || !this.ready || this.closed) return false;
    let turnId = this.subagents.activeTurn(id) ?? '';
    for (let attempt = 0; ; attempt++) {
      try {
        await this.request('turn/interrupt', { threadId: id, turnId });
        break;
      } catch (error) {
        const actual = attempt === 0 ? interruptRaceTurnId(errMessage(error)) : undefined;
        if (!actual || actual === turnId) throw error;
        turnId = actual;
      }
    }
    const name = this.subagents.snapshot().find((a) => a.id === id)?.description;
    this.subagents.stopped(id);
    // Codex does not tell the parent: a v2 parent blocked in `wait_agent`
    // keeps waiting out its timeout (120 s, then again) for a child that will
    // never answer — measured live 10.10.2026, codex-cli 0.162.1. A steer
    // wakes it at once. Only into a live turn: an idle parent must not be
    // started by this.
    if (this.running && this.activeTurnId) {
      this.queue.push({ text: codexSubagentStoppedNote(name), steerOnly: true });
      void this.runNext();
    }
    return true;
  }

  /** A child's nickname / role: codex-cli 0.162 announces children with no
   *  `thread/started`, so ask. Best effort — the card already stands. */
  private async nameSubagent(id: string): Promise<void> {
    if (!this.ready || this.closed) return;
    try {
      const read = await this.request('thread/read', { threadId: id, includeTurns: false });
      const thread = asRecord(read['thread']);
      if (thread && !this.closed) this.subagents.childNotification(id, 'thread/started', { thread });
    } catch {
      /* an older app-server without thread/read: the card keeps its default name */
    }
  }

  /**
   * Context budget, from the `thread/tokenUsage/updated` notifications above.
   * Undefined until the thread has made at least one request — a freshly
   * resumed session has no reading yet, and a blank meter beats a made-up zero.
   */
  async contextUsage(): Promise<ContextUsage | undefined> {
    if (!this.tokens) return undefined;
    return codexContextUsage(this.tokens, this.model || this.baseModel);
  }

  /**
   * Compact the thread's context — Codex's own operation (`thread/compact/start`),
   * not a slash command typed into the conversation like the Claude path.
   *
   * Two things are worth stating plainly, because both names mislead:
   *
   * 1. Codex runs compaction AS A TURN — verified against codex-cli 0.144.1,
   *    which emits `turn/started` / `turn/completed` around it. So the run goes
   *    busy for a moment and `finishTurn` reports a result, exactly as if the
   *    user had asked for something. That is why we announce it first; an
   *    unexplained turn nobody started is worse than a slow one.
   * 2. It shrinks what the MODEL carries into the next turn. The rollout on disk
   *    is append-only and keeps growing regardless, so compaction does NOT
   *    postpone the transcript-size wall in `run-manager.ts`. One is about
   *    thinking room, the other about the file.
   */
  async compact(): Promise<void> {
    if (!this.ready || !this.sessionId) {
      throw new Error('the Codex thread is not ready yet — try again in a moment');
    }
    // Same codes as the Claude path (`compact_started` → `compact_done` /
    // `compact_failed`), because the client keys its «Сжимаю…» state on them.
    // Codex used to say only «compacting context…» and nothing at the end, so
    // the button stayed pending until its 15-minute net on every Codex session.
    this.compacting = true;
    this.handlers.onEvent({ kind: 'status', code: 'compact_started', text: 'compacting context…' });
    try {
      await this.request('thread/compact/start', { threadId: this.sessionId });
    } catch (error) {
      this.compacting = false;
      void this.runNext();
      throw error;
    }
  }

  async setModel(model?: string): Promise<void> {
    // A thread keeps the provider it started on (opencode-go.ts). Refused rather
    // than accepted, or every later turn would fail against the wrong endpoint.
    if (isGoModel(model) && !this.onGo) {
      throw new Error('OpenCode Go models need a new session.');
    }
    if (model && !isGoModel(model) && this.onGo) {
      throw new Error('This session runs on OpenCode Go: pick a Go model or start a new session.');
    }
    // Early word only: the app-server may still be starting, so runNext checks
    // again against the catalogue it was actually given.
    if (goCatalogueMisfit(this.goCatalogue, model)) {
      throw new Error(`${model} appeared after this session started: start a new session for it.`);
    }
    this.model = model || undefined;
    this.modelMismatchWarned = false;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Same refusal, same words as the Claude side: a mode this machine does not
    // offer is an error the client shows, not a silent downgrade.
    if (mode === 'bypassPermissions' && !codexBypassAllowed()) {
      throw new Error('This machine does not allow running without approval prompts.');
    }
    // Kept whole. Both halves of what it means — the approval policy and the
    // sandbox — ride on the NEXT `turn/start`, so the switch is real without a
    // new thread and without a lie in between.
    if (mode === 'plan' && this.permissionMode !== 'plan') this.modeBeforePlan = this.permissionMode;
    this.permissionMode = mode;
    this.handlers.onModeChange?.(this.permissionMode);
  }

  /**
   * Put the proposed plan in front of the person as the plan card Claude's
   * `ExitPlanMode` already raises on every client, and act on the answer.
   *
   * Codex cannot leave plan mode on its own: its plan-mode instructions forbid
   * treating «implement it» as consent, and the switch is the CLIENT's
   * (`collaborationMode` on the next `turn/start`). Codex's own UI asks
   * «Implement this plan?» at this point; cc-remote asked nothing, so a plan
   * turn ended in plain text and every «реализуй» that followed was answered
   * with «I am in Plan Mode» (29.09.2026) — the only way out was a switch
   * buried in the model menu.
   *
   * Asked AFTER the turn's `result`, never before it: the turn really is over,
   * and an idle arriving after the card would clear the card on the hub.
   */
  private async offerPlan(plan: string): Promise<void> {
    const approve = this.handlers.approveTool;
    if (!approve || this.closed) return;
    const offer = ++this.planOffer;
    let decision: ToolApprovalDecision;
    try {
      decision = await approve({
        tool: 'ExitPlanMode',
        input: { plan },
        toolUseID: `codex-plan-${offer}`,
        title: 'Codex предлагает план',
        afterTurn: true,
      });
    } catch {
      return;
    }
    // Walked past (a new message went out instead), or no longer in plan.
    if (offer !== this.planOffer || this.closed || this.permissionMode !== 'plan') return;
    if (!decision.allow) return;
    try {
      await this.setPermissionMode(codexModeAfterPlan(decision.permissionMode, this.modeBeforePlan));
    } catch {
      // A mode this box withholds (bypass) — the asking one is always offered.
      await this.setPermissionMode('default');
    }
    this.handlers.onEvent({ kind: 'status', code: 'plan_accepted', text: 'План принят — Codex приступает к реализации.' });
    // What Codex's own client sends on «Implement this plan».
    this.sendInput(CODEX_IMPLEMENT_PLAN);
  }

  async setEffort(effort?: 'low' | 'medium' | 'high' | 'xhigh', ultracode?: boolean): Promise<void> {
    this.effort = ultracode ? 'xhigh' : effort || undefined;
    // Clearing the pin is also a change of the effective level — it falls back
    // to the machine's config — so this reports in both directions.
    this.announceEffort();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.queue.length = 0;
    this.imageTail.stop();
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex run closed'));
    }
    this.pendingRpc.clear();
    this.cleanupImages();
    this.subagents.close();
    // SIGTERM asks; it does not guarantee. Dropping the handle here left a
    // surviving app-server writing the same rollout while the manager already
    // reported the run ended — the one thing the single-writer rule forbids.
    // Keep the handle until the process confirms it is gone, and escalate.
    const child = this.child;
    if (child) {
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) {
        const killer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        killer.unref();
        child.once('exit', () => clearTimeout(killer));
        // `exited` settles from the process itself (`exit`/`close` handlers set
        // at spawn) and from nothing else: a process that survives SIGKILL is
        // stuck in a write or a zombie, and guessing it gone is exactly the
        // second writer this exists to prevent. RunManager bounds its WAIT on
        // this and refuses the resume when the bound passes — it never proceeds.
      } else {
        this.resolveExited();
      }
    } else {
      this.resolveExited();
    }
    this.child = undefined;
    if (!this.finishedWith) this.finishedWith = 'end';
    this.resolveCompleted();
  }

  private cleanupImages(): void {
    for (const dir of this.imageDirs) rmSync(dir, { recursive: true, force: true });
    this.imageDirs.clear();
  }
}

/** What the parent's turn is told when the person stops one of its
 *  sub-agents (see `stopSubagent`). */
export function codexSubagentStoppedNote(name?: string): string {
  return `[Hegai Code] Пользователь остановил помощника${name ? ` «${name}»` : ''}. Его ответа не будет — не жди его, продолжай без него.`;
}

/** One context reading: tokens carried into the last request, and the window. */
export interface CodexTokenReading {
  used: number;
  window: number;
}

/**
 * Read a `thread/tokenUsage/updated` payload.
 *
 * `last` is the size of the most recent request — how full the context window
 * actually is right now. `total` is the thread's LIFETIME spend and runs into
 * tens of millions on a long session (one session on this fleet reached 57M);
 * metering that against a 258k window would read as 22000% full. Picking the
 * wrong one of the two is the entire risk in this function, hence the test.
 *
 * Shape verified against codex-cli 0.144.1:
 *   {threadId, turnId, tokenUsage: {total{…}, last{totalTokens,…}, modelContextWindow}}
 */
export function parseCodexTokenUsage(
  usage: Record<string, unknown> | undefined,
): CodexTokenReading | undefined {
  if (!usage) return undefined;
  const last = asRecord(usage['last']);
  const used = Number(last?.['totalTokens']);
  const window = Number(usage['modelContextWindow']);
  if (!Number.isFinite(used) || !Number.isFinite(window)) return undefined;
  if (window <= 0 || used < 0) return undefined;
  return { used, window };
}

/**
 * Turn a reading into the shape the meter speaks.
 *
 * `autoCompactEnabled: false` is a statement about cc-remote, and it is true:
 * nothing here compacts a Codex thread on its own. It makes the meter warn from
 * 85% and the tooltip read "auto-compact off" — which is exactly what a person
 * needs to know before the window fills, rather than a comforting promise that
 * something will handle it.
 */
/**
 * Context windows the app-server's own catalogue does not carry correctly.
 *
 * `~/.codex/models_cache.json` is fetched from `chatgpt.com/backend-api/codex`,
 * NOT from the configured provider — so a model reached through the gateway
 * (`model_provider = "hegai"`) never enters it, and on this fleet the cache is
 * frozen at the day the account last spoke to ChatGPT directly. For a model it
 * does not know, the app-server falls back to the gpt-5.x family default and
 * reports `modelContextWindow: 258400` — 272000 × its 95% safety margin.
 *
 * For the GPT-5.6 and GPT-6 lines that is wrong by a factor of four, and wrong
 * in the direction that hurts: the composer warned «Контекст 91%» at roughly
 * 23% of the real window, which is exactly when someone reaches for «Сжать
 * контекст» and throws away a transcript that had plenty of room.
 *
 * The value stored is the documented MAXIMUM INPUT, which is what a meter
 * answering «how much room is left» needs — the reply's 128,000 tokens are not
 * room the transcript may take. The GPT-5.6 and GPT-6 lines publish the same
 * three figures (developers.openai.com/api/docs/models/gpt-5.6-{sol,terra,luna}
 * and /gpt-6-{astra,sol,luna}):
 * «1,050,000 context window», «922,000» max input, «128,000 max output».
 *
 * GPT-6.1 Sol has the same stale 258400 reading on codex-cli 0.165.0
 * (29.10.2026). Its gateway route accepted 921,832 input tokens plus 5 output
 * tokens and refused a request near 922,000 input tokens. Use the same 922k
 * input budget here; see deploy/CAPABILITIES.md §3.5 for the measured bounds.
 * This is distinct from its documented 500k default in native Codex.
 *
 * ONLY models proven missing or stale in the catalogue belong here. GPT-5.6 Sol
 * was still reported as 258400 on 28.09.2026; the whole GPT-6 line was missing
 * when checked on 23.09.2026. Only replace that known fallback: an explicit
 * smaller window or a refreshed catalogue must keep the app-server's answer.
 */
const CODEX_MAX_INPUT: Record<string, number> = {
  'gpt-5.6': 922_000,
  'gpt-5.6-sol': 922_000,
  'gpt-5.6-terra': 922_000,
  'gpt-5.6-luna': 922_000,
  'gpt-6-astra': 922_000,
  'gpt-6-sol': 922_000,
  'gpt-6-luna': 922_000,
  'gpt-6.1-sol': 922_000,
};

/**
 * Correct the known stale catalogue fallback, retaining any other runtime
 * window (including native Codex's smaller default or a configured override).
 */
export function codexWindowFor(model: string | undefined, reported: number): number {
  if (reported !== 258_400) return reported;
  return (model ? CODEX_MAX_INPUT[model] : undefined) ?? reported;
}

export function codexContextUsage(reading: CodexTokenReading, model?: string): ContextUsage {
  const { used } = reading;
  const window = codexWindowFor(model, reading.window);
  return {
    totalTokens: used,
    maxTokens: window,
    percentage: Math.min(100, Math.round((used / window) * 100)),
    autoCompactEnabled: false,
    ...(model ? { model } : {}),
  };
}

/**
 * A command/patch approval the app-server is asking for, named for the UI.
 *
 * Returns `undefined` for anything that is not an approval, so the caller can
 * keep answering unknown methods with -32601 rather than swallowing them.
 *
 * The method names are `item/<kind>/requestApproval`; codex-cli still carries
 * the older `execCommandApproval` / `applyPatchApproval` spellings, so both are
 * accepted — a version skew here means a hung turn, not a wrong label.
 */
export function codexApprovalRequest(
  method: string,
  params: Record<string, unknown>,
): { tool: string; title: string; input: Record<string, unknown> } | undefined {
  const command = optionalString(params['command']);
  const reason = optionalString(params['reason']);
  const cwd = optionalString(params['cwd']);
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return {
        tool: 'CodexExec',
        // The command IS the question. A title that said «Codex wants to run a
        // command» would make the reader open the payload to learn the one
        // thing they are being asked about.
        title: command ? `$ ${command}` : 'Codex wants to run a command',
        input: { command, ...(cwd ? { cwd } : {}), ...(reason ? { reason } : {}) },
      };
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval': {
      const changes = params['changes'] ?? params['fileChanges'] ?? params['files'];
      const paths = Array.isArray(changes)
        ? changes.map((c) => optionalString(asRecord(c)?.['path']) ?? '').filter(Boolean)
        : Object.keys(asRecord(changes) ?? {});
      return {
        tool: 'CodexPatch',
        title: paths.length ? `edit ${paths.join(', ')}` : 'Codex wants to change files',
        input: { ...(paths.length ? { paths } : {}), changes, ...(reason ? { reason } : {}) },
      };
    }
    case 'item/permissions/requestApproval':
      return {
        tool: 'CodexPermissions',
        title: reason || 'Codex is asking for a permission',
        input: params,
      };
    default:
      return undefined;
  }
}

/**
 * Answer an approval with one of the decisions the server actually offered.
 *
 * `availableDecisions` is a MIXED array — plain strings beside objects like
 * `{acceptWithExecpolicyAmendment: {...}}` — and its contents vary by request
 * and by version. Measured against codex-cli 0.154.0 on 23.09.2026, a command
 * approval offered `["accept", {acceptWithExecpolicyAmendment: …}, "cancel"]`:
 * **no `decline` at all**, so a hardcoded `'decline'` (or the `'approved'` an
 * older reading suggested) would have been silently wrong on the very first
 * refusal. Only names that were offered are used.
 *
 * Object-shaped decisions are never chosen: each is an amendment that widens
 * policy beyond the single action the human was shown, and consenting to the
 * question asked is not consent to the broader one.
 */
export function pickCodexDecision(available: unknown, allow: boolean): string {
  const offered = (Array.isArray(available) ? available : []).filter(
    (o): o is string => typeof o === 'string',
  );
  // Plain `accept` before `acceptForSession`: the reader approved THIS command.
  const preferred = allow
    ? ['accept', 'approved', 'allow', 'acceptForSession']
    : ['decline', 'denied', 'reject', 'cancel', 'abort'];
  const named = preferred.find((want) => offered.includes(want));
  if (named) return named;
  const loose = offered.find((o) =>
    allow ? /^(accept|approve|allow)/i.test(o) : /(declin|deny|reject|cancel|abort)/i.test(o),
  );
  // The literal fallback is for a server that offered nothing at all; it is a
  // guess, and it is only ever reached when every measured shape is absent.
  return loose ?? (allow ? 'accept' : 'decline');
}

/**
 * The level a turn will ACTUALLY be started at: the session's pin, else the
 * machine's `~/.codex/config.toml`, else the fallback.
 *
 * Exported because it has to be said in two places at once — to Codex, in
 * `collaborationMode`, and to the hub, as `activeEffort` — and the bug it
 * closes is exactly those two disagreeing. Before this, the third branch was
 * reached silently: the turn ran at `medium` and the composer, having been told
 * nothing, drew its thumb on `low`.
 */
export function codexEffectiveEffort(pinned?: string, base?: string): string {
  return pinned ?? base ?? CODEX_FALLBACK_EFFORT;
}

export function codexCollaborationMode(mode: PermissionMode, model: string, effort?: string): Record<string, unknown> {
  return {
    // Collaboration mode answers «how should we work», and only `plan` is a
    // different answer to it. The permission modes beside it answer «what may
    // you do without asking», and that is `codexApprovalPosture`'s question —
    // narrowing them to `default` here is correct, not lossy.
    mode: mode === 'plan' ? 'plan' : 'default',
    settings: {
      model,
      reasoning_effort: effort ?? null,
      developer_instructions: null,
    },
  };
}

/** The turn Codex's own client sends when a plan is accepted. */
export const CODEX_IMPLEMENT_PLAN = 'Implement the plan.';

/**
 * The body of a `<proposed_plan>` block — what Codex's plan mode emits when it
 * considers the plan final. Anything short of a closed block is still a draft.
 */
export function extractProposedPlan(text: string): string | undefined {
  const match = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/.exec(text);
  const body = match?.[1]?.trim();
  return body || undefined;
}

/**
 * The mode an accepted plan continues in.
 *
 * The plan card speaks Claude's two choices — «правки подтверждать»
 * (`default`) and «правки без вопросов» (`acceptEdits`). For Codex the second
 * one is not «no questions» at all if taken literally: `acceptEdits` is the
 * workspace-write sandbox, where `.git` is read-only, so a plan that ends in a
 * commit fails on the one step the person asked for. It therefore means the
 * mode the run was in before planning, and failing that the machine's own
 * default — the same fallback the composer's plan switch uses when turned off.
 */
export function codexModeAfterPlan(
  chosen: PermissionMode | undefined,
  before: PermissionMode | undefined,
  machineDefault: PermissionMode = codexDefaultPermissionMode(),
): PermissionMode {
  if (chosen === 'default') return 'default';
  const back = before && before !== 'plan' ? before : machineDefault;
  // «Без вопросов» from an asking mode still means without questions.
  if (back === 'plan' || back === 'default') return machineDefault === 'bypassPermissions' ? machineDefault : 'acceptEdits';
  return back;
}

export function codexThreadSelection(model?: string, effort?: string): Record<string, unknown> {
  return {
    ...(model ? { model } : {}),
    ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
  };
}

export function codexThreadSettings(
  source: Record<string, unknown> | undefined,
): { model?: string; effort?: string } {
  if (!source) return {};
  const thread = asRecord(source['thread']);
  const settings = asRecord(source['threadSettings']) ?? asRecord(thread?.['threadSettings']);
  const model =
    optionalString(source['model']) ??
    optionalString(settings?.['model']) ??
    optionalString(thread?.['model']);
  const effort =
    optionalString(source['reasoningEffort']) ??
    optionalString(settings?.['effort']) ??
    optionalString(thread?.['reasoningEffort']);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function normalizeCodexQuestions(raw: unknown): CodexQuestion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((value) => {
    const question = asRecord(value);
    if (!question || typeof question['id'] !== 'string' || typeof question['question'] !== 'string') return [];
    if (seen.has(question['id'])) return [];
    seen.add(question['id']);
    const options = Array.isArray(question['options'])
      ? question['options'].flatMap((value) => {
          const option = asRecord(value);
          return option && typeof option['label'] === 'string'
            ? [{ label: option['label'], description: stringValue(option['description']) }]
            : [];
        })
      : null;
    return [{
      id: question['id'],
      question: question['question'],
      header: optionalString(question['header']),
      options,
      isOther: question['isOther'] === true,
      isSecret: question['isSecret'] === true,
    }];
  });
}

export function encodeCodexAnswers(
  questions: CodexQuestion[],
  decision: ToolApprovalDecision,
): Record<string, { answers: string[] }> {
  const rawAnswers = asRecord(decision.updatedInput?.['answers']) ?? {};
  const result: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const answer = rawAnswers[question.id] ?? rawAnswers[question.question];
    const values = Array.isArray(answer)
      ? answer.filter((value): value is string => typeof value === 'string')
      : typeof answer === 'string'
        ? [answer]
        : [];
    result[question.id] = { answers: decision.allow ? values : [] };
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** Only retry a rejected picker value. Timeouts, transport failures and quota
 * errors must not create a second thread behind the first request's back. */
export function selectionRejected(reason: string): boolean {
  if (/timed out|closed|exited|ECONN|socket|\b429\b|quota|rate[ _-]?limit/i.test(reason)) return false;
  return /(model|reasoning(?:[_ -]effort)?|service tier).*(invalid|unknown|unsupported|unavailable|not (?:found|available)|does not exist|rejected)|(?:invalid|unknown|unsupported).*(model|reasoning(?:[_ -]effort)?)/i.test(
    reason,
  );
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}\n…(${value.length - length} more chars)` : value;
}

function cleanCmd(command: string): string {
  return command.replace(/^\S*\/(?:zsh|bash|sh)\s+-l?c\s+/, '');
}

function errMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return record ? stringValue(record['message']) || JSON.stringify(record) : String(value ?? 'error');
}

/**
 * What Codex offers, asked of Codex itself (`model/list` on the app-server).
 *
 * A Codex session's model ids mean nothing to Claude and vice versa, so the
 * composer needs this list whenever `session.source === 'codex'`. The answer
 * cannot come from a live run: the picker is most needed on a session nobody
 * has spoken to yet, so this spawns its own short-lived app-server, asks, and
 * kills it. The answer is cached for the life of the agent — a model list
 * changes when Codex is upgraded, which restarts the agent anyway.
 *
 * Failure is never fatal: an unreachable or too-old app-server returns an empty
 * list and the caller falls back, exactly as it does for Claude.
 */
let codexModels: ModelInfoLite[] | undefined;

export async function listCodexModels(timeoutMs = 20_000): Promise<ModelInfoLite[]> {
  if (codexModels) return codexModels;
  try {
    return await withCodexAppServer({ timeoutMs }, async ({ request }) => {
      const answer = await request('model/list', { includeHidden: false, limit: 50 });
      // `isDefault` in the list is the CATALOG's default, not this machine's: a
      // `model = …` in ~/.codex/config.toml outranks it for every thread started
      // without a pick. Asked separately and allowed to fail — an older
      // app-server without `config/read` keeps the catalog's answer.
      let configured: string | undefined;
      try {
        // Its own short budget: this is an optional second question, and the
        // caller's whole wait is bounded by `timeoutMs`, not twice that.
        const config = asRecord(
          asRecord((await request('config/read', {}, 3_000))['result'])?.['config'],
        );
        configured = optionalString(config?.['model']);
      } catch {
        configured = undefined;
      }
      const models = codexModelsFromList(answer, configured);
      if (models.length) {
        codexModels = models;
        console.log(`[agent] codex offers ${models.length} model(s): ${models.map((m) => m.id).join(', ')}`);
      }
      return models;
    });
  } catch (error) {
    // Codex missing or unstartable is the ordinary state of a machine without it: no log.
    if (error instanceof CodexSpawnError) return [];
    console.error('[agent] codex model/list failed:', errMessage(error));
    return [];
  }
}

/**
 * `model/list` → the shape the picker speaks. Exported for the test: the
 * response nests rows under `result.data`, each naming its efforts as objects
 * rather than strings, and the row Codex calls `isDefault` becomes the `default`
 * placeholder the composer already knows how to name.
 */
export function codexModelsFromList(answer: Record<string, unknown>, configured?: string): ModelInfoLite[] {
  const result = asRecord(answer['result']) ?? answer;
  const rows = Array.isArray(result['data']) ? result['data'] : [];
  const out: ModelInfoLite[] = [];
  let fallback: ModelInfoLite | undefined;
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row || row['hidden'] === true) continue;
    const id = stringValue(row['id'] ?? row['model']);
    if (!id) continue;
    const efforts = (Array.isArray(row['supportedReasoningEfforts']) ? row['supportedReasoningEfforts'] : [])
      .map((e) => (typeof e === 'string' ? e : optionalString(asRecord(e)?.['reasoningEffort'])))
      .filter((e): e is string => !!e);
    const model: ModelInfoLite = {
      id,
      // The id IS the wire id here, so the picker can match what a run reports.
      resolved: id,
      ...(optionalString(row['displayName']) ? { name: optionalString(row['displayName']) } : {}),
      ...(efforts.length ? { efforts } : {}),
      supportsEffort: efforts.length > 0,
    };
    out.push(model);
    if (row['isDefault'] === true && !fallback) fallback = model;
  }
  // The row the composer reads to name the unpinned choice — same contract the
  // Claude runtime's own "default" row has. The machine's configured model wins
  // over the catalog's `isDefault`: that is what an unpinned thread really runs
  // on. On 29.09.2026 the picker named GPT-6-Astra (catalog) while every
  // unpinned session ran GPT-5.6-Sol (config.toml), and the label flipped
  // between the two as the run attached and detached.
  const mine = configured ? out.find((m) => m.id === configured) : undefined;
  if (mine) fallback = mine;
  else if (configured) fallback = { id: configured, resolved: configured };
  if (fallback) {
    out.unshift({ id: 'default', resolved: fallback.resolved, ...(fallback.name ? { name: fallback.name } : {}) });
  }
  return out;
}
