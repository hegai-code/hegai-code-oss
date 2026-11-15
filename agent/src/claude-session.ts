import { SubagentTracker, type BackgroundTaskOwner } from './subagent-tracker.js';
import { ImageGenLiveTracker } from './image-gen.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeTurnUsage } from './turn-usage.js';
import { TurnSettle } from './turn-settle.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  CanUseTool,
  HookInput,
  PermissionMode,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, ImageInput, ModelInfoLite, RunBy, SlashCommandInfo } from '@cc-remote/shared';
import { isPlanTool, planItems, planProgress } from '@cc-remote/shared';
import { OWN_ENTRYPOINT } from './sessions.js';
import { childEnv, runUserEnv } from './child-env.js';
import { policy, within } from './policy.js';
import { machineDefaultPermissionMode } from './permission-mode.js';
import { stateDir } from './config.js';
import { BUDGET_EXHAUSTED_TEXT, classifyModelError, describeApiFailure } from './model-error.js';
import { harnessOptions } from './harness.js';
import { planToolOptions, sessionLaunchOptions } from './plan-tool.js';

/**
 * Drives one resumed Claude Code session through the Agent SDK in streaming
 * input/output mode:
 *   - resumes an existing sessionId in its original cwd,
 *   - streams normalized output events to a handler,
 *   - lets the operator push new user turns, interrupt, and close,
 *   - gates tool calls through an approver (the UI's "approve tool" action).
 *
 * One instance == one writable run of one session. The caller is responsible
 * for enforcing single-writer (don't construct two of these for one sessionId,
 * and never for a session with a live VSCode pid).
 */

export interface StreamEvent {
  kind: 'system' | 'assistant' | 'partial' | 'tool_use' | 'result' | 'error' | 'status';
  text?: string;
  /** Machine-readable meaning, when the run could tell — the vocabulary is
   *  documented on `Stream.event.code` in shared/src/protocol.ts. */
  code?: string;
  /** Structured payload for `code` (counters, token numbers, cost). */
  data?: Record<string, unknown>;
  /**
   * Agent-internal, never on the wire: this `error` ended the run itself (the
   * subprocess died, the stream threw) rather than one turn of it. A turn that
   * fails — an API error, a tool that crashed, max turns — leaves the runtime
   * alive and waiting for the next message, exactly as the CLI in a terminal
   * would, and is reported WITHOUT this flag. The run manager closes the run
   * only on a fatal error; before this distinction existed every failed turn
   * tore the whole run down, and the next message had to resume from scratch.
   */
  fatal?: boolean;
  raw?: unknown;
}

/** An `error` event for a failed model call: a quota refusal carries its code
 *  and the short human text; anything else is reported verbatim under
 *  `turn_failed` (or the caller's own code). */
export function modelErrorEvent(
  text: string,
  raw?: unknown,
  extra: { code?: string; data?: Record<string, unknown>; fatal?: boolean } = {},
): StreamEvent {
  const quota = classifyModelError(text);
  if (quota) console.warn(`[agent] model call refused for quota: ${text}`);
  const code = quota ?? extra.code ?? 'turn_failed';
  return {
    kind: 'error',
    text: quota ? BUDGET_EXHAUSTED_TEXT : text,
    code,
    ...(extra.data ? { data: extra.data } : {}),
    ...(extra.fatal ? { fatal: true } : {}),
    ...(raw === undefined ? {} : { raw }),
  };
}

export interface ToolApprovalRequest {
  tool: string;
  input: Record<string, unknown>;
  toolUseID: string;
  title?: string;
  /**
   * Asked once the turn is already over (Codex's plan offer), not from inside
   * one. The run stays idle while the card waits, and a refusal returns it to
   * idle — there is no turn left to carry it there.
   */
  afterTurn?: boolean;
}

export interface ToolApprovalDecision {
  allow: boolean;
  updatedInput?: Record<string, unknown>;
  /** Permission mode selected while approving a plan (review edits vs
   *  auto-accept). Applied before returning the permission result. */
  permissionMode?: PermissionMode;
  message?: string;
}

export type ToolApprover = (req: ToolApprovalRequest) => Promise<ToolApprovalDecision>;

/**
 * Sandbox auto-approval (opt-in via env `CC_REMOTE_AUTOAPPROVE=sandbox`).
 *
 * On an isolated sandbox box (a dedicated unprivileged unix user with no prod
 * keys and a read-only DB), the OS user IS the security boundary — so tool calls
 * don't each need a human click during normal coding. We silently allow
 * everything EXCEPT the actions that actually leave the sandbox: pushing code
 * out (`git push`), network egress (exfil risk), and privilege escalation. Those
 * still route to the operator for a decision. Off by default; only the sandbox
 * agent sets the env var, so every other agent is byte-for-byte unchanged.
 */
const SANDBOX_AUTO_APPROVE = process.env['CC_REMOTE_AUTOAPPROVE'] === 'sandbox';

/**
 * Directories this agent may read but must not change (`CC_REMOTE_DENY_WRITE_PATHS`,
 * colon-separated absolute paths).
 *
 * A sandbox that holds both a team's own projects and the platform they depend
 * on needs the second kind readable — you cannot write a good spec for code you
 * cannot see — while keeping edits out of it. Reads stay open; writes and the
 * commands that ship them are refused with a pointer to the route that does
 * work (`tz`, which files the change for approval).
 *
 * This is a guardrail, not a boundary. The unix user is the boundary, and this
 * agent shares one with the code it is refusing to edit — a determined model
 * could write through a shell heredoc. It exists to stop the accidental drift
 * that skill text alone never stopped, and to name the right route at the moment
 * someone takes the wrong one.
 */
const DENY_WRITE_PATHS: string[] = (process.env['CC_REMOTE_DENY_WRITE_PATHS'] ?? '')
  .split(':')
  .map((p) => p.trim().replace(/\/+$/, ''))
  .filter((p) => p.startsWith('/'));

/**
 * May this machine run a session with NO approval prompts at all
 * (`bypassPermissions`)?
 *
 * The mode is what someone driving their own box actually wants: a remote
 * session that stops on every Bash call is a session you babysit from a phone.
 * But `bypassPermissions` is not "approve faster", it is "the approval callback
 * is never invoked" — the SDK says so itself, warning
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED and pointing at PreToolUse hooks as the only
 * gate that survives. So every rule that lived in `canUseTool` evaporates with
 * it, `sandboxNeedsReview` (egress, `git push`, sudo) included.
 *
 * It used to be withheld from a box that declared a sandbox posture — the
 * reasoning being that `sandboxNeedsReview` was its last human checkpoint.
 * Owner's call on 24.09.2026 ends that: EVERY machine gets the mode, sandboxes
 * included, because the prompt was never a boundary. It went to whoever was
 * driving that sandbox — the person the review would have to be protecting us
 * from — so it bought friction, not safety. The real boundary is the unix user
 * (see the memory `ccremote-rbac-boundary`), and it is untouched here.
 *
 * What genuinely survives: the protected-path refusal, which moved to a
 * PreToolUse hook (`protectedPathHook`) precisely so it keeps working under
 * bypass. devbox's «/srv/acme is read-only, file a spec with `tz`» and the
 * `deploy-prod` ban therefore still hold. What goes away is the egress prompt
 * (`curl`/`ssh`/`git push`/`sudo`) in `sandboxNeedsReview`, which is reached
 * only when a run is deliberately put back into a mode that asks.
 *
 * `CC_REMOTE_ALLOW_BYPASS=0` is the way back for one machine.
 */
export function bypassAllowed(
  forced: string | undefined = process.env['CC_REMOTE_ALLOW_BYPASS'],
): boolean {
  // Chat-only is the owner saying «never without prompts», and it outranks
  // even an explicit CC_REMOTE_ALLOW_BYPASS=1 left in a unit file.
  if (policy().chatOnly) return false;
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;
  return cliAcceptsBypass();
}

/** Does `~/.claude/settings.json` hand the CLI `IS_SANDBOX`? The CLI applies
 *  its own `env` block to itself before the root check below, so a flag set
 *  only there still counts — which is exactly how `stage` runs bypass as root. */
function settingsIsSandbox(home: string = os.homedir()): boolean {
  try {
    const raw = readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const env = (JSON.parse(raw) as { env?: Record<string, unknown> }).env ?? {};
    const flag = env['IS_SANDBOX'];
    return flag === '1' || flag === 1 || flag === true || flag === 'true';
  } catch {
    return false;
  }
}

