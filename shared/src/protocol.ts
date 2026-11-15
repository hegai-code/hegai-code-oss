import { z } from 'zod';
import { E2eField } from './e2e.js';
import { HistoryMessageSchema, MachineStatsSchema, RpcMethodSchema } from './rpc.js';
import { FILE_B64_MAX, IMAGE_B64_MAX } from './limits.js';

/**
 * Wire protocol shared by the agent daemon, the central service, and (later)
 * the browser. Every message is a discriminated union on `type` and is
 * validated with zod at both ends. The transport (WebSocket over a Tailscale
 * tailnet) is intentionally not encoded here — this file is transport-agnostic.
 */

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** OS family a machine runs, used for display + service-install hints. */
export const OsKind = z.enum(['mac', 'windows', 'linux']);
export type OsKind = z.infer<typeof OsKind>;

/**
 * A single Claude Code session as seen by an agent. Combines the SDK's
 * `listSessions()` output with our own liveness overlay (whether a live
 * process — typically the VSCode extension — currently holds the session).
 */
export const SessionSummary = z.object({
  sessionId: z.string(),
  /** Human title: custom title, summary, or first prompt. */
  title: z.string(),
  /** Nobody chose this title: it is the CLI's own guess or the first prompt.
   *  The hub may replace it with one written from the session's real work
   *  (`server-rs/src/hub/titles.rs`). Absent = a person named it, or an agent
   *  too old to say — both mean hands off. */
  titleDerived: z.boolean().optional(),
  /** Which CLI produced this session. Absent = 'claude' (back-compat). Codex
   *  sessions are discovered from ~/.codex/sessions and are view-only for now
   *  (resume runs through the Claude Agent SDK, which can't drive Codex). */
  source: z.enum(['claude', 'codex']).optional(),
  /** Who serves the session when it is not the runtime's own vendor; 'opencode' =
   *  a Codex thread on OpenCode Go. A plain string on purpose: an enum would fail
   *  the whole snapshot on a value a newer agent adds. */
  provider: z.string().optional(),
  cwd: z.string().optional(),
  /** Project label derived from cwd (last path segment). */
  project: z.string().optional(),
  gitBranch: z.string().optional(),
  /** When the session last really moved — what every list sorts by. For a
   *  Claude session this is its last rendered record when only CLI
   *  bookkeeping (`cost-state`, `last-prompt`, …) follows it. */
  lastModified: z.number(),
  /** The transcript file's own mtime, when it differs from `lastModified`:
   *  the replica's sync cursor (the agent's `syncedMtime`, the hub's
   *  freshness check). Absent = `lastModified`. Not for display. */
  fileMtime: z.number().optional(),
  createdAt: z.number().optional(),
  /**
   * Who started this session: `cli`, `claude-vscode`, `cc-remote` (our own
   * resume), or `sdk-*` — headless `claude -p`, i.e. cron jobs and scripts.
   * Read from ~/.claude/sessions/<pid>.json while a process holds it, and from
   * the transcript's own records afterwards. The second source is what lets a
   * finished automated run be told apart from a person's work: a 20-minute
   * cron loop otherwise buries a project's history under its own runs.
   */
  entrypoint: z.string().optional(),
  /**
   * Set by the AGENT: the first prompt is a scripted check («…Ответь одним
   * словом: ок»), whatever title it later got. Clients hide it with the rest
   * of `isAutomatedSession`. Read from the prompt because the title is often
   * an AI summary that no longer carries the marker.
   */
  automated: z.boolean().optional(),
  cliVersion: z.string().optional(),
  /**
   * PID of a live process currently holding this session (from
   * ~/.claude/sessions/<pid>.json, verified alive). Present => do NOT resume:
   * a second writer corrupts the .jsonl.
   */
  livePid: z.number().optional(),
  /**
   * Set by the HUB, never by an agent: the transcript file is gone from the
   * machine (Claude Code's 30-day cleanup, a wiped home) but the hub's replica
   * still holds the history. Readable, never resumable — `open` is refused.
   * A session a person deleted on purpose is not listed at all.
   */
  archived: z.boolean().optional(),
  /**
   * What the process holding `livePid` is doing, from the `status` it writes
   * into its own pid file: `busy` mid-turn, `waiting` blocked on a person's
   * answer (a permission prompt, a question), `idle` done and waiting for the
   * next message. Only ever present alongside `livePid`. This is what separates «идёт работа» from
   * an editor window left open for days — both carry a `livePid`, only one is
   * working. Absent from an older CLI or agent: read that as «not known to be
   * working», never as busy.
   */
  liveStatus: z.enum(['busy', 'waiting', 'idle']).optional(),
  /**
   * Codex-only liveness heuristic: the rollout file was written within a short
   * recency window (mtime). Display-only — never gates the single-writer lock
   * (Codex has no editor pid; it must stay out of the resume/takeover path).
   */
  active: z.boolean().optional(),
  /**
   * Who created this session, injected by the hub from its session-owner map
   * (agents never report it). Absent for legacy/unowned sessions. Drives the
   * owner badge and the employee visibility filter (own + teammates, never the
   * device owner's).
   */
  owner: z
    .object({ userId: z.string(), email: z.string().optional(), fullName: z.string().optional() })
    .optional(),
  /**
   * Session category (see categories.ts), injected by the hub. Absent for
   * sessions created without one. Shown as a chip; filterable.
   */
  category: z.string().optional(),
  /**
   * Kanban stage (see stages.ts), injected by the hub from its session-meta map.
   * MUTABLE (unlike category): the Flow board updates it via `set_stage`. Absent
   * until a stage is assigned — such sessions are off the board.
   */
  stage: z.string().optional(),
  /** Private machine (docs/E2EE.md): `title` is then a placeholder and the real
   *  one travels here; `cwd` / `project` / `gitBranch` are absent and travel in
   *  `cwdE2e` as `{cwd, project, gitBranch}`. Absent on a normal machine. */
  titleE2e: E2eField,
  cwdE2e: E2eField,
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const PermissionMode = z.enum([
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'auto',
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** Identity an agent reports on connect. */
export const MachineInfo = z.object({
  machineId: z.string(),
  name: z.string(),
  os: OsKind,
  agentVersion: z.string(),
  hostname: z.string().optional(),
  /** Agent can enforce requireGateway on internal new-session commands.
   * Absent/false means callers must refuse such jobs, not silently downgrade. */
  gatewaySessions: z.boolean().optional(),
  /** Skill slash-commands this machine can actually run — the directory names
   *  under `~/.claude/skills` that hold a SKILL.md. A session CATEGORY rewrites
   *  the first turn to `/<skill> …` (see categories.ts), so a client needs this
   *  to avoid offering a category the machine would leave unhandled. Absent
   *  from agents older than the skill bundle: treat that as "unknown", not as
   *  "none", or every existing machine loses its chips on upgrade day. */
  skills: z.array(z.string()).optional(),
  /** Permission modes this machine offers a client, agent's choice (see
   *  `availablePermissionModes` in agent/src/claude-session.ts). The only
   *  conditional one is `bypassPermissions` — a session that never asks. Since
   *  24.09.2026 every machine offers it, sandboxes included, and it is also
   *  what a run starts in when the client names no mode; a box takes it back
   *  with `CC_REMOTE_ALLOW_BYPASS=0`. The egress checkpoint it used to protect
   *  asked the person sitting in that sandbox, not us — friction, not a
   *  boundary — while the protected-path refusal that IS load-bearing lives in
   *  a PreToolUse hook and survives the mode.
   *
   *  Absent from agents older than this field: treat that as the safe trio
   *  (`default`/`plan`/`acceptEdits`), NOT as "unknown, offer everything". The
   *  opposite of `skills`, and for the reason `skills` can afford its default
   *  and this cannot: a wrong guess there hides a chip, here it offers to run a
   *  machine without approvals on the word of an agent that never said so. */
  permissionModes: z.array(PermissionMode).optional(),
  /** The same question for CODEX, which is a different runtime on the same box.
   *
   *  `permissionModes` above is Claude-shaped — its gate reasons about
   *  `CC_REMOTE_AUTOAPPROVE` and `CC_REMOTE_DENY_WRITE_PATHS`, both enforced by
   *  a Claude PreToolUse hook that has no counterpart on the Codex path — so one
   *  list cannot answer for both runtimes.
   *
   *  Absent means an agent too old to answer, and the safe reading of that is
   *  the pair the web offered before this existed (`default`/`plan`): not
   *  "everything" (it would offer a sandbox the agent cannot honour) and not
   *  "nothing" (plan has worked for months). */
  codexPermissionModes: z.array(PermissionMode).optional(),
  /** What the OWNER of the machine switched off there — `~/.cc-remote/policy.json`,
   *  enforced by the agent (agent/src/policy.ts), reported so clients can hide
   *  what would only be refused. A report, not a control: the hub never sends
   *  it back, and a client that ignores it just meets the agent's refusal.
   *
   *  - `chatOnly`: no terminal, no file/git mutations, no process kill, no
   *    runtime install/login, no mode without approvals.
   *  - `sync`: `all` (every session leaves the machine — the old behaviour) or
   *    `selected` (only sessions in folders the owner picked).
   *
   *  - `transcriptRetentionDays`: the hub keeps a session's transcript only
   *    while it was written within this many days, then purges every copy it
   *    holds (server-rs/src/hub/retention.rs). Absent = kept indefinitely.
   *    The one field the hub DOES act on — and it can only shorten, never set.
   *
   *  Absent from older agents: read it as `{chatOnly: false, sync: 'all'}`,
   *  which is what those agents do. */
  /** The owner marked this machine private (`policy.json`, docs/E2EE.md): its
   *  session content crosses the hub only as ciphertext. Present only as
   *  `true`; the hub treats such a machine as content-blind. Absent = normal. */
  private: z.literal(true).optional(),
  /** Random per agent process, sent whenever the machine holds a content key:
   *  clients bind what they seal to it, so a recording of their commands cannot
   *  be replayed into a later run of the agent (docs/E2EE.md). A hub that lies
   *  about it only makes commands fail, never be accepted. */
  e2eEpoch: z.string().max(64).optional(),
  policy: z
    .object({
      chatOnly: z.boolean(),
      sync: z.enum(['all', 'selected']),
      transcriptRetentionDays: z.number().int().min(1).optional(),
    })
    .optional(),
});
export type MachineInfo = z.infer<typeof MachineInfo>;

export const RunState = z.enum(['started', 'idle', 'ended', 'error', 'yielded']);
export type RunState = z.infer<typeof RunState>;

/**
 * Reasoning effort levels settable live on a running session via the Agent SDK's
 * `applyFlagSettings({ effortLevel })`. The SDK's `'max'` is intentionally
 * omitted: it isn't live-settable (persisted `effortLevel` caps at `xhigh`), and
 * `ultracode` (xhigh + workflow orchestration) is the effective ceiling for a
 * coding session anyway.
 */
export const EffortLevel = z.enum(['low', 'medium', 'high', 'xhigh']);
export type EffortLevel = z.infer<typeof EffortLevel>;

/**
 * What a session can be RUNNING at, which is a wider set than what can be set.
 *
 * `max` exists in the runtime and cannot be pinned from here — so it has to be
 * reportable without being settable, or a session actually running at it shows
 * nothing at all and the control reads as «unknown». Dropping it (as the agent
 * did until 19.09.2026) is the same silence with extra steps.
 *
 * `none` and `ultra` are Codex's ends of the same ladder (`none` = reasoning
 * switched off, which a config without `model_reasoning_effort` used to select
 * silently; `ultra` is above `xhigh` on gpt-5.6-sol). Same argument: a level the
 * agent drops is a control that says nothing about a session that is running.
 */
export const ActiveEffortLevel = z.enum([...EffortLevel.options, 'max', 'none', 'ultra']);
export type ActiveEffortLevel = z.infer<typeof ActiveEffortLevel>;

// ---------------------------------------------------------------------------
// Provider subscription usage/limits. Claude is read from Anthropic's OAuth
// endpoint; Codex is read from the local Codex app-server. Percentages are
// 0-100 *used* (remaining = 100 - utilization). Usage is per-account, so it
// rides on the machine that runs that account's sessions.
// ---------------------------------------------------------------------------

export const UsageWindow = z.object({
  utilization: z.number(), // percent of the window consumed (0-100+)
  resetsAt: z.number().optional(), // epoch ms when the window resets
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/**
 * One limit row exactly as Claude's own `/usage` renders it: a USED-percent bar
 * with a reset. Built from the usage endpoint's `limits[]` — session (5h),
 * weekly_all (7d), and weekly_scoped per model (e.g. "Weekly Fable"). `percent`
 * is 0-100+ *used* (the bar fills as you consume, not the remainder).
 */
export const UsageLimit = z.object({
  key: z.string(), // stable id: "session" | "weekly_all" | "weekly:Fable"
  label: z.string(), // display: "Session (5hr)" | "Weekly (7 day)" | "Weekly Fable"
  group: z.string().optional(), // "session" | "weekly"
  percent: z.number(), // USED percent
  resetsAt: z.number().optional(), // epoch ms when this window resets
  active: z.boolean().optional(), // the currently-binding limit
});
export type UsageLimit = z.infer<typeof UsageLimit>;

export const UsageInfo = z.object({
  limits: z.array(UsageLimit).optional(), // preferred: Claude's own limit rows
  fiveHour: UsageWindow.optional(), // legacy fallback (older agents)
  sevenDay: UsageWindow.optional(), // legacy fallback (older agents)
  account: z.string().optional(), // account email, if known
  subscription: z.string().optional(), // "max" | "pro" | ...
  updatedAt: z.number(), // epoch ms this was fetched
});
export type UsageInfo = z.infer<typeof UsageInfo>;

// ---------------------------------------------------------------------------
// Runtime status: what a coding runtime on this machine IS, as opposed to how
// much of it is spent (`UsageInfo`). The agent finds the binary, reads the
// login on disk and says whose account it is and whether the machine's Codex
// is routed through a gateway — so «Железо» can show «Codex · Plus · ilya@…»
// or «Codex не найден», and the limits meter can explain an absent section
// instead of leaving it out. Every failure that used to resolve to a silent
// `null` in the usage poll is a word here.
//
// `auth` and `error` are STRINGS, not enums, on purpose: a newer agent learning
// a new word must never make an older web drop the whole frame. The UI maps
// an unknown word to «неизвестно».
// ---------------------------------------------------------------------------

/** Where the machine's Codex sends its requests: its own login (`own`) or a
 *  gateway named by `model_provider` in `~/.codex/config.toml` (`gateway`). */
export const RuntimeProvider = z.enum(['own', 'gateway']);
export type RuntimeProvider = z.infer<typeof RuntimeProvider>;

export const CodexRuntimeStatus = z.object({
  /** A `codex` binary the agent can run was found. */
  present: z.boolean(),
  /** The binary that answered, when found. */
  path: z.string().optional(),
  version: z.string().optional(),
  /** 'chatgpt' | 'apikey' | 'none' | 'unknown'. */
  auth: z.string(),
  /** Account email, when the login says. */
  account: z.string().optional(),
  /** 'plus' | 'pro' | 'team' | …, when the login says. */
  plan: z.string().optional(),
  provider: RuntimeProvider,
  /** The provider's name from config.toml when `provider` is `gateway`. */
  providerName: z.string().optional(),
  /** 'not_found' | 'not_logged_in' | 'timeout' | 'app_server_error'. Absent = fine. */
  error: z.string().optional(),
  /** One line for a human: the dirs searched, the stderr tail. Capped so the
   *  register frame stays small. */
  detail: z.string().max(300).optional(),
  /** Epoch ms of this reading. */
  checkedAt: z.number(),
});
export type CodexRuntimeStatus = z.infer<typeof CodexRuntimeStatus>;

export const ClaudeRuntimeStatus = z.object({
  /** False when the SDK's platform `claude` — the binary sessions exec — is
   *  not on disk (`error: 'sdk_binary_missing'`): no Claude session can start
   *  on this machine. Clients must treat it as broken, not as «no data». */
  present: z.boolean(),
  version: z.string().optional(),
  /** 'oauth' | 'token' (long-lived `CLAUDE_CODE_OAUTH_TOKEN`) | 'apikey' | 'none' | 'unknown'. */
  auth: z.string(),
  account: z.string().optional(),
  plan: z.string().optional(),
  /** 'sdk_binary_missing' (the SDK's platform `claude` is not on disk — no
   *  session can start) | 'logged_out' (the CLI blanked the tokens after a refused refresh) |
   *  'token_expired' | 'token_rejected' (the API answered 401/403) |
   *  'token_expiring' (a long-lived token has < 30 days) | 'disabled' (this
   *  agent runs with `CC_REMOTE_DISABLE_CLAUDE=1`: Claude is off by the owner's
   *  choice — clients hide it rather than offer a login). Absent = fine. */
  error: z.string().optional(),
  /** Epoch ms a long-lived token runs out, when the machine knows it. */
  expiresAt: z.number().optional(),
  detail: z.string().max(300).optional(),
  checkedAt: z.number(),
});
export type ClaudeRuntimeStatus = z.infer<typeof ClaudeRuntimeStatus>;

export const RuntimeStatus = z.object({
  codex: CodexRuntimeStatus.optional(),
  claude: ClaudeRuntimeStatus.optional(),
});
export type RuntimeStatus = z.infer<typeof RuntimeStatus>;

// ---------------------------------------------------------------------------
// Builder profile — a per-machine "how you build with AI" analytics report,
// computed ENTIRELY LOCALLY by the agent from ~/.claude transcripts. No excerpt
// or payload ever leaves the machine; only these reduced numbers cross the wire.
// Every field is a number/string/array — never null (see CLAUDE.md #3: the hub's
// clean() strips null object fields, so the agent must omit, not null).
// ---------------------------------------------------------------------------

/** A {name, count} row — used for language and skill leaderboards. */
export const NamedCount = z.object({ name: z.string(), count: z.number() });
export type NamedCount = z.infer<typeof NamedCount>;

export const BuilderProfile = z.object({
  machine: z.string(), // machine name (denormalized so the CLI/standalone report reads on its own)
  machineId: z.string().optional(), // hub infers from the socket; handy standalone
  generatedAt: z.number(), // epoch ms the scan ran
  transcriptsScanned: z.number(),
  sessions: z.number(),
  messages: z.object({ user: z.number(), assistant: z.number() }),

  span: z.object({
    firstTs: z.number(),
    lastTs: z.number(),
    activeDays: z.number(),
    longestStreakDays: z.number(),
  }),

  cadence: z.object({
    hourHistogram: z.array(z.number()), // length 24, local hour
    weekdayHistogram: z.array(z.number()), // length 7, Sun..Sat
    nightOwlShare: z.number(), // 0..1 share of activity 22:00-05:00
    avgSessionMessages: z.number(),
    avgSessionMinutes: z.number(),
  }),

  tools: z.object({
    counts: z.record(z.string(), z.number()), // tool name -> uses
    buildVsExplore: z.number(), // editWrite / (editWrite + readGrep), 0..1
    testRunShare: z.number(), // 0..1 of Bash calls that run tests
    gitOpShare: z.number(), // 0..1 of Bash calls that are git
    toolCallsPerSession: z.number(),
  }),

  steering: z.object({
    avgPromptChars: z.number(),
    shortPromptShare: z.number(), // 0..1 user msgs < 80 chars
    longPromptShare: z.number(), // 0..1 user msgs > 600 chars
    followUpsPerSession: z.number(),
  }),

  engineering: z.object({
    filesTouched: z.number(),
    topLanguages: z.array(NamedCount),
    repos: z.number(),
    branches: z.number(),
  }),

  planning: z.object({
    planModeShare: z.number(), // 0..1 sessions using plan mode
    todoShare: z.number(), // 0..1 sessions using TodoWrite
    topSkills: z.array(NamedCount),
  }),

  models: z.object({
    histogram: z.record(z.string(), z.number()), // model id -> assistant turns
    avgModelsPerSession: z.number(),
  }),

  // Each 0..10, a documented function of the raw metrics above (see agent/src/profile.ts).
  // `product` is a deliberately-weak proxy (UI-facing / doc / css work); labeled as such in the UI.
  scores: z.object({
    steering: z.number(),
    execution: z.number(),
    engineering: z.number(),
    planning: z.number(),
    product: z.number(),
  }),

  archetype: z.object({
    primary: z.string(), // e.g. "Night Owl", "Quality Guardian", "Architect"
    badges: z.array(z.string()), // secondary archetypes that also triggered
  }),
});
export type BuilderProfile = z.infer<typeof BuilderProfile>;

// ---------------------------------------------------------------------------
// Agent -> Central
// ---------------------------------------------------------------------------

const Register = z.object({
  type: z.literal('register'),
  protocol: z.literal(PROTOCOL_VERSION),
  machine: MachineInfo,
  /** Random per-PROCESS id, reminted on every agent start. `machineId` is
   *  durable config, so it cannot distinguish "same daemon reconnecting" from
   *  "daemon restarted" or "a second daemon sharing the config" — this can. */
  agentInstanceId: z.string().optional(),
  /** Runs whose subprocess is STILL driving a session here, carried across a
   *  socket blip. The hub re-adopts these instead of releasing them; any run it
   *  holds for this machine that is absent from the list is released. Omitted
   *  (not `[]`) when the agent starts clean — see the zod optional rule.
   *
   *  `cwd` is what lets the hub rebuild a run it has NO record of — the case
   *  after a hub restart, when its whole run map starts empty. Without it the
   *  hub cannot evaluate project-share visibility for the rebuilt run, so it
   *  used to kill every carried run instead, which is how a deploy silently
   *  ended everyone's live work. Optional so an older agent still registers. */
  liveRuns: z
    .array(z.object({ runId: z.string(), sessionId: z.string(), cwd: z.string().optional() }))
    .max(200)
    .optional(),
  /** What this machine's Claude and Codex ARE (found, logged in as whom, own
   *  login or a gateway). Absent = an agent too old to say — read as UNKNOWN,
   *  never as broken. Refreshed by `runtime_status` when it changes. */
  runtimes: RuntimeStatus.optional(),
  /**
   * How long this agent will hold a tool call waiting on a human before it
   * auto-denies (`CC_REMOTE_APPROVAL_TIMEOUT_MS`, default five minutes).
   *
   * The hub needs it because it decides whether to replay a pending approval to
   * a client that attaches late, and only the agent knows when it gave up. A
   * single hub-wide constant cannot serve a fleet where one machine deliberately
   * waits hours for an asynchronous approval and the rest wait five minutes:
   * whichever way the constant is set, it is wrong for the other half — either
   * dropping prompts an agent is still waiting on, or showing cards whose
   * "Allow" lands nowhere. Absent = assume the default.
   */
  approvalTimeoutMs: z.number().int().positive().optional(),
});

/** Compact a live run's context on demand — the SDK's own `/compact`, the same
 *  thing Claude Code's command does. Manual compaction is the escape hatch when
 *  a session is heading for the size where it stops being resumable at all. */
const Compact = z.object({
  type: z.literal('compact'),
  runId: z.string(),
});

/** Answer to `register`, naming the runs the hub actually re-adopted. The agent
 *  keeps its subprocesses on a short self-fencing lease after a reconnect and
 *  only stands down once this arrives: anything it declared but the hub did NOT
 *  adopt holds no single-writer lock, so it must be closed rather than left
 *  appending to a transcript nothing is tracking. */
const RegisterAck = z.object({
  type: z.literal('register_ack'),
  adoptedRunIds: z.array(z.string()).max(200),
  /** Owner-scoped operational pause of Claude's background API checks.
   *  Older hubs omit it: polling stays enabled. Does not gate sessions. */
  claudeUsageEnabled: z.boolean().optional(),
});

/** A DIFFERENT agent process has claimed this machineId while this socket was
 *  still live — two daemons on one machine (an orphan left by a restart, a
 *  copied config). The loser must EXIT, not reconnect: reconnecting supersedes
 *  the winner in turn, and the two then alternate ownership forever while both
 *  watch and append the same transcripts, which is exactly what the
 *  single-writer rule forbids. The hub only sends this when `agentInstanceId`
 *  proves a different process — a plain reconnect of the same daemon gets
 *  nothing. */
const AgentSuperseded = z.object({
  type: z.literal('agent_superseded'),
  machineId: z.string(),
});

const Inventory = z.object({
  type: z.literal('inventory'),
  sessions: z.array(SessionSummary),
  /** True only when the inventory is uncapped and therefore authoritative for
   * tombstoning sessions absent from this scan. */
  complete: z.boolean().optional(),
});

export const SessionReplicaState = z.object({
  sessionId: z.string(),
  source: z.enum(['claude', 'codex']),
  revision: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  tailHash: z.string().optional(),
  /** Transcript mtime represented by this committed revision. */
  syncedMtime: z.number(),
});
export type SessionReplicaState = z.infer<typeof SessionReplicaState>;

/** Where a memory file applies. `fleet` replicates to every machine its owner
 * has; `machine` and `project` stay pinned to `scopeKey` — a note about this
 * host's launchd is wrong everywhere else, so replicating it would be worse
 * than not replicating at all. */
export const MemoryScope = z.enum(['fleet', 'machine', 'project']);
export type MemoryScope = z.infer<typeof MemoryScope>;

/** A memory file's identity and fingerprint, without its body. The catalog is
 * built from these so an exchange costs the same whether the corpus is ten
 * files or ten thousand; the agent diffs on `sha256` and asks only for what it
 * is actually missing. */
export const MemoryEntry = z.object({
  scope: MemoryScope,
  /** `machineId` for `machine`, project root for `project`, `''` for `fleet`. */
  scopeKey: z.string(),
  /** Path relative to the memory directory, e.g. `ccremote-hub-host.md`. */
  path: z.string().min(1).max(512),
  sha256: z.string(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number(),
  /** Size of the body in bytes. Carried in the catalog so a client can show
   *  what a corpus costs without fetching every body — `MEMORY.md` is loaded
   *  into context on EVERY session, so its growth is the thing worth watching.
   *  Defaulted for agents that predate the field. */
  bytes: z.number().int().nonnegative().default(0),
  /** A tombstone: the note was deleted and must not be pushed back up. The
   *  catalog carries these BECAUSE the agent offers every local file upward —
   *  without the marker a machine that still holds the file resurrects it on
   *  the next reconcile, and deletion could never stick. Defaulted rather than
   *  optional so consumers always read a boolean. */
  deleted: z.boolean().default(false),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

/** Bodies are capped rather than truncated: an oversized file fails the parse
 * loudly instead of replicating a silently shortened memory. */
const MEMORY_MAX_BYTES = 262_144;

/** Start an atomic transcript update. `append` writes after the currently
 * committed count; `replace` builds a hidden generation and swaps it on commit. */
const SessionSyncBegin = z.object({
  type: z.literal('session_sync_begin'),
  syncId: z.string(),
  sessionId: z.string(),
  source: z.enum(['claude', 'codex']),
  summary: SessionSummary,
  mode: z.enum(['append', 'replace']),
  baseRevision: z.number().int().nonnegative(),
});

const SessionSyncChunk = z.object({
  type: z.literal('session_sync_chunk'),
  syncId: z.string(),
  start: z.number().int().nonnegative(),
  messages: z.array(HistoryMessageSchema).max(200),
});

/** The machine's owner narrowed what leaves it (`sync.projects` in
 *  `~/.cc-remote/policy.json`, agent/src/policy.ts): the hub must drop its copy
 *  of these sessions — summary AND replicated history — not keep them as
 *  «archived». If the folder is picked again later, they sync afresh. */
const SyncForget = z.object({
  type: z.literal('sync_forget'),
  sessions: z
    .array(z.object({ source: z.enum(['claude', 'codex']), sessionId: z.string() }))
    .max(5000),
});

const SessionSyncCommit = z.object({
  type: z.literal('session_sync_commit'),
  syncId: z.string(),
  messageCount: z.number().int().nonnegative(),
  tailHash: z.string().optional(),
  syncedMtime: z.number(),
});

/** Upload a local memory file. Sync is deliberately ASYMMETRIC: the Claude Code
 * harness writes these same files on the machine, so the hub is never allowed
 * to overwrite one — the local copy always wins and travels up. Content only
 * ever flows down for a path the machine does not have (see `memory_fetch`).
 * Anything else would put two writers on one file, which is the failure this
 * project already refuses to allow for transcripts. */
const MemoryPush = z.object({
  type: z.literal('memory_push'),
  scope: MemoryScope,
  scopeKey: z.string(),
  path: z.string().min(1).max(512),
  content: z.string().max(MEMORY_MAX_BYTES),
});

/** Ask for the bodies of catalog entries missing from this machine's disk. */
const MemoryFetch = z.object({
  type: z.literal('memory_fetch'),
  want: z
    .array(
      z.object({
        scope: MemoryScope,
        scopeKey: z.string(),
        path: z.string().min(1).max(512),
      }),
    )
    .max(100),
});

/** Periodic Claude subscription usage report for this machine's account. */
const Usage = z.object({
  type: z.literal('usage'),
  usage: UsageInfo,
});

/** Periodic OpenAI Codex subscription usage report for this machine. */
const CodexUsage = z.object({
  type: z.literal('codex_usage'),
  usage: UsageInfo,
});

/** Periodic locally-computed builder profile for this machine (no egress). */
const Profile = z.object({
  type: z.literal('builder_profile'),
  profile: BuilderProfile,
});

/** Periodic hardware/process telemetry sample for this machine. */
const MachineStatsMsg = z.object({
  type: z.literal('machine_stats'),
  stats: MachineStatsSchema,
});

/** The machine's runtimes changed (a login appeared, codex got installed, a
 *  probe started failing). Sent only on change; the register carries the first
 *  reading. */
const RuntimeStatusMsg = z.object({
  type: z.literal('runtime_status'),
  runtimes: RuntimeStatus,
});

/**
 * Every run this agent is actually driving, re-stated on a timer.
 *
 * `register.liveRuns` already says exactly this, and the hub already acts on
 * it — a run it holds for the machine that is absent from the list is released
 * (`settle_agent_runs`). The flaw was that the sentence was only ever spoken at
 * reconnect: while the socket stayed up, the hub's picture of what the agent
 * holds could only ever be CORRECTED BY the agent volunteering a `run_status`.
 * Every path where the agent stops driving a run without saying so — and
 * `resume()` had several, including `cancelPendingStarts()` dropping a start
 * that had not launched — left the hub holding a run forever, `working`, with
 * no writer behind it and its single-writer lock still taken. On 21.09.2026
 * that stranded a session for four hours until a deploy restarted the hub.
 *
 * So the same reconciliation now runs on a heartbeat instead of only at the
 * door. The list is the WHOLE truth for this machine, which is why it is
 * `[]` and not optional when the agent drives nothing: absence of the field
 * must mean "an old agent that cannot answer", and an empty list must mean
 * "nothing, and I am sure" — the hub treats those two very differently.
 */
const RunInventory = z.object({
  type: z.literal('run_inventory'),
  runIds: z.array(z.string()).max(200),
});

/** Streamed session output (assistant text/partials/tool-use/result, etc). */
const Stream = z.object({
  type: z.literal('stream'),
  sessionId: z.string(),
  runId: z.string(),
  /** Normalized event we render in the UI. */
  event: z.object({
    kind: z.enum(['system', 'assistant', 'partial', 'tool_use', 'result', 'error', 'status']),
    text: z.string().optional(),
    /**
     * Machine-readable meaning of the event, when the agent could tell.
     *
     * On an `error`: `budget_exhausted` (the LLM gateway refused for quota),
     * `turn_failed` (the runtime reported the turn failed — the run is still
     * alive and takes the next message), `auth_failed` (the API refused the
     * machine's Claude login — 401/403; `data.detail` keeps the CLI's own text,
     * `data.api_error_status` the status), `billing_error`.
     * On a `status`: `api_retry` (the CLI is retrying a failed API call —
     * `data` carries attempt/max/delay/status), `rate_limit`, `requesting`,
     * `compact_started` / `compact_done` / `compact_failed`, `stderr` (a line
     * the CLI wrote to its stderr — a log, not a state change), `notification`,
     * `permission_denied`, `session_state`, `background_tasks` (the live
     * background tasks after a change — `data.tasks` is the WHOLE set, each
     * `{id, type, description, since, owner?, ownerId?}`, at most 32 — `owner`
     * names the sub-agent that started the task, `ownerId` is its task id;
     * `[]` means none. The hub
     * replays the last non-empty list on subscribe; clients show it as «в фоне»
     * while the CLI's turn is idle — the agent withholds `result` meanwhile).
     * `turn_usage`: data.totalTokens is current-turn input + output, including
     * cache and reasoning exactly once; cumulative snapshot, not a delta. No text.
     * `image_gen`: an image generation — Codex's built-in `image_gen` tool, or a
     * Claude `Bash` call of `hegai-image`. `data` is `ImageGenEventData`
     * (shared/src/rpc.ts): one id per picture, `started` first, then `done` with
     * a `ref` for `session.image`, or `failed`. No percentage exists anywhere
     * upstream — a client's progress bar is its own clock from `startedAt`.
     * On a `result`: `data` carries `total_cost_usd`, `usage`, `num_turns`,
     * `duration_ms` as the SDK reported them.
     *
     * Clients key behaviour on the code; the text is for people and may be
     * reworded freely. Absent = a plain event of its kind.
     */
    code: z.string().optional(),
    /** Structured payload for the code above (numbers a client can show or
     *  compute with). Opaque to the hub, relayed as-is. */
    data: z.record(z.string(), z.unknown()).optional(),
    /** Raw SDK message for clients that want full fidelity. */
    raw: z.unknown().optional(),
    /** Private machine: `text`, `raw` and `data` sealed in one envelope. */
    e2e: E2eField,
  }),
});

/** Agent asks the operator to approve/deny a tool call (from canUseTool). */
const ToolRequest = z.object({
  type: z.literal('tool_request'),
  sessionId: z.string(),
  runId: z.string(),
  requestId: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  /** Private machine: `input` (then `{}`) and `title` sealed. */
  e2e: E2eField,
  /** A prompt that was ALREADY asked, re-issued after the agent re-registered
   *  (`announceState`). The hub still shows it — it may be the only copy a
   *  restarted hub has — but does not push it to phones or Telegram again: a
   *  hub restart forgets which prompts it announced, and without this every
   *  deploy re-announced every question already waiting. */
  replay: z.boolean().optional(),
});

const RunStatus = z.object({
  type: z.literal('run_status'),
  sessionId: z.string(),
  runId: z.string(),
  state: RunState,
  /** Agent clock: last user input accepted for this task; replayed on reconnect. */
  taskStartedAt: z.number().int().positive().optional(),
  error: z.string().optional(),
  /** Private machine: `error` sealed (docs/E2EE.md). */
  e2e: E2eField,
  /**
   * Why a terminal state happened, for the client that has to DO something
   * about it rather than merely print it. `resume_refused` = the agent never
   * launched this run (transcript over the cap, second writer, cancelled
   * start), so whatever was sent with the `open` was not delivered and must go
   * back into the composer. `stopped` = the runtime did not answer an interrupt
   * and the agent closed it. Absent = nothing to recover.
   */
  code: z.string().optional(),
  /**
   * Only on a terminal state (`ended` / `error` / `yielded`): the agent has
   * told the runtime to go, but its PROCESS may still be exiting — a Codex
   * app-server lives on for up to its SIGTERM→SIGKILL grace and leaves no pid
   * file anyone could read. The hub then keeps the session's writer guard
   * until a `writer_released` for this run arrives, or `RUN_CLOSING_MAX_MS`
   * passes. Absent (never `false`, never null) = the writer is gone, release
   * now: that is every frame an agent without this field sends, and every
   * Claude run. Hub-internal: never forwarded to browsers.
   */
  closing: z.boolean().optional(),
});

/**
 * The process behind a run that reported `run_status` with `closing: true` is
 * confirmed gone: nothing can still be writing the session's transcript, so
 * the hub may hand the session to a new writer at once instead of waiting out
 * `RUN_CLOSING_MAX_MS`. Never sent for a run that did not say `closing` and
 * never forwarded to browsers. An agent that exits before the process does
 * says nothing — the hub's deadline covers it.
 */
const WriterReleased = z.object({
  type: z.literal('writer_released'),
  sessionId: z.string(),
  runId: z.string(),
});

/**
 * The session's live permission mode changed — reported from the SDK's
 * system/status message (or after a manual set_permission_mode). Lets the UI
 * keep its plan/default indicator in sync instead of sticking on the last value
 * it set optimistically (e.g. after the model runs ExitPlanMode).
 */
const RunMode = z.object({
  type: z.literal('run_mode'),
  sessionId: z.string(),
  runId: z.string(),
  mode: PermissionMode,
});

/**
 * The run's live model / reasoning settings. Sent when a run learns them (the
 * SDK's init message names the model it actually resolved to) and after every
 * `set_model` / `set_effort`, so a client that reloads or joins mid-run can show
 * what the session IS running instead of resetting its pickers to "default" —
 * the setters travel one way, and nothing else reports the state back.
 *
 * Absent `model` = no explicit pick, the account default is in force; absent
 * `effort` = the account default. `activeModel` is the resolved wire id the
 * runtime reports, which is what makes "default" nameable.
 */
const RunSettings = z.object({
  type: z.literal('run_settings'),
  sessionId: z.string(),
  runId: z.string(),
  model: z.string().optional(),
  activeModel: z.string().optional(),
  effort: EffortLevel.optional(),
  /**
   * The level actually in force, reported by the runtime — the twin of
   * `activeModel`. `effort` above says what was PINNED here and is absent
   * until somebody pins something; this says what the turn is really running
   * at, after any silent downgrade the model applies. Without it a picker
   * cannot tell "nobody chose" from "we do not know", and has to answer
   * «how much effort?» with «someone else decided».
   *
   * Arrives with a turn's first tool call, not at open: the agent reads it
   * from the hook input, which is the only place the SDK exposes it —
   * not the init message, not `initializationResult()`, and there is no
   * `getSettings()` on the query.
   */
  activeEffort: ActiveEffortLevel.optional(),
  ultracode: z.boolean().optional(),
});

// RPC response (reply to a central rpc_request).
const RpcResponse = z.object({
  type: z.literal('rpc_response'),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  /** Private machine: an `ok:false` answer's `error` text sealed (then a placeholder). */
  e2e: E2eField,
});

// Terminal (agent -> central).
const TermOpened = z.object({ type: z.literal('term_opened'), termId: z.string() });
const TermData = z.object({ type: z.literal('term_data'), termId: z.string(), data: z.string(), e2e: E2eField });
const TermExit = z.object({ type: z.literal('term_exit'), termId: z.string(), code: z.number().optional() });

/** Context budget for a live run, straight from the CLI (`getContextUsage`).
 *  Reported so the UI can show how full the window is and whether the next turn
 *  is likely to trip auto-compaction, instead of the user finding out when a
 *  session stops resuming. */
const ContextUsage = z.object({
  type: z.literal('context_usage'),
  runId: z.string(),
  sessionId: z.string(),
  totalTokens: z.number(),
  maxTokens: z.number(),
  /** 0-100, as the CLI computes it — not derived here, so the two agree. */
  percentage: z.number(),
  /** Fraction of the window at which auto-compaction fires, when enabled. */
  autoCompactThreshold: z.number().optional(),
  autoCompactEnabled: z.boolean(),
});

// Read-only mirror of a LIVE session's transcript (agent -> central). `replace`
// = full reload (initial / after a rewrite); otherwise an append of new records.
// `messages` are canonical render-ready HistoryMessage objects. The mirror is
// an external wire boundary, so validate it as strictly as replica chunks.
const MirrorData = z.object({
  type: z.literal('mirror_data'),
  mirrorId: z.string(),
  replace: z.boolean(),
  messages: z.array(HistoryMessageSchema).max(200),
});

// A brand-new session's real id, minted by the SDK on `system/init`. Sent once
// per new_session run so the hub/UI can replace the empty placeholder id.
const SessionStarted = z.object({
  type: z.literal('session_started'),
  runId: z.string(),
  sessionId: z.string(),
});

// Durable new-session outcome replayed after reconnect. Explicit null means the
// runtime conclusively rejected creation before a session existed, never timeout.
const SessionOrigin = z.object({
  type: z.literal('session_origin'),
  runId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(512).nullable(),
});
const SessionOriginAck = z.object({
  type: z.literal('session_origin_ack'),
  runId: z.string(),
});

// A real git commit just landed inside this session (detected by the on-machine
// commit-signal hook writing a marker the agent watches, or by a successful
// git.commit RPC). The hub turns this into a transient "ready to close" nudge on
// the session's Flow card.
const SessionCommitted = z.object({
  type: z.literal('session_committed'),
  sessionId: z.string(),
  cwd: z.string().optional(),
});

// The project in `cwd` reached its own remote: at the end of a turn the branch
// has an upstream and is not ahead of it. Only the remote's host travels, never
// the URL (it may embed a token). The hub records it as an audit event — the
// "took their code home" signal the community metrics count.
const ProjectPushed = z.object({
  type: z.literal('project_pushed'),
  sessionId: z.string().optional(),
  cwd: z.string(),
  remoteHost: z.string(),
});

export const AgentToCentral = z.discriminatedUnion('type', [
  ProjectPushed,
  ContextUsage,
  Register,
  Inventory,
  SessionSyncBegin,
  SessionSyncChunk,
  SessionSyncCommit,
  SyncForget,
  MemoryPush,
  MemoryFetch,
  Usage,
  CodexUsage,
  Profile,
  MachineStatsMsg,
  RuntimeStatusMsg,
  RunInventory,
  Stream,
  ToolRequest,
  RunStatus,
  WriterReleased,
  RunMode,
  RunSettings,
  RpcResponse,
  TermOpened,
  TermData,
  TermExit,
  MirrorData,
  SessionStarted,
  SessionOrigin,
  SessionCommitted,
]);
export type AgentToCentral = z.infer<typeof AgentToCentral>;

// ---------------------------------------------------------------------------
// Central -> Agent
// ---------------------------------------------------------------------------

/** An image attached to a user turn. `data` is base64 (no data: prefix). The
 *  media types match what the Claude SDK / Anthropic API accept. */
export const ImageInput = z.object({
  media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  data: z.string().min(1).max(IMAGE_B64_MAX),
});
export type ImageInput = z.infer<typeof ImageInput>;

/**
 * A non-image attachment — a pdf, a log, a spreadsheet, a file of code.
 *
 * Deliberately NOT modelled on `ImageInput`, because the two reach the model by
 * different roads. An image has to be inlined as a vision block; a file is most
 * useful to a coding agent as a PATH IT CAN READ, so the agent writes the bytes
 * into a scratch directory on its own machine and names the path in the turn.
 * The CLI then opens it with the same tools it uses for any other file — no new
 * capability, no size limit beyond what the disk already has.
 *
 * `name` is the original filename, kept because it carries meaning the bytes do
 * not ("Q3-budget.xlsx"). It is NEVER used as a path: the agent sanitises it to
 * a bare basename before writing (see `agent/src/attachments.ts`), or a name
 * like `../../.ssh/authorized_keys` would be an arbitrary write.
 */
export const FileInput = z.object({
  /** Original filename, for display and for the scratch copy. Not a path. */
  name: z.string().min(1).max(255),
  /** Best-effort content type from the browser; advisory only. */
  media_type: z.string().max(255).optional(),
  /** base64 of the file's bytes. */
  data: z.string().min(1).max(FILE_B64_MAX),
});
export type FileInput = z.infer<typeof FileInput>;

/** Who in the hub started/resumed this run; set only for runs a signed-in person
 *  starts from a client; absent for fleet/automation. Fixed for the life of the
 *  coder process — someone else typing into a live run does NOT change it.
 *  An identity hint for cooperative scripts (HEGAI_RUN_USER_*), not a boundary. */
export const RunBy = z.object({
  userId: z.string().min(1).max(200),
  email: z.string().max(320).optional(),
});
export type RunBy = z.infer<typeof RunBy>;

const Resume = z.object({
  type: z.literal('resume'),
  sessionId: z.string(),
  cwd: z.string(),
  runId: z.string(),
  /** Which CLI produced this session. 'codex' routes the agent to the persistent
   *  Codex app-server runtime; absent/'claude' uses the Claude Agent SDK. */
  source: z.enum(['claude', 'codex']).optional(),
  /** Model / effort picked in the composer before the session was continued —
   *  the same pair and the same application as `NewSession.model` / `.effort`.
   *  Absent = whatever the session or the machine already runs on. */
  model: z.string().optional(),
  effort: EffortLevel.optional(),
  /** See `RunBy`: the hub user who started/resumed this run. */
  runBy: RunBy.optional(),
});

// Start a BRAND-NEW session in `cwd` (no sessionId to resume). The SDK mints the
// real session id, which the agent reports back via `session_started`.
const NewSession = z.object({
  type: z.literal('new_session'),
  runId: z.string(),
  /** Internal automation only: validate the effective Hegai gateway before
   * starting Codex. Does not change ordinary user sessions or machine defaults. */
  requireGateway: z.boolean().optional(),
  /** See `RunBy`: the hub user who started/resumed this run. */
  runBy: RunBy.optional(),
  cwd: z.string(),
  /** Optional first user turn to send immediately. */
  message: z.string().optional(),
  /** Optional images attached to that first turn (screenshot → new session). */
  images: z.array(ImageInput).optional(),
  /** Optional non-image attachments; the agent writes them to a scratch dir and
   *  names the paths in the turn (see FileInput). */
  files: z.array(FileInput).optional(),
  /** Private machine: `message`, `images`, `files` sealed. */
  e2e: E2eField,
  /** Which CLI to launch. 'codex' starts a fresh Codex thread on whatever Codex
   *  that machine has — the owner's own login unless its `~/.codex/config.toml`
   *  names a gateway; absent/'claude' uses the Claude Agent SDK. The hub sets
   *  this to 'codex' for a workspace `member` driving someone else's machine,
   *  so a colleague never spends the device owner's Claude login. */
  source: z.enum(['claude', 'codex']).optional(),
  /** Mode to open the session in, overriding the machine's default. A session
   *  the hub starts on someone's behalf (a filed backend spec) opens in 'plan'
   *  so the work is proposed for approval rather than done unasked — the mode
   *  has to travel with the start, since the prompt text alone cannot guarantee
   *  the model stops for a decision. Absent = the agent's own default. */
  permissionMode: PermissionMode.optional(),
  /** Model and reasoning effort for the session, chosen at start. Same values
   *  `set_model` / `set_effort` take mid-run, applied before the first turn
   *  instead of after it.
   *
   *  The two engines reach them differently and neither can fail the launch
   *  over them: Codex carries both in the per-turn collaboration mode, so a
   *  start-time choice is simply the first turn's; Claude takes `model` as a
   *  launch option and `effort` through `applyFlagSettings` right after the
   *  query opens, because the SDK has no launch-time effort. Absent = whatever
   *  the machine's own configuration says. */
  model: z.string().optional(),
  effort: EffortLevel.optional(),
});

// Force takeover: terminate the session's current (editor) writer, confirm it's
// gone, THEN resume as the sole writer. Same shape as Resume — the agent finds
// the live pid for `sessionId` itself.
const Takeover = z.object({
  type: z.literal('takeover'),
  sessionId: z.string(),
  cwd: z.string(),
  runId: z.string(),
  /** Optional first user turn to send once we hold the session. */
  message: z.string().optional(),
  /** Optional images to attach to that first turn. */
  images: z.array(ImageInput).optional(),
  /** Optional non-image attachments; the agent writes them to a scratch dir and
   *  names the paths in the turn (see FileInput). */
  files: z.array(FileInput).optional(),
  /** Private machine: `message`, `images`, `files` sealed. */
  e2e: E2eField,
  /** See `Resume.source`. Codex has no editor writer, so this is normally 'claude'. */
  source: z.enum(['claude', 'codex']).optional(),
  /** See `Resume.model` / `Resume.effort`. */
  model: z.string().optional(),
  effort: EffortLevel.optional(),
  /** See `RunBy`: the hub user who started/resumed this run. */
  runBy: RunBy.optional(),
});

const Input = z.object({
  type: z.literal('input'),
  runId: z.string(),
  text: z.string(),
  /** Optional images attached to this turn. */
  images: z.array(ImageInput).optional(),
  /** Optional non-image attachments; the agent writes them to a scratch dir and
   *  names the paths in the turn (see FileInput). */
  files: z.array(FileInput).optional(),
  /** The signed-in hub user who typed this turn (UI path only; absent for the
   *  Telegram bot / fleet). The agent records it in the run's state file so
   *  scripts can tell whose turn it is — see `RunBy`. */
  by: RunBy.optional(),
  /** Private machine: `text` (then ''), `images`, `files` sealed. A private
   *  machine refuses a plaintext turn. */
  e2e: E2eField,
});

const Interrupt = z.object({
  type: z.literal('interrupt'),
  runId: z.string(),
});

const ToolDecision = z.object({
  type: z.literal('tool_decision'),
  requestId: z.string(),
  allow: z.boolean(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  /** Optional mode to apply atomically with an approved plan. Claude's native
   *  ExitPlanMode dialog offers review-edits vs auto-accept-edits choices. */
  permissionMode: PermissionMode.optional(),
  message: z.string().optional(),
  /** Private machine: `updatedInput` and `message` sealed. */
  e2e: E2eField,
  /** The signed-in hub user who answered (UI path only). An answer can launch
   *  a turn (accepting a plan), so it counts for authorship like an `input`. */
  by: RunBy.optional(),
});

const Close = z.object({
  type: z.literal('close'),
  runId: z.string(),
});

// End an EXTERNAL session (one held by an editor via livePid, not a cc-remote
// run). The agent resolves the live pid for this sessionId and SIGTERMs it — the
// analog of the stage box's close-session.sh, scoped to one session. Used by the
// Flow board's "confirm Done" for editor-held cards.
const EndExternalSession = z.object({
  type: z.literal('end_external_session'),
  sessionId: z.string(),
});

const Rescan = z.object({
  type: z.literal('rescan'),
});

/** Durable replica cursor sent after register so an agent can append only the
 * missing normalized messages instead of uploading every transcript again. */
const SessionSyncCatalog = z.object({
  type: z.literal('session_sync_catalog'),
  sessions: z.array(SessionReplicaState),
});

/** What the hub holds for this machine's owner, sent after register alongside
 * the transcript catalog. Metadata only — bodies come from `memory_deliver`. */
const MemoryCatalog = z.object({
  type: z.literal('memory_catalog'),
  memories: z.array(MemoryEntry),
});

/** Bodies for the paths an agent asked for in `memory_fetch`. */
const MemoryDeliver = z.object({
  type: z.literal('memory_deliver'),
  memories: z
    .array(MemoryEntry.extend({ content: z.string().max(MEMORY_MAX_BYTES) }))
    .max(100),
});

const SessionSyncAck = z.object({
  type: z.literal('session_sync_ack'),
  syncId: z.string(),
  sessionId: z.string(),
  source: z.enum(['claude', 'codex']),
  ok: z.boolean(),
  revision: z.number().int().nonnegative().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  tailHash: z.string().optional(),
  syncedMtime: z.number().optional(),
  error: z.string().optional(),
});

// RPC request (central -> agent). machineId already resolved by central.
const RpcRequest = z.object({
  type: z.literal('rpc_request'),
  requestId: z.string(),
  method: RpcMethodSchema,
  params: z.record(z.string(), z.unknown()),
});

// Terminal (central -> agent). termId allocated by central.
const TermOpen = z.object({ type: z.literal('term_open'), termId: z.string(), cwd: z.string().optional() });
const TermInput = z.object({ type: z.literal('term_input'), termId: z.string(), data: z.string(), e2e: E2eField });
const TermResize = z.object({ type: z.literal('term_resize'), termId: z.string(), cols: z.number(), rows: z.number() });
const TermCloseA = z.object({ type: z.literal('term_close'), termId: z.string() });

// Mirror (central -> agent). mirrorId allocated by central. Tails the live
// session transcript read-only — does NOT spawn a writer.
const MirrorOpen = z.object({ type: z.literal('mirror_open'), mirrorId: z.string(), sessionId: z.string(), cwd: z.string() });
const MirrorCloseA = z.object({ type: z.literal('mirror_close'), mirrorId: z.string() });

// Run controls.
const SetModel = z.object({ type: z.literal('set_model'), runId: z.string(), model: z.string().optional() });
const SetPermissionMode = z.object({
  type: z.literal('set_permission_mode'),
  runId: z.string(),
  mode: PermissionMode,
  /** Private machine: the mode sealed (the clear one is a hint the agent ignores). */
  e2e: E2eField,
});
/** Set reasoning effort / ultracode live. `effort` omitted = clear to default;
 *  `ultracode` = xhigh effort + workflow orchestration (session-scoped). */
const SetEffort = z.object({
  type: z.literal('set_effort'),
  runId: z.string(),
  effort: EffortLevel.optional(),
  ultracode: z.boolean().optional(),
});

export const CentralToAgent = z.discriminatedUnion('type', [
  SessionOriginAck,
  RegisterAck,
  AgentSuperseded,
  Compact,
  Resume,
  NewSession,
  Takeover,
  Input,
  Interrupt,
  ToolDecision,
  Close,
  EndExternalSession,
  Rescan,
  SessionSyncCatalog,
  SessionSyncAck,
  MemoryCatalog,
  MemoryDeliver,
  RpcRequest,
  TermOpen,
  TermInput,
  TermResize,
  TermCloseA,
  MirrorOpen,
  MirrorCloseA,
  SetModel,
  SetPermissionMode,
  SetEffort,
]);
export type CentralToAgent = z.infer<typeof CentralToAgent>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function encode(msg: AgentToCentral | CentralToAgent): string {
  return JSON.stringify(msg);
}

export function decodeAgentToCentral(raw: string): AgentToCentral {
  return AgentToCentral.parse(JSON.parse(raw));
}

export function decodeCentralToAgent(raw: string): CentralToAgent {
  return CentralToAgent.parse(JSON.parse(raw));
}