/**
 * Will the CLI actually ACCEPT `bypassPermissions`, or refuse to start?
 *
 * «--dangerously-skip-permissions cannot be used with root/sudo privileges for
 * security reasons», exit 1 — measured on `cloud` 24.09.2026, as root, with the
 * CLI the agent itself ships. That is not a prompt we could auto-answer: the
 * process does not come up, so asking for the mode on such a box does not remove
 * approvals, it removes SESSIONS. Half the fleet runs its agent as root
 * (`cloud`, `chatapp`, vps-box-1), which is why this must be asked before the
 * mode is either requested or advertised.
 *
 * `IS_SANDBOX=1` is the CLI's own escape hatch and counts from either place it
 * can reach the process — the agent's environment, or the `env` block of
 * `~/.claude/settings.json`, which is where `stage` has it.
 *
 * Losing the mode does NOT bring the prompts back: a run on such a machine
 * starts in `default` and every request it raises is answered by `autoApproves`
 * in `run-manager.ts`. Same promise, one layer lower.
 */
export function cliAcceptsBypass(
  probe: { uid?: number; envFlag?: string; settingsFlag?: boolean } = {
    uid: process.getuid?.(),
    envFlag: process.env['IS_SANDBOX'],
    settingsFlag: settingsIsSandbox(),
  },
): boolean {
  // One object rather than three positional arguments, because a test passing
  // `undefined` for one of them would silently get the DEFAULT — the real uid,
  // the real environment — and assert about the machine it runs on instead of
  // the case it names. That is not hypothetical: it is how this function's
  // first test passed as root and failed everywhere else.
  //
  // Not root — Windows and every Mac agent included — so the rule never fires.
  if (probe.uid !== 0) return true;
  return Boolean(probe.envFlag) || probe.settingsFlag === true;
}

/**
 * The mode a run starts in when the client named none.
 *
 * `default` — the old fallback — is the mode that asks, and a remote session
 * that stops on a `Read` outside the workspace is a session that sits there
 * until someone opens the right tab. That is not theoretical: on 24.09.2026 a
 * run on `stage` waited 12.5 minutes on exactly that, and would have waited
 * twelve HOURS, because this box raises `CC_REMOTE_APPROVAL_TIMEOUT_MS` for the
 * spec-intake flow. Nobody had chosen `default`; it was simply what nothing
 * meant.
 *
 * So nothing now means `bypassPermissions` wherever the machine allows it. A
 * client that names a mode still gets it, and `CC_REMOTE_DEFAULT_PERMISSION_MODE`
 * still overrides (read per call and validated, `machineDefaultPermissionMode`) —
 * this is the floor, not a ceiling.
 */
export function defaultPermissionMode(
  configured: PermissionMode | undefined = machineDefaultPermissionMode(),
  bypass: boolean = bypassAllowed(),
): PermissionMode {
  return configured ?? (bypass ? 'bypassPermissions' : 'default');
}

/** Permission modes this machine offers a client. `bypassPermissions` is the
 *  only conditional one; the rest are always available. Ordered the way the
 *  picker reads them. */
export function availablePermissionModes(
  ...gate: Parameters<typeof bypassAllowed>
): PermissionMode[] {
  const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits'];
  if (bypassAllowed(...gate)) modes.push('bypassPermissions');
  return modes;
}

/** Tools whose whole purpose is to change a file at `input.file_path`. */
const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** `child` is `parent` itself or sits underneath it. Segment-aware, so
 *  `/srv/acme-notes` is not treated as inside `/srv/acme`. */
function pathIsWithin(child: string, parent: string): boolean {
  if (!child.startsWith('/')) return false;
  const norm = child.replace(/\/+$/, '');
  return norm === parent || norm.startsWith(`${parent}/`);
}

/**
 * Why this tool call is refused outright, or undefined to let it proceed.
 * Empty `DENY_WRITE_PATHS` (every agent but the sandbox) short-circuits to
 * undefined, so nothing else in the fleet changes behaviour.
 */
export function deniedForProtectedPath(
  tool: string,
  input: Record<string, unknown>,
  protectedPaths: string[] = DENY_WRITE_PATHS,
): string | undefined {
  if (protectedPaths.length === 0) return undefined;
  if (FILE_WRITE_TOOLS.has(tool)) {
    const target = String((input as { file_path?: unknown }).file_path ?? '');
    const hit = protectedPaths.find((root) => pathIsWithin(target, root));
    return hit
      ? `${hit} is read-only for this machine — edit it by filing a spec with \`tz\`, not directly.`
      : undefined;
  }
  if (tool !== 'Bash') return undefined;
  const cmd = String((input as { command?: unknown }).command ?? '');
  // Deploying is shipping someone else's code from here, wherever it is run from.
  if (/(^|[\s;&|(`$])deploy-prod\b/.test(cmd)) {
    return 'Deploying the platform from this machine is not allowed — file a spec with `tz`.';
  }
  // A push that names a protected path, or runs with -C into one. Commands that
  // merely mention the directory (grep, cat, cd to read) are left alone.
  const pushes = /\bgit\b[^&|;]*\bpush\b/.test(cmd);
  const writesInPlace = /\bgit\s+(-C\s+\S+\s+)?(commit|merge|reset|checkout|apply|rebase)\b/.test(cmd);
  if (!pushes && !writesInPlace) return undefined;
  const hit = protectedPaths.find((root) => cmd.includes(root));
  return hit
    ? `${hit} is read-only for this machine — file a spec with \`tz\` instead of changing it here.`
    : undefined;
}

/**
 * On a chat-only machine a session may not edit the agent's own state — which
 * is where `policy.json` lives. The file RPCs already refuse `~/.cc-remote`
 * (`fs-ops.ts`); this closes the same door for Claude's Edit/Write, which a
 * hub could otherwise prompt for and approve itself. `Bash` still asks a person
 * on such a machine, and the policy is read once at start — a guard-rail, and
 * named as one in policy.ts.
 */
export function deniedForAgentState(
  tool: string,
  input: Record<string, unknown>,
  chatOnly: boolean = policy().chatOnly,
  dirs: string[] = agentOwnDirs(),
): string | undefined {
  if (!chatOnly || !FILE_WRITE_TOOLS.has(tool)) return undefined;
  const i = input as { file_path?: unknown; notebook_path?: unknown };
  const raw = String(i.file_path ?? i.notebook_path ?? '');
  if (!raw) return undefined;
  const hit = dirs.find((d) => within(raw, d));
  return hit ? `${hit} holds this machine's own agent and settings and is not editable from a session (chat-only mode).` : undefined;
}

/** Where the agent's own state and code live: `~/.cc-remote` (policy.json,
 *  the env file, the device credential) and the directory of the running
 *  bundle. `within` folds case on Windows/macOS, where `~/.CC-Remote` is the
 *  same folder. */
function agentOwnDirs(): string[] {
  const dirs = [stateDir()];
  try {
    dirs.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* not a file URL — a test harness */
  }
  return dirs;
}

/**
 * The protected-path refusal as a PreToolUse HOOK rather than a branch of
 * `canUseTool`.
 *
 * `canUseTool` is not called at all under `bypassPermissions` — the SDK
 * auto-approves first and warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED — so a guard
 * that lives only there is a guard that disappears the moment a session turns
 * prompts off. Verified against the SDK, not assumed: the callback fired zero
 * times for a Bash call in that mode. A hook runs in every mode, ahead of the
 * permission machinery, which is the whole reason this moved.
 *
 * Returns nothing when the call is fine: an empty output leaves the decision to
 * whatever comes next (the human, or the mode).
 */
function protectedPathHook(input: HookInput, onEffort?: (effort: string) => void): SyncHookJSONOutput {
  if (input.hook_event_name !== 'PreToolUse') return {};
  // Read BEFORE the refusal check: a denied call still tells the truth about
  // the level this turn is running at, and a session that only ever tries
  // protected paths would otherwise never report one.
  const level = (input as { effort?: { level?: unknown } }).effort?.level;
  if (typeof level === 'string' && level) onEffort?.(level);
  const denial =
    deniedForAgentState(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>) ??
    deniedForProtectedPath(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
  if (!denial) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial,
    },
  };
}

/** True when a tool call must still be confirmed by a human even in sandbox
 *  auto-approve mode — i.e. it can reach outside the sandbox. */
function sandboxNeedsReview(tool: string, input: Record<string, unknown>): boolean {
  // Fetching arbitrary URLs can exfiltrate (the sandbox can read prod data RO).
  if (tool === 'WebFetch' || tool === 'WebSearch') return true;
  if (tool !== 'Bash') return false; // Read/Write/Edit/Glob/Grep/… stay inside the box.
  const cmd = String((input as { command?: unknown }).command ?? '');
  // Pushing code out of the box (branches / prod), network egress, privilege.
  if (/\bgit\s+push\b/.test(cmd)) return true;
  if (/(^|[\s;&|(`$])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet)\b/.test(cmd)) return true;
  if (/(^|[\s;&|(`$])(sudo|su|doas)\b/.test(cmd)) return true;
  return false;
}

export interface RunHandlers {
  onEvent: (event: StreamEvent) => void;
  /** Omit to auto-allow every tool. */
  approveTool?: ToolApprover;
  /** Fired once with the SDK-minted session id (esp. for a brand-new session
   *  started without a `sessionId` to resume). */
  onSessionId?: (sessionId: string) => void;
  /** The session's live permission mode changed (from the SDK init/status). */
  onModeChange?: (mode: PermissionMode) => void;
  /** The wire model the runtime actually resolved to (from the SDK init/status).
   *  The picker's own rows are aliases ('default', 'opus'); this is the only way
   *  to say what "default" currently means. */
  onActiveModel?: (model: string) => void;
  /**
   * The effort level actually in force for the current turn.
   *
   * The twin of `onActiveModel`, and it exists for the same reason: without it
   * a picker cannot say what an UNPINNED session is running. `run_settings`
   * reports `effort` only once somebody sets it, so until now "nobody chose"
   * and "we do not know" were the same state on screen — and the control had
   * to answer «how much effort?» with «someone else decided».
   *
   * Only a hook knows it. It is not on the init message, not on
   * `initializationResult()`, and there is no `getSettings()` on the query —
   * checked against the SDK's own types, not assumed. `BaseHookInput.effort`
   * carries «the active effort level for the current turn, AFTER any silent
   * downgrade for the selected model», which is a better answer than the
   * account default anyway: it is what the model will actually do.
   *
   * Consequence worth knowing: it arrives with the turn's first tool call, not
   * at open. A session that has never run a tool still cannot name its level.
   */
  onActiveEffort?: (effort: string) => void;
  /** A runtime rejected explicitly pinned startup settings and continued on
   * its account defaults. Clears the pin in `run_settings` so the picker names
   * what is really running instead of preserving the rejected choice. */
  onRequestedSettingsChange?: (settings: { model?: string; effort?: EffortLevel }) => void;
}

export interface RunOptions {
  /** Hub user who started/resumed this run → HEGAI_RUN_USER_* in the coder's env. */
  runBy?: RunBy;
  /** Path exported as HEGAI_RUN_STATE_FILE (see run-state.ts). */
  runStateFile?: string;
  /** Fail closed unless this internal Codex job uses the Hegai gateway. */
  requireGateway?: boolean;
  /** Existing session to resume. Omit to start a fresh session. */
  sessionId?: string;
  cwd: string;
  /** Optional first user turn to send immediately on start. */
  firstMessage?: string;
  permissionMode?: PermissionMode;
  /** Model and reasoning effort to open the session under, picked before the
   *  first turn. Same values `setModel`/`setEffort` take mid-run.
   *
   *  The two do NOT arrive the same way, because the SDK only offers one of
   *  them at launch: `model` is a `query` option, while effort has to go
   *  through `applyFlagSettings` once the query exists. That is why the first
   *  turn waits behind `startupSettings` — see `sendInput`. */
  model?: string;
  effort?: EffortLevel;
  /** Override the Claude Code executable (e.g. to match the session's version). */
  pathToClaudeCodeExecutable?: string;
  handlers: RunHandlers;
}

/**
 * The writable-run surface the agent drives, regardless of the underlying CLI
 * (Claude Agent SDK or the Codex `exec` runtime). `launchRun` constructs one of
 * these; everything downstream (input, interrupt, the set_ controls, close) is
 * source-agnostic.
 */
export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  autoCompactThreshold?: number;
  autoCompactEnabled: boolean;
  /** The model this run is actually on. It rides along here because this is the
   *  one answer the CLI gives without a turn — the `system` init message names
   *  the model too, but a session that has not been spoken to never emits one,
   *  and that is exactly when a client most needs to know. */
  model?: string;
}

export interface SessionRun {
  readonly completed: Promise<void>;
  finishedWith?: 'end' | 'error';
  sendInput(text: string, images?: ImageInput[]): void;
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setEffort(effort?: 'low' | 'medium' | 'high' | 'xhigh', ultracode?: boolean): Promise<void>;
  /** Context budget as the CLI itself computes it, or undefined if the runtime
   *  is too old to answer. Never derived locally — one source of truth. */
  contextUsage?(): Promise<ContextUsage | undefined>;
  /** Run the CLI's own compaction, the same thing `/compact` does. */
  compact?(): Promise<void>;
  /** Models this runtime actually offers, so the picker can stop guessing. */
  supportedModels?(): Promise<ModelInfoLite[] | undefined>;
  /** Slash commands this run understands — built-ins, skills, plugins — for
   *  the composer's «/» menu. */
  supportedCommands?(): Promise<SlashCommandInfo[] | undefined>;
  /** Stop one sub-agent (`Subagent.id`); the run and the others go on.
   *  False when this run does not know that id. */
  stopSubagent?(id: string): Promise<boolean>;
  /** Resolves once the runtime PROCESS is confirmed gone — or when the kill
   *  escalation's bound has passed. `completed` says the event stream ended;
   *  this says nothing can still write the transcript. Absent for runtimes
   *  whose writers are visible elsewhere (Claude: `~/.claude/sessions` pid
   *  files, which `findLiveWriter` reads before a resume). */
  exited?: Promise<void>;
  close(): void;
}

/** Minimal pushable async iterable used to feed user turns into the SDK. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private ended = false;

  push(msg: SDKUserMessage): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.buffer.push(msg);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    let waiter;
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const next = this.buffer.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.ended) {
          return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function userMessage(text: string, images?: ImageInput[]): SDKUserMessage {
  // With images, content becomes a block array (text first, then images) — the
  // Anthropic MessageParam shape the SDK forwards to the model. Plain string
  // otherwise, to keep the common path byte-identical.
  const content =
    images && images.length
      ? [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...images.map((im) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: im.media_type, data: im.data },
          })),
        ]
      : text;
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  };
}

/** True for a message a sub-agent wrote (it names the Agent tool call that
 *  started it). The main thread's own messages carry `null`. */
function isSubagentMessage(msg: unknown): boolean {
  const parent = (msg as { parent_tool_use_id?: unknown } | null)?.parent_tool_use_id;
  return typeof parent === 'string' && parent.length > 0;
}

/** The CLI's plan windows, named the way the rate-limit line reads them. */
const RATE_LIMIT_WINDOW: Record<string, string> = {
  five_hour: 'лимит сессии (5 ч)',
  seven_day: 'недельный лимит',
  seven_day_opus: 'недельный лимит Opus',
  seven_day_sonnet: 'недельный лимит Sonnet',
  seven_day_overage_included: 'недельный лимит модели',
  overage: 'лимит кредитов',
};

export class ClaudeSessionRun implements SessionRun {
  private turnUsage = new ClaudeTurnUsage();
  /** What the API last said was wrong in THIS turn — from `api_retry` or the
   *  assistant message's `error`. The failed `result` names only the CLI's
   *  diagnostic; this is the cause (see `describeApiFailure`). Cleared by a
   *  successful answer and at every turn's end. */
  private lastApiFailure: { kind?: string; status?: number | null } | undefined;
  private readonly input = new InputQueue();
  private readonly query: Query;
  private readonly handlers: RunHandlers;
  /** Resolves once launch-time settings the SDK has no launch option for have
   *  been applied — today that is effort alone. Undefined when nothing had to
   *  be applied, which is the overwhelmingly common case and keeps `sendInput`
   *  on its original synchronous path. */
  private startupSettings?: Promise<void>;
  /** Resolves when the underlying query stream finishes. */
  readonly completed: Promise<void>;
  /** How the stream finished — 'error' already reported a run_status upstream. */
  finishedWith?: 'end' | 'error';
  /** A compaction was asked for (by us or by the CLI) and no verdict has
   *  arrived yet. Lets a bare `compact_result: success` count as the verdict
   *  when the boundary message does not come. */
  private compactInFlight = false;
  /** When each live background task was first seen, by task id — the SDK
   *  sends ids and descriptions only, and «идёт 12 мин» needs a start. */
  private backgroundSince = new Map<string, number>();
  /** The CLI's last background set, to send again once an owner is known. */
  private backgroundRaw: unknown;
  /** The run's sub-agents, as the card and the panel show them. */
  private readonly subagents = new SubagentTracker();
  /** `hegai-image` Bash calls → `image_gen` events (see image-gen.ts). */
  private readonly imageGen = new ImageGenLiveTracker();
  private subagentTimer: ReturnType<typeof setTimeout> | undefined;
  private subagentsDirty = false;
  /** Says `turn_settled` once the turn is over AND nothing runs in the
   *  background — the moment the suggestion strip may speak (`turn-settle.ts`). */
  private readonly settle: TurnSettle;
  private pendingResult?: StreamEvent;
  /** A plan count was sent to the hub and not yet cleared. */
  private planShown = false;

  constructor(opts: RunOptions) {
    this.handlers = opts.handlers;
    // Know and journal the identity BEFORE spawning the CLI or accepting input.
    const newSessionId = opts.sessionId ? undefined : randomUUID();
    if (newSessionId) this.handlers.onSessionId?.(newSessionId);
    this.settle = new TurnSettle(() => this.finishSettledTurn());

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      // The protected-path refusal used to open this callback. It now runs as a
      // PreToolUse hook (`protectedPathHook`), which denies BEFORE this is
      // consulted and — unlike this callback — still runs when the session has
      // prompts turned off. Same rule, same precedence, one more mode covered.
      if (!this.handlers.approveTool) {
        return { behavior: 'allow', updatedInput: input };
      }
      // Sandbox mode: silently allow everything that stays inside the box; only
      // the "leaves the sandbox" actions fall through to a human decision.
      if (SANDBOX_AUTO_APPROVE && !sandboxNeedsReview(toolName, input)) {
        return { behavior: 'allow', updatedInput: input };
      }
      const decision = await this.handlers.approveTool({
        tool: toolName,
        input,
        toolUseID: options.toolUseID,
        title: options.title,
      });
      if (decision.allow) {
        if (decision.permissionMode) {
          await this.query.setPermissionMode(decision.permissionMode);
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }
      return { behavior: 'deny', message: decision.message ?? 'Denied by operator' };
    };

    this.query = query({
      prompt: this.input,
      options: {
        resume: opts.sessionId,
        ...(newSessionId ? { sessionId: newSessionId } : {}),
        cwd: opts.cwd,
        // A client may still ASK for bypass on a machine that forbids it (an
        // old web build, a remembered pick, a hand-sent frame): start it in
        // `default` rather than let the SDK refuse the whole run.
        permissionMode:
          opts.permissionMode === 'bypassPermissions' && !bypassAllowed()
            ? 'default'
            : (opts.permissionMode ?? defaultPermissionMode()),
        // Picked on the start screen. Omitted (not passed as undefined) so a
        // session with no choice keeps whatever the CLI's own config resolves,
        // which is what every session did before the picker existed.
        ...(opts.model ? { model: opts.model } : {}),
        // Opus/Fable orchestrate, Sonnet explores and implements, Opus + Codex
        // review — sub-agents and the instruction to use them (harness.ts).
        // …and the checklist the strip over the composer counts — the CLI's
        // own is off for the models people use most (plan-tool.ts).
        ...sessionLaunchOptions(harnessOptions(), planToolOptions()),
        includePartialMessages: true,
        canUseTool,
        // `bypassPermissions` is refused by the SDK unless this is set, at launch
        // and on a live `setPermissionMode`. Passed only where the machine allows
        // the mode at all, so a sandbox cannot be talked into it mid-run.
        ...(bypassAllowed() ? { allowDangerouslySkipPermissions: true as const } : {}),
        // Runs in EVERY mode, which is the point — see protectedPathHook.
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input) =>
                  protectedPathHook(input, (level) => this.handlers.onActiveEffort?.(level)),
              ],
            },
          ],
          // The same reading, one turn later — and the only one an ANSWER
          // produces. Hung on PreToolUse alone, the level was unknown until the
          // session happened to call a tool: a chat that only ever talks (or a
          // session sitting idle since the agent restarted) showed a muted
          // track forever, which reads as «low», not as «not reported yet».
          // The SDK carries `effort` on every hook that fires inside a turn;
          // Stop is the one that always fires.
          Stop: [
            {
              hooks: [
                async (input) => {
                  const level = (input as { effort?: { level?: unknown } }).effort?.level;
                  if (typeof level === 'string' && level) this.handlers.onActiveEffort?.(level);
                  return {};
                },
              ],
            },
          ],
        },
        pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
        // Stamp our own entrypoint (see OWN_ENTRYPOINT) so a session created
        // here is not hidden from the IDE `/resume` picker as "programmatic".
        // `env` REPLACES the child environment wholesale — spread or the child
        // loses PATH/HOME/credentials.
        // `session_state_changed` is opt-in: without the flag the CLI never
        // says «idle», which is its own "the turn is really over" signal —
        // the one `turn_settled` is built on (turn-settle.ts).
        env: childEnv({ CLAUDE_CODE_ENTRYPOINT: OWN_ENTRYPOINT, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', ...runUserEnv(opts.runBy, opts.runStateFile) }),
        // A line on the CLI's stderr is a LOG, not a state change. It used to
        // ride as a bare `status`, and the hub reads a status frame as "the turn
        // moved on": it flipped the run to working and forgot the tool approval
        // it was waiting on, so a warning printed mid-prompt made the question
        // unanswerable for anyone who reloaded. The code lets every layer tell
        // the two apart.
        stderr: (data) => this.handlers.onEvent({ kind: 'status', code: 'stderr', text: data }),
      },
    });

    // Effort has no launch option, so it is applied the moment the query exists
    // and the first turn is held behind it. Neither a failure nor a silence may
    // hold the session hostage, though — `applyFlagSettings` is a control
    // request waiting on an answer, and a CLI that never answers would leave a
    // session that started, said nothing, and never ran the turn it was opened
    // for. That is a far worse outcome than a turn at the wrong effort, so the
    // gate opens either way and says which happened.
    if (opts.effort) {
      let late = false;
      const applied = this.setEffort(opts.effort).then(
        () => {
          if (late) {
            this.handlers.onEvent({ kind: 'status', code: 'control_applied', text: `усилие «${opts.effort}»: применено` });
          }
          return true;
        },
        (error: unknown) => {
          this.handlers.onEvent({
            kind: 'status',
            code: 'control_failed',
            text: `Не удалось поставить усилие «${opts.effort}»: ${errText(error)}`,
          });
          return true;
        },
      );
      // Past the gate the request is NOT abandoned: it already sits in the
      // CLI's stdin ahead of the first message, and a CLI still booting (MCP
      // servers, hooks — 20–40 s measured on a dev box, 16.10.2026) applies it
      // the moment it starts reading. So the line says «late», not «failed»;
      // a real refusal or the hard bound still lands through `applied` above.
      this.startupSettings = withTimeout(applied, STARTUP_SETTING_TIMEOUT_MS).then(
        (settled) => {
          if (settled !== TIMED_OUT) return;
          late = true;
          this.handlers.onEvent({
            kind: 'status',
            code: 'control_pending',
            text: `Claude ещё запускается — усилие «${opts.effort}» применится, как только он ответит`,
          });
        },
      );
    }

    if (opts.firstMessage) this.sendInput(opts.firstMessage);

    this.completed = this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const msg of this.query) {
        this.emit(msg);
      }
      this.finishedWith = 'end';
      for (const event of this.imageGen.abandon()) this.handlers.onEvent(event);
      this.handlers.onEvent({ kind: 'status', code: 'stream_ended', text: 'поток ответа закрыт' });
    } catch (err) {
      // The stream itself died — the subprocess exited, stdin broke. THIS is
      // the run ending, as opposed to one turn failing (see `result` below).
      this.finishedWith = 'error';
      for (const event of this.imageGen.abandon()) this.handlers.onEvent(event);
      this.handlers.onEvent(modelErrorEvent(errText(err), undefined, { code: 'run_failed', fatal: true }));
    } finally {
      this.pendingResult = undefined;
      this.settle.dispose();
    }
  }

  /**
   * Translate one SDK message into the events the product shows.
   *
   * Every arm below that is not `assistant` / `partial` / `result` exists
   * because the message used to fall into `default` and vanish — and each one
   * was a way for a session to look dead while it was not: the CLI retrying an
   * overloaded API for minutes (`api_retry`), a compaction that failed
   * (`status.compact_result`), «Not enough messages to compact.»
   * (`local_command_output`), a rate limit hit (`rate_limit_event`). The rule
   * is: if the CLI would print it in a terminal, it gets a line here, with a
   * code so clients can decide how loudly.
   */
  private emit(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system': {
        const change = this.subagents.receive(msg);
        if (change) this.publishSubagents(change === 'status');
        this.emitSystem(msg as SDKMessage & { type: 'system' });
        // The level precedes its `task_started`, and only `task_started` names
        // the call that ties a task to its sub-agent: the list just sent had no
        // owner for this task. Viewers replace the set, so send it again.
        const started = msg as { subtype?: string; task_id?: unknown };
        if (started.subtype === 'task_started' && typeof started.task_id === 'string'
          && this.backgroundSince.has(started.task_id) && this.subagents.taskOwner(started.task_id)) {
          this.publishBackgroundTasks();
        }
        break;
      }
      case 'user': {
        // The parent's tool results: the `Agent` call's result is a foreground
        // agent's report and the moment it ended. Only the main thread's.
        if (isSubagentMessage(msg)) break;
        const u = msg as { message?: { content?: unknown }; tool_use_result?: unknown };
        const content = Array.isArray(u.message?.content) ? (u.message!.content as Array<Record<string, unknown>>) : [];
        const meta = u.tool_use_result as { isAsync?: unknown; resolvedModel?: unknown } | undefined;
        const background = meta?.isAsync === true;
        const resolved = typeof meta?.resolvedModel === 'string' ? meta.resolvedModel : undefined;
        for (const block of content) {
          if (block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue;
          const text = toolResultText(block['content']);
          if (this.subagents.toolResult(block['tool_use_id'], text, block['is_error'] === true, background, resolved)) {
            this.publishSubagents(true);
          }
          for (const event of this.imageGen.toolResult(block['tool_use_id'], text, block['is_error'] === true)) {
            this.handlers.onEvent(event);
          }
        }
        break;
      }
      case 'assistant': {
        // A sub-agent's own messages (Agent tool, foreground or background)
        // arrive on the same stream with `parent_tool_use_id` naming the call
        // that started it. Forwarded as plain events they were the MAIN
        // thread's: a background sub-agent's final report streamed into the
        // chat as if the session had written it, its tool calls swelled the
        // gear, and all of it vanished on the next history read — sub-agent
        // threads live in their own files (10.10.2026). The parent sees the
        // result as the Agent tool's result, which is where clients show it.
        if (isSubagentMessage(msg)) {
          const sub = msg as { parent_tool_use_id?: unknown; message?: { content?: unknown } };
          if (typeof sub.parent_tool_use_id === 'string'
            && this.subagents.noteSubagentCalls(sub.parent_tool_use_id, sub.message?.content)) {
            // Its plan moved: a card's «3/5» is a status change, not a tick.
            this.publishSubagents(true);
          }
          break;
        }
        const m = msg as { message?: { content?: unknown[] }; error?: string; aborted?: boolean };
        // The API refused or cut this message (rate_limit, overloaded,
        // max_output_tokens, …). The CLI usually retries on its own; say what
        // happened so a pause has a name.
        if (typeof m.error === 'string' && m.error) {
          this.lastApiFailure = { ...this.lastApiFailure, kind: m.error };
          this.handlers.onEvent({ kind: 'status', code: 'model_error', text: `ошибка модели: ${m.error}`, raw: msg });
        } else if (m.message?.content?.length) {
          // The API answered: whatever a retry complained about is past.
          this.lastApiFailure = undefined;
        }
        const totalTokens = this.turnUsage.receive(m.message);
        if (totalTokens !== undefined) this.handlers.onEvent({ kind: 'status', code: 'turn_usage', text: '', data: { totalTokens } });
        const content = m.message?.content ?? [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block['type'] === 'text' && typeof block['text'] === 'string') {
            this.handlers.onEvent({ kind: 'assistant', text: block['text'] as string, raw: block });
          } else if (block['type'] === 'tool_use') {
            if ((block['name'] === 'Agent' || block['name'] === 'Task') && typeof block['id'] === 'string') {
              this.subagents.noteCall(block['id'], block['input']);
            }
            if (isPlanTool(typeof block['name'] === 'string' ? block['name'] : undefined)) this.notePlan(block['input']);
            this.handlers.onEvent({
              kind: 'tool_use',
              text: `${String(block['name'])} ${JSON.stringify(block['input'])}`,
              // The call's id: what a sub-agent card in the live transcript
              // is anchored on (`Subagent.toolUseId`).
              ...(typeof block['id'] === 'string' ? { data: { id: block['id'] } } : {}),
              raw: block,
            });
            if (typeof block['id'] === 'string') {
              for (const event of this.imageGen.toolUse(block['id'], block['name'], block['input'])) {
                this.handlers.onEvent(event);
              }
            }
          }
        }
        if (m.aborted) {
          this.handlers.onEvent({ kind: 'status', code: 'aborted', text: 'ход прерван', raw: msg });
        }
        break;
      }
      case 'stream_event': {
        if (isSubagentMessage(msg)) break;
        const ev = (msg as { event?: { delta?: { type?: string; text?: string } } }).event;
        if (ev?.delta?.type === 'text_delta' && ev.delta.text) {
          this.handlers.onEvent({ kind: 'partial', text: ev.delta.text, raw: msg });
        }
        break;
      }
      case 'result':
        for (const event of this.imageGen.abandon()) this.handlers.onEvent(event);
        this.emitResult(msg as SDKMessage & { type: 'result' });
        break;
      case 'rate_limit_event': {
        const info = (msg as { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number } })
          .rate_limit_info;
        if (!info || info.status === 'allowed') break;
        // The line clients without the web's strip print (iOS, Telegram). It
        // was «approaching the rate limit (seven_day)» — without the one number
        // that matters. `utilization` is a fraction; the CLI floors ×100.
        const when = typeof info.resetsAt === 'number' ? ` — сброс ${new Date(info.resetsAt * 1000).toLocaleString('ru-RU')}` : '';
        const window = RATE_LIMIT_WINDOW[info.rateLimitType ?? ''] ?? 'лимит подписки';
        const pct = typeof info.utilization === 'number' && info.utilization > 0 ? Math.min(100, Math.floor(info.utilization * 100)) : undefined;
        const text =
          info.status === 'rejected'
            ? `исчерпан ${window}${when}`
            : pct !== undefined
              ? `использовано ${pct}% — ${window}${when}`
              : `близко к лимиту — ${window}${when}`;
        this.handlers.onEvent({
          kind: 'status',
          code: 'rate_limit',
          text,
          data: { ...info },
          raw: msg,
        });
        break;
      }
      default:
        // Everything else (hook progress, task notifications, tool progress,
        // plugin installs, memory recall …) is machinery a client does not need
        // to see a line for.
        break;
    }
  }

  /** `type: 'system'` messages, by subtype. */
  private emitSystem(msg: SDKMessage & { type: 'system' }): void {
    const m = msg as {
      subtype?: string;
      session_id?: string;
      model?: string;
      cwd?: string;
      tools?: string[];
      permissionMode?: PermissionMode;
    };
    // Both the init message and the status message (subtype 'status') carry
    // the live permission mode — surface it so the UI indicator stays honest
    // (e.g. after the model runs ExitPlanMode and leaves plan mode).
    if (typeof m.permissionMode === 'string') {
      this.handlers.onModeChange?.(m.permissionMode);
    }
    // Same reasoning for the model: init and status both name it, and it is
    // the resolved wire id — the only answer to "what is `default` running".
    if (typeof m.model === 'string' && m.model) {
      this.subagents?.setDefaultModel(m.model);
      this.handlers.onActiveModel?.(m.model);
    }
    const k = (n?: number) => (typeof n === 'number' ? `${Math.round(n / 1000)}k` : '?');
    switch (m.subtype) {
      case 'init': {
        // A fresh session's real id is minted here — report it so the hub/UI
        // can bind the run (which started with an empty placeholder id).
        if (m.session_id) this.handlers.onSessionId?.(m.session_id);
        if (m.model) {
          this.handlers.onEvent({
            kind: 'system',
            text: `init model=${m.model} cwd=${m.cwd ?? '?'} tools=${m.tools?.length ?? 0}`,
            raw: msg,
          });
        }
        break;
      }
      case 'compact_boundary': {
        // The CLI just compacted — say so in the transcript. Silent
        // compaction is how a session appears to "lose" its history: the
        // turns are gone from the window and nothing explains where.
        const meta = (msg as { compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number; duration_ms?: number } })
          .compact_metadata;
        const how = meta?.trigger === 'manual' ? 'compacted' : 'auto-compacted';
        this.compactInFlight = false;
        this.handlers.onEvent({
          kind: 'status',
          code: 'compact_done',
          text: `context ${how}: ${k(meta?.pre_tokens)} → ${k(meta?.post_tokens)} tokens`,
          data: {
            trigger: meta?.trigger ?? 'auto',
            ...(typeof meta?.pre_tokens === 'number' ? { pre_tokens: meta.pre_tokens } : {}),
            ...(typeof meta?.post_tokens === 'number' ? { post_tokens: meta.post_tokens } : {}),
            ...(typeof meta?.duration_ms === 'number' ? { duration_ms: meta.duration_ms } : {}),
          },
          raw: msg,
        });
        break;
      }
      case 'status': {
        // `status` is the CLI's own spinner: `compacting` / `requesting` /
        // null, plus the verdict of a compaction it just ran. The verdict is
        // the part that matters: a FAILED compaction used to produce no line
        // at all, and the «Сжимаю…» button sat there until its 15-minute net.
        const s = msg as { status?: string | null; compact_result?: string; compact_error?: string };
        if (s.compact_result === 'failed') {
          this.compactInFlight = false;
          this.handlers.onEvent({
            kind: 'status',
            code: 'compact_failed',
            text: `⚠ compaction failed: ${s.compact_error ?? 'Claude не назвал причину'}`,
            raw: msg,
          });
        } else if (s.compact_result === 'success' && this.compactInFlight) {
          // The boundary message normally reports success first; this is the
          // fallback for a runtime that sends the verdict without one.
          this.compactInFlight = false;
          this.handlers.onEvent({ kind: 'status', code: 'compact_done', text: 'context compacted', raw: msg });
        } else if (s.status === 'compacting') {
          this.compactInFlight = true;
          this.handlers.onEvent({ kind: 'status', code: 'compact_started', text: 'compacting context…', raw: msg });
        } else if (s.status === 'requesting') {
          // A heartbeat, not a line: it fires on every API request, and a
          // turn is many of them. Clients hide it; the hub notes the moment.
          this.handlers.onEvent({ kind: 'status', code: 'requesting', text: '', raw: msg });
        }
        break;
      }
      case 'api_retry': {
        // The CLI is retrying a failed API call on its own. Without this line
        // a 529 storm looked like a dead session: «working…» for minutes,
        // nothing arriving, nothing explaining. Now the wait has a name and a
        // countdown.
        const r = msg as { attempt?: number; max_retries?: number; retry_delay_ms?: number; error_status?: number | null; error?: string };
        const secs = Math.max(1, Math.round((r.retry_delay_ms ?? 0) / 1000));
        this.lastApiFailure = { kind: r.error, status: r.error_status };
        // A 401 does not heal by waiting, and the CLI retries it ten times —
        // minutes of «working». Say what it is on the first line, not after.
        const why =
          r.error === 'authentication_failed' || r.error_status === 401
            ? 'API 401: Claude не принимает вход на этой машине'
            : r.error_status
              ? `API ${r.error_status}`
              : 'нет связи с API';
        this.handlers.onEvent({
          kind: 'status',
          code: 'api_retry',
          text: `${why}${r.error ? ` (${r.error})` : ''} — повтор ${r.attempt ?? '?'}/${r.max_retries ?? '?'} через ${secs} с`,
          data: {
            attempt: r.attempt,
            max_retries: r.max_retries,
            retry_delay_ms: r.retry_delay_ms,
            error_status: r.error_status ?? null,
            ...(r.error ? { error: r.error } : {}),
          },
          raw: msg,
        });
        break;
      }
      case 'session_state_changed': {
        // idle | running | requires_action — a heartbeat the hub can date.
        const state = (msg as { state?: string }).state;
        this.handlers.onEvent({ kind: 'status', code: 'session_state', text: '', data: { state }, raw: msg });
        this.settle.sessionState(state);
        break;
      }
      case 'background_tasks_changed': {
        // A level, not an edge: the full set of live background tasks after
        // each change (REPLACE semantics). The settle clock only needs its
        // size; the hub and the viewers need the list itself. Without it a
        // turn that ends on «запустил в фоне, жду» read as DONE everywhere —
        // the hub pushed «готово», the chat showed nothing for the 25 minutes
        // the task ran, and the CLI's own wake-up looked like a ghost.
        const raw = (msg as { tasks?: unknown }).tasks;
        this.backgroundRaw = raw;
        this.settle.backgroundTasks(Array.isArray(raw) ? raw.length : 0);
        this.publishBackgroundTasks();
        break;
      }
      case 'local_command_output': {
        // What a slash command printed («Not enough messages to compact.»).
        const content = (msg as { content?: string }).content?.trim();
        if (content) {
          this.handlers.onEvent({ kind: 'status', code: 'command_output', text: content, raw: msg });
          if (/not enough messages to compact/i.test(content)) {
            this.compactInFlight = false;
            this.handlers.onEvent({ kind: 'status', code: 'compact_failed', text: content, raw: msg });
          }
        }
        break;
      }
      case 'informational': {
        const i = msg as { content?: string; level?: string };
        if (i.content && i.level !== 'info') {
          this.handlers.onEvent({ kind: 'status', code: 'notification', text: i.content, raw: msg });
        }
        break;
      }
      case 'notification': {
        const n = msg as { text?: string; priority?: string };
        if (n.text && n.priority !== 'low') {
          this.handlers.onEvent({ kind: 'status', code: 'notification', text: n.text, raw: msg });
        }
        break;
      }
      case 'permission_denied': {
        const d = msg as { tool_name?: string; decision_reason_type?: string; decision_reason?: string };
        this.handlers.onEvent({
          kind: 'status',
          code: 'permission_denied',
          text: permissionDeniedText(d.tool_name, d.decision_reason_type, d.decision_reason),
          raw: msg,
        });
        break;
      }
      case 'model_refusal_fallback': {
        const f = msg as { original_model?: string; fallback_model?: string };
        this.handlers.onEvent({
          kind: 'status',
          code: 'notification',
          text: `${f.original_model ? `Модель ${f.original_model}` : 'Модель'} отказалась отвечать — пробую ${f.fallback_model ?? 'запасную'}`,
          raw: msg,
        });
        break;
      }
      case 'model_refusal_no_fallback': {
        const f = msg as { content?: string };
        this.handlers.onEvent({
          kind: 'status',
          code: 'notification',
          text: f.content || 'Модель отказалась выполнять этот запрос',
          raw: msg,
        });
        break;
      }
      default:
        break;
    }
  }

  /** The end of a turn — successful or not. Never the end of the run. */
  private emitResult(msg: SDKMessage & { type: 'result' }): void {
    const m = msg as {
      subtype?: string;
      result?: string;
      is_error?: boolean;
      errors?: string[];
      total_cost_usd?: number;
      usage?: unknown;
      num_turns?: number;
      duration_ms?: number;
      duration_api_ms?: number;
      permission_denials?: unknown[];
    };
    const data: Record<string, unknown> = {
      ...(m.subtype ? { subtype: m.subtype } : {}),
      ...(typeof m.total_cost_usd === 'number' ? { total_cost_usd: m.total_cost_usd } : {}),
      ...(m.usage && typeof m.usage === 'object' ? { usage: m.usage } : {}),
      ...(typeof m.num_turns === 'number' ? { num_turns: m.num_turns } : {}),
      ...(typeof m.duration_ms === 'number' ? { duration_ms: m.duration_ms } : {}),
      ...(typeof m.duration_api_ms === 'number' ? { duration_api_ms: m.duration_api_ms } : {}),
      ...(m.permission_denials?.length ? { permission_denials: m.permission_denials.length } : {}),
    };
    this.turnUsage.reset();
    const apiFailure = this.lastApiFailure;
    this.lastApiFailure = undefined;
    if (m.is_error) {
      this.pendingResult = undefined;
      this.settle.input();
      // A failed TURN (error_during_execution, error_max_turns, a connection
      // closed mid-response). The runtime is still up and takes the next
      // message — the error is reported and the run stays open, which is what
      // a terminal does. `errors[]` is where the CLI puts the actual reason;
      // `result` is absent on this shape, so reading it gave a bare subtype.
      const reason = m.errors?.filter(Boolean).join('; ') || m.result || describeResultSubtype(m.subtype);
      // The cause, when the API named one — the CLI's `errors[]` is only its
      // own diagnostic («[ede_diagnostic] result_type=user …»). Kept in `data`
      // for whoever debugs; the person reads what to do.
      const status = (m as { api_error_status?: number | null }).api_error_status ?? apiFailure?.status;
      const known = describeApiFailure(apiFailure?.kind, status);
      if (known) {
        console.warn(`[agent] turn failed: ${known.code} (${apiFailure?.kind ?? '-'} ${status ?? '-'}); cli said: ${reason}`);
        this.handlers.onEvent({
          kind: 'error',
          code: known.code,
          text: known.text,
          data: { ...data, detail: reason, ...(status ? { api_error_status: status } : {}), ...(apiFailure?.kind ? { api_error: apiFailure.kind } : {}) },
          raw: msg,
        });
        return;
      }
      // Not one we can name (a rate limit is left to the budget classifier,
      // which reads the status out of this text).
      const named = apiFailure?.kind || status ? `${reason} (API ${status ?? ''} ${apiFailure?.kind ?? ''})`.replace(/\s+\)/, ')') : reason;
      this.handlers.onEvent(modelErrorEvent(named, msg, { data }));
      return;
    }
    // A CLI result can just mean ‘waiting for my background agent’. Every
    // consumer treats result as completion, so release it only at settlement.
    this.pendingResult = {
      kind: 'result',
      text: m.result ?? m.subtype ?? 'done',
      data,
      raw: msg,
    };
    this.settle.result();
  }

  private finishSettledTurn(): void {
    const result = this.pendingResult;
    this.pendingResult = undefined;
    if (!result) return;
    this.handlers.onEvent(result);
    this.handlers.onEvent({ kind: 'status', code: 'turn_settled', text: '' });
  }

  /** The session's own plan moved: its «done/total» goes to the hub for the
   *  Live Activity row (clients draw the plan from the transcript). */
  private notePlan(input: unknown): void {
    const items = planItems(input);
    if (!items) return;
    const progress = planProgress(items, true);
    this.planShown = progress.total > 0;
    // Absent keys, never null: `active`/`steps` only when there are any.
    this.handlers.onEvent({ kind: 'status', code: 'plan_progress', text: '', data: { ...progress } });
  }

  /** Push a new user turn into the running session, optionally with images. */
  sendInput(text: string, images?: ImageInput[]): void {
    // A new task: the last one's plan is no longer this session's progress.
    // `/compact` is ours, not the person's: the same task goes on after it.
    if (this.planShown && text !== '/compact') {
      this.planShown = false;
      this.handlers.onEvent({ kind: 'status', code: 'plan_progress', text: '', data: { done: 0, total: 0 } });
    }
    this.pendingResult = undefined;
    this.settle.input();
    const message = userMessage(text, images);
    if (!this.startupSettings) {
      this.input.push(message);
      return;
    }
    // A session that asked for `xhigh` and whose opening turn ran at the
    // account default got neither what was picked nor a visible failure, so the
    // first turn waits. Chaining onto the same promise rather than each turn
    // awaiting it separately keeps two quick turns in the order they were
    // typed; `InputQueue.push` is a no-op after `end()`, so a run closed while a
    // turn is still queued drops it instead of throwing.
    this.startupSettings = this.startupSettings.then(() => {
      this.input.push(message);
    });
  }

  /**
   * Interrupt the current turn (streaming mode only).
   *
   * Bounded, because a control request has no timeout of its own: it resolves
   * when the CLI answers and never otherwise. A CLI that has wedged — the one
   * case a person reaches for Stop — therefore left the button doing nothing,
   * forever, with no message. Past the bound the run is closed outright and
   * says so; the session itself is untouched and resumes on the next message.
   */
  async interrupt(): Promise<void> {
    const answered = await withTimeout(this.query.interrupt(), CONTROL_TIMEOUT_MS.interrupt);
    if (answered !== TIMED_OUT) return;
    this.handlers.onEvent({
      kind: 'error',
      code: 'stopped',
      text: `Claude не ответил на «стоп» за ${CONTROL_TIMEOUT_MS.interrupt / 1000} с — запуск закрыт; напишите сообщение, чтобы продолжить сессию`,
      fatal: true,
    });
    this.close();
  }

  /** Switch the model for subsequent turns (streaming mode only). */
  async setModel(model?: string): Promise<void> {
    if ((await withTimeout(this.query.setModel(model), CONTROL_TIMEOUT_MS.setting)) === TIMED_OUT) {
      throw new Error(noAnswer('смену модели'));
    }
  }

  /** Change the permission mode for subsequent turns (streaming mode only). */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // A client may ask for a mode this machine does not offer — an older web
    // build, a stale picker, a hand-sent frame. Refusing here rather than at the
    // SDK keeps the reason legible: without it the switch fails deep in the CLI
    // and the session looks like it simply ignored the control.
    if (mode === 'bypassPermissions' && !bypassAllowed()) {
      throw new Error('На этой машине нельзя работать без подтверждений.');
    }
    if ((await withTimeout(this.query.setPermissionMode(mode), CONTROL_TIMEOUT_MS.setting)) === TIMED_OUT) {
      throw new Error(noAnswer('смену режима'));
    }
  }

  /**
   * Set reasoning effort / ultracode for subsequent turns (streaming mode only).
   * `ultracode` = xhigh effort + workflow orchestration; a plain effort clears it.
   * Passing no effort clears the flag layer back to the account default.
   */
  async setEffort(effort?: 'low' | 'medium' | 'high' | 'xhigh', ultracode?: boolean): Promise<void> {
    const applied = ultracode
      ? this.query.applyFlagSettings({ ultracode: true, effortLevel: 'xhigh' })
      : this.query.applyFlagSettings({ ultracode: false, effortLevel: effort ?? null });
    if ((await withTimeout(applied, CONTROL_TIMEOUT_MS.setting)) === TIMED_OUT) {
      throw new Error(noAnswer('смену усилия'));
    }
  }

  /**
   * Context budget, straight from the CLI. Optional on the wire and optional
   * here: an older runtime simply has no `getContextUsage`, and a session that
   * can't report its budget must not take the run down with it.
   */
  async contextUsage(): Promise<ContextUsage | undefined> {
    const q = this.query as unknown as {
      getContextUsage?: () => Promise<{
        totalTokens: number;
        maxTokens: number;
        percentage: number;
        autoCompactThreshold?: number;
        isAutoCompactEnabled: boolean;
        model?: string;
      }>;
    };
    if (typeof q.getContextUsage !== 'function') return undefined;
    try {
      // Bounded: this is polled every 15s for every run on the machine, and a
      // request that never answers used to stack one more pending promise per
      // tick behind a wedged CLI — and, because the poll awaited runs in turn,
      // froze the meter for every OTHER run on the box as well.
      const u = await withTimeout(q.getContextUsage(), CONTROL_TIMEOUT_MS.query);
      if (u === TIMED_OUT || !u) return undefined;
      return {
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        percentage: u.percentage,
        ...(u.autoCompactThreshold === undefined ? {} : { autoCompactThreshold: u.autoCompactThreshold }),
        autoCompactEnabled: u.isAutoCompactEnabled,
        ...(u.model ? { model: u.model } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Compact on demand. There is no control method for this — compaction is the
   * CLI's own slash command, so it goes in as a user turn. The run reports back
   * through the `compact_boundary` system message either way, so the caller
   * doesn't have to guess whether it took.
   */
  async compact(): Promise<void> {
    // Say it was QUEUED, not just that it finished.
    //
    // `/compact` goes in as a user turn, so it waits behind whatever the run is
    // doing — measured at 1m52s on 19.09.2026 (queued 12:28:17, boundary
    // 12:30:09). Two minutes of a button that answers nothing reads as a dead
    // button, so the person presses it again; the second `/compact` runs right
    // after the first and the CLI answers «Not enough messages to compact.» —
    // because the first one just compacted everything. The whole thing worked,
    // and the only evidence the user got was a refusal.
    //
    // Three codes tell the story to a client: `compact_started` here (queued),
    // again from the CLI's own `status: compacting` when it actually begins,
    // then `compact_done` from the boundary or `compact_failed` from the
    // verdict / the «not enough messages» line. Clients key on the codes, so
    // the words here can change.
    this.compactInFlight = true;
    this.handlers.onEvent({ kind: 'status', code: 'compact_started', text: 'compacting context… (queued behind the current turn)' });
    this.sendInput('/compact');
  }

  /**
   * Models this runtime offers. Worth asking rather than hardcoding: the built-in
   * list went a whole generation stale before anyone noticed, and the CLI has
   * always known the real answer.
   */
  async supportedModels(): Promise<ModelInfoLite[] | undefined> {
    const q = this.query as unknown as {
      supportedModels?: () => Promise<
        {
          value: string;
          displayName?: string;
          resolvedModel?: string;
          supportsEffort?: boolean;
          supportedEffortLevels?: string[];
        }[]
      >;
    };
    if (typeof q.supportedModels !== 'function') return undefined;
    try {
      const rows = await withTimeout(q.supportedModels(), CONTROL_TIMEOUT_MS.query);
      if (rows === TIMED_OUT || !rows) return undefined;
      // `resolvedModel` and the effort levels are carried through deliberately:
      // the run reports the RESOLVED model as what it is running, so without the
      // alias mapping a picker cannot mark its own row as current, and without
      // the levels it offers efforts the model will ignore.
      const models = rows
        .filter((r) => r && typeof r.value === 'string' && r.value)
        .map((r): ModelInfoLite => ({
          id: r.value,
          ...(r.displayName ? { name: r.displayName } : {}),
          ...(r.resolvedModel ? { resolved: r.resolvedModel } : {}),
          ...(r.supportedEffortLevels?.length ? { efforts: r.supportedEffortLevels } : {}),
          ...(typeof r.supportsEffort === 'boolean' ? { supportsEffort: r.supportsEffort } : {}),
        }));
      return models.length ? models : undefined;
    } catch {
      return undefined;
    }
  }

  /** The runtime's own «/» list. Asked of the live `Query` because only it
   *  knows the built-ins and the plugin skills; see slash-commands.ts for the
   *  on-disk fallback when no run is up. */
  async supportedCommands(): Promise<SlashCommandInfo[] | undefined> {
    const q = this.query as unknown as {
      supportedCommands?: () => Promise<{ name: string; description?: string; argumentHint?: string }[]>;
    };
    if (typeof q.supportedCommands !== 'function') return undefined;
    try {
      const rows = await withTimeout(q.supportedCommands(), CONTROL_TIMEOUT_MS.query);
      if (rows === TIMED_OUT || !rows) return undefined;
      const out = rows
        .filter((r) => r && typeof r.name === 'string' && r.name)
        .map((r): SlashCommandInfo => ({
          name: r.name.replace(/^\//, ''),
          ...(r.description ? { description: r.description.slice(0, 300) } : {}),
          ...(r.argumentHint ? { argumentHint: r.argumentHint.slice(0, 100) } : {}),
        }));
      return out.length ? out : undefined;
    } catch {
      return undefined;
    }
  }

  /** Stop one sub-agent — or another background task the panel lists (a
   *  Bash with `run_in_background`); the turn and the others go on. */
  async stopSubagent(id: string): Promise<boolean> {
    if (!this.subagents.isRunning(id) && !this.backgroundSince.has(id)) return false;
    const q = this.query as unknown as { stopTask?: (taskId: string) => Promise<void> };
    if (typeof q.stopTask !== 'function') return false;
    const answered = await withTimeout(q.stopTask(id), CONTROL_TIMEOUT_MS.stopTask);
    if (answered === TIMED_OUT) return false;
    if (this.subagents.stopped(id)) this.publishSubagents(true);
    return true;
  }

  private publishBackgroundTasks(): void {
    const tasks = backgroundTaskList(this.backgroundRaw, this.backgroundSince, Date.now(), (id) => this.subagents.taskOwner(id));
    this.handlers.onEvent({ kind: 'status', code: 'background_tasks', text: '', data: { tasks } });
  }

  /**
   * Send the sub-agent set. A status change goes at once; a progress tick
   * (tokens, «сейчас: …») at most every SUBAGENT_TICK_MS — a busy agent
   * reports per tool call, and every frame is replayed to every viewer.
   */
  private publishSubagents(now: boolean): void {
    this.subagentsDirty = true;
    if (now) {
      if (this.subagentTimer) clearTimeout(this.subagentTimer);
      this.subagentTimer = undefined;
      this.flushSubagents();
      return;
    }
    if (this.subagentTimer) return;
    this.subagentTimer = setTimeout(() => {
      this.subagentTimer = undefined;
      this.flushSubagents();
    }, SUBAGENT_TICK_MS);
    this.subagentTimer.unref?.();
  }

  private flushSubagents(): void {
    if (!this.subagentsDirty) return;
    this.subagentsDirty = false;
    this.handlers.onEvent({ kind: 'status', code: 'subagents', text: '', data: { agents: this.subagents.snapshot() } });
  }

  /** End input and forcefully tear down the underlying CLI subprocess. */
  close(): void {
    if (this.subagentTimer) clearTimeout(this.subagentTimer);
    this.subagentTimer = undefined;
    this.settle.dispose();
    this.input.end();
    this.query.close();
  }
}

/** How long a launch-time setting may hold the first turn. Generous, because a
 *  control request normally answers in milliseconds — this is a deadlock guard,
 *  not a latency budget. */
const STARTUP_SETTING_TIMEOUT_MS = 10_000;

/**
 * How long a control request may go unanswered before the agent stops
 * waiting. The SDK gives these no timeout at all — `interrupt`, `setModel`,
 * `getContextUsage` resolve when the CLI answers and never otherwise — so a
 * wedged CLI turned every control into a promise that hung forever. These are
 * deadlock guards; a healthy CLI answers in milliseconds.
 */
export const CONTROL_TIMEOUT_MS = {
  /** Stop must be decisive: past this the run is closed instead. */
  interrupt: 8_000,
  /**
   * Model / mode / effort changes: past this they are reported as a failed
   * control. Long on purpose. A CLI that is booting or between steps answers
   * late, not never, and the change then DOES take effect — at 10 s every
   * switch made in a fresh session's first half-minute read «не ответил» while
   * the run went on in the new model and the picker stayed on the old one
   * (16.10.2026). The person hears about a slow answer at
   * `CONTROL_SLOW_NOTICE_MS` instead (run-manager).
   */
  setting: 180_000,
  /** Stopping one background task: the panel button waits on this. */
  stopTask: 10_000,
  /** Read-only polls (context usage, model list): a miss is a missing reading. */
  query: 5_000,
} as const;

/** When a setting change still unanswered is worth a line: «applies once
 *  Claude answers». Not a failure — see `CONTROL_TIMEOUT_MS.setting`. */
export const CONTROL_SLOW_NOTICE_MS = 10_000;

/**
 * What `withTimeout` resolves to when the answer did not come in time.
 *
 * A unique symbol, never a falsy value. It used to be `false`, and the callers
 * tested `!answer` — but `setModel`, `setPermissionMode` and
 * `applyFlagSettings` resolve to `undefined` when the CLI ACCEPTS, and an older
 * CLI's `interrupt` does too. So every successful switch was reported as «the
 * runtime did not answer the model change in 10s», the picker was never told,
 * and the model changed anyway on the next step: 27 such lines on one machine
 * in four days before anyone read the code (24.09.2026).
 */
export const TIMED_OUT: unique symbol = Symbol('control request timed out');


/** `promise`'s value — whatever it is, `undefined` included — or `TIMED_OUT`
 *  if it has not settled within `ms`. A rejection still rejects — a refusal is
 *  an answer, only silence is what this bounds. Compare with `=== TIMED_OUT`,
 *  never by truthiness. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  // The timer is cleared on settle: with a 180 s bound on settings, a timer
  // left to run out would pin each answered request for three minutes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function noAnswer(what: string): string {
  return `Claude не ответил на ${what} за ${CONTROL_TIMEOUT_MS.setting / 1000} с`;
}

/** A human sentence for a `result` subtype when the CLI gave no `errors[]`. */
function describeResultSubtype(subtype?: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'ход упёрся в предел шагов';
    case 'error_max_budget_usd':
      return 'ход упёрся в бюджет';
    case 'error_max_structured_output_retries':
      return 'модель не смогла ответить в нужном формате';
    case 'error_during_execution':
      return 'ход прервался из-за ошибки (API или инструмента)';
    default:
      return subtype ?? 'ход не удался';
  }
}

/** Why the CLI refused a tool call, in words — the discriminator alone
 *  («Bash was denied (subcommandResults)») read as a crash to the person. */
const DENIAL_WHY: Record<string, string> = {
  rule: 'запрещено правилом в настройках',
  subcommandResults: 'часть составной команды задела запрет в настройках',
  hook: 'остановлено хуком',
  mode: 'не разрешено текущим режимом',
  classifier: 'отклонено автоматической проверкой',
  safetyCheck: 'отклонено проверкой безопасности',
  workingDir: 'путь вне рабочей папки',
  sandboxOverride: 'запрещено песочницей',
  permissionPromptTool: 'отклонено при запросе разрешения',
  asyncAgent: 'фоновой задаче нельзя спрашивать разрешение',
};

export function permissionDeniedText(tool?: string, type?: string, reason?: string): string {
  const why = (type && DENIAL_WHY[type]) || 'отказано в разрешении';
  // The deciding component's own words, when it gave any. May carry ANSI.
  // eslint-disable-next-line no-control-regex
  const own = reason?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
  const detail = own ? `: ${own.length > 200 ? `${own.slice(0, 199)}…` : own}` : '';
  return `${tool ?? 'Инструмент'} не выполнен — ${why}${detail}`;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Throttle for sub-agent progress frames (status changes are immediate). */
const SUBAGENT_TICK_MS = 1500;

/** A tool_result's content as text: a string, or the text blocks of a list. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** At most this many tasks go on the wire; the count the settle clock uses is the full one. */
export const BACKGROUND_TASKS_MAX = 32;

/** One live background task as the hub and the viewers see it. */
export interface BackgroundTask {
  id: string;
  type: string;
  description: string;
  /** ms epoch the agent first saw it — survives a viewer reloading. */
  since: number;
  /** The sub-agent that started it; absent for the session's own tasks. */
  owner?: string;
  /** That sub-agent's task id: two helpers can share a name. */
  ownerId?: string;
}

/**
 * The SDK's `background_tasks_changed.tasks` → what goes on the wire.
 * Malformed rows are dropped, descriptions capped (a Bash description can be
 * the whole command), and `since` kept per id across calls: the map is
 * rewritten to exactly the live set, so a finished task forgets its start.
 */
export function backgroundTaskList(
  raw: unknown,
  since: Map<string, number>,
  now = Date.now(),
  ownerOf: (id: string) => BackgroundTaskOwner | undefined = () => undefined,
): BackgroundTask[] {
  const out: BackgroundTask[] = [];
  const live = new Set<string>();
  for (const t of Array.isArray(raw) ? raw : []) {
    if (!t || typeof t !== 'object') continue;
    const r = t as { task_id?: unknown; task_type?: unknown; description?: unknown };
    if (typeof r.task_id !== 'string' || !r.task_id) continue;
    live.add(r.task_id);
    const at = since.get(r.task_id) ?? now;
    since.set(r.task_id, at);
    const owner = ownerOf(r.task_id);
    out.push({
      id: r.task_id,
      type: typeof r.task_type === 'string' ? r.task_type : '',
      description: (typeof r.description === 'string' ? r.description : '').slice(0, 200),
      since: at,
      ...(owner ? { owner: owner.name, ownerId: owner.id } : {}),
    });
  }
  for (const id of [...since.keys()]) if (!live.has(id)) since.delete(id);
  // A list is for a person to read, and it is replayed whole to every viewer
  // who opens the session — a runaway fan-out must not become a megabyte frame.
  return out.slice(0, BACKGROUND_TASKS_MAX);
}
