import { z } from 'zod';
import { SessionSummary, MachineInfo, RunState, PermissionMode, EffortLevel, ActiveEffortLevel, UsageInfo, RuntimeStatus, BuilderProfile, ImageInput, FileInput, MemoryEntry, MemoryScope } from './protocol.js';
import { SessionCategory } from './categories.js';
import { E2eField } from './e2e.js';
import { HistoryMessageSchema, MachineStatsSchema, RpcMethodSchema } from './rpc.js';

export const WorkspaceRole = z.enum(['owner', 'manager', 'member']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const WorkspaceSummary = z.object({
  workspaceId: z.string(),
  name: z.string(),
  kind: z.enum(['personal', 'organization']),
  role: WorkspaceRole,
  /** URL-safe handle, set for organizations created by their owner through
   *  the product (self-serve teams). Absent on admin-created and personal ones. */
  slug: z.string().optional(),
  /** True for a team a member created themselves. The UI hides the manager
   *  machinery there (a community team is owner + members). Absent = false. */
  selfServe: z.boolean().optional(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

/** Where the viewer stands in the community rollout. `waitlist` = signed in,
 *  nothing enabled yet; `active` = full product; `suspended` = read-only until
 *  reactivated. Employees are backfilled `active/employee`. */
export const AccessState = z.enum(['waitlist', 'active', 'suspended']);
export type AccessState = z.infer<typeof AccessState>;
export const AccessPlan = z.enum(['employee', 'community']);
export type AccessPlan = z.infer<typeof AccessPlan>;
export const SeatStatus = z.enum(['none', 'pending', 'ready', 'failed', 'inactive']);
export type SeatStatus = z.infer<typeof SeatStatus>;
export const SandboxStatus = z.enum(['none', 'queued', 'running', 'ready', 'failed', 'suspended']);
export type SandboxStatus = z.infer<typeof SandboxStatus>;

/** Where the hub's invitation to the private repository stands for this person
 *  (server-rs/src/github_grant.rs). Absent when the hub grants nothing. */
export const GithubGrantStatus = z.enum(['pending', 'invited', 'granted', 'failed', 'revoking', 'revoked']);
export type GithubGrantStatus = z.infer<typeof GithubGrantStatus>;
export const GithubGrant = z.object({
  status: GithubGrantStatus,
  /** `owner/name` of the repository. */
  repo: z.string(),
  /** Admin view only. */
  attempts: z.number().int().optional(),
  error: z.string().optional(),
});
export type GithubGrant = z.infer<typeof GithubGrant>;

export const ViewerAccess = z.object({
  state: AccessState,
  plan: AccessPlan,
  requestedAt: z.number().optional(),
  activatedAt: z.number().optional(),
  /** The viewer's seat on the LLM gateway (community plan only). */
  seat: z.object({ status: SeatStatus }).optional(),
  /** The viewer's hosted sandbox machine (community plan only). */
  sandbox: z.object({
    status: SandboxStatus,
    machineId: z.string().optional(),
    machineName: z.string().optional(),
  }).optional(),
  /** How many personal devices this viewer may enroll (sandboxes not counted). */
  deviceCap: z.number().int().optional(),
  /** Has the newcomer filled the registration form in (POST /api/access/registration)?
   *  Absent on hubs that predate it — treat as registered. */
  registered: z.boolean().optional(),
  githubGrant: GithubGrant.optional(),
});
export type ViewerAccess = z.infer<typeof ViewerAccess>;

export const ViewerContext = z.object({
  userId: z.string(),
  /** Absent for an account without an address (Telegram-only sign-in).
   *  Show a person through `displayName()` in web/src/lib.ts, never `.email`. */
  email: z.string().optional(),
  fullName: z.string().optional(),
  /** The Telegram account linked as a way in (`@username`, or `tg:<id>`
   *  without one). Absent when none is linked. */
  telegram: z.string().optional(),
  platformAdmin: z.boolean(),
  workspace: WorkspaceSummary,
  workspaces: z.array(WorkspaceSummary),
  /** Absent on hubs that predate the community rollout — treat as `active`. */
  access: ViewerAccess.optional(),
  /** The hub has an LLM gateway to read usage from («Расходы»). Absent = no. */
  llmUsage: z.boolean().optional(),
});
export type ViewerContext = z.infer<typeof ViewerContext>;

/** `GET /api/public-config` (server-rs/src/public_config.rs) — readable before
 *  sign-in: which edition this hub is, what to call it, and which ways in are
 *  switched on. `oidc` is absent when no provider is configured. */
export const PublicConfig = z.object({
  edition: z.enum(['internal', 'external']),
  brandName: z.string(),
  publicUrl: z.string(),
  auth: z.object({
    local: z.boolean(),
    google: z.boolean(),
    /** Absent on hubs that predate GitHub sign-in. */
    github: z.boolean().optional(),
    telegram: z.boolean(),
    apple: z.boolean(),
    oidc: z.object({ name: z.string() }).optional(),
    hegaiSso: z.boolean(),
  }),
  /** The hub's install commands can hand out the Mac/Windows app (ours always;
   *  a self-hosted one only with CC_REMOTE_APP_DL). Absent on older hubs. */
  desktopApps: z.boolean().optional(),
});
export type PublicConfig = z.infer<typeof PublicConfig>;

/** `POST /api/auth/local/setup/begin` (server-rs/src/local_login.rs). The
 *  secret, URI and QR are absent when the account already has an authenticator
 *  (`enrolled`) and setup only sets the password. */
export const LocalSetupBegin = z.object({
  email: z.string(),
  enrolled: z.boolean(),
  secret: z.string().optional(),
  otpauthUri: z.string().optional(),
  /** The QR code as an SVG document, rendered by the hub. */
  qrSvg: z.string().optional(),
});
export type LocalSetupBegin = z.infer<typeof LocalSetupBegin>;

/** `POST /api/auth/local/setup/finish` — shown once; empty when the
 *  authenticator already existed. */
export const LocalSetupFinish = z.object({
  recoveryCodes: z.array(z.string()),
  /** The team an invitation carried by the setup link put the person in. */
  workspaceId: z.string().optional(),
});
export type LocalSetupFinish = z.infer<typeof LocalSetupFinish>;

/** `POST /api/auth/local/native-handoff` -> where the app's auth browser goes next. */
export const NativeHandoff = z.object({ redirect: z.string() });
export type NativeHandoff = z.infer<typeof NativeHandoff>;

/** «Войти через Telegram» (server-rs/src/telegram_login_api.rs).
 *  `POST /api/auth/telegram/start` → the code for the bot (inside `url`), a
 *  poll token the client keeps, and `match` — the number the client MUST
 *  show: the person presses it in Telegram, and a wrong one kills the login. */
export const TelegramLoginStart = z.object({
  code: z.string(),
  url: z.string(),
  bot: z.string(),
  pollToken: z.string(),
  match: z.string(),
  expiresAt: z.number(),
  interval: z.number(),
});
export type TelegramLoginStart = z.infer<typeof TelegramLoginStart>;

export const TelegramLoginAccount = z.object({
  userId: z.string(),
  displayName: z.string(),
  state: z.string().optional(),
});
export type TelegramLoginAccount = z.infer<typeof TelegramLoginAccount>;

/** `POST /api/auth/telegram/poll`. `approved` is handed out once (the hub
 *  sets the session cookie with it); a link answers `confirm_link` and waits
 *  for the account's own «yes» (`POST /api/auth/telegram/link`). */
export const TelegramLoginPoll = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('used') }),
  z.object({ status: z.literal('unknown') }),
  z.object({ status: z.literal('confirm_link'), telegram: z.string() }),
  z.object({
    status: z.literal('approved'),
    userId: z.string(),
    telegram: z.string(),
    account: TelegramLoginAccount,
    created: z.boolean().optional(),
    session: z.string().optional(),
  }),
]);
export type TelegramLoginPoll = z.infer<typeof TelegramLoginPoll>;

/** `POST /api/auth/telegram/link` — the link is made. `movedFrom`: this
 *  Telegram used to open another, empty account, which the hub closed. */
export const TelegramLinkResult = z.object({
  status: z.literal('linked'),
  telegram: z.string(),
  movedFrom: z.string().optional(),
});
export type TelegramLinkResult = z.infer<typeof TelegramLinkResult>;

/** «Способы входа» (server-rs/src/identity.rs): one way into the signed-in
 *  account. `label` / `lastUsedAt` are absent when unknown. */
export const LinkedIdentity = z.object({
  provider: z.string(),
  subject: z.string(),
  label: z.string().optional(),
  linkedAt: z.number(),
  lastUsedAt: z.number().optional(),
});
export type LinkedIdentity = z.infer<typeof LinkedIdentity>;

/** `GET /api/me/identities`, with which providers this hub can link. */
export const IdentitiesResponse = z.object({
  identities: z.array(LinkedIdentity),
  available: z.object({ google: z.boolean(), apple: z.boolean(), telegram: z.boolean() }),
});
export type IdentitiesResponse = z.infer<typeof IdentitiesResponse>;

/** `POST /api/me/identities/unlink`. */
export const UnlinkIdentityResult = z.object({ unlinked: z.number() });
export type UnlinkIdentityResult = z.infer<typeof UnlinkIdentityResult>;

/** One row of the platform-admin access tab (`GET /api/admin/access`). */
export const AccessRow = z.object({
  userId: z.string(),
  /** Absent for an account without an address (Telegram-only sign-in). */
  email: z.string().optional(),
  fullName: z.string().optional(),
  state: AccessState,
  plan: AccessPlan,
  note: z.string().optional(),
  requestedAt: z.number(),
  activatedAt: z.number().optional(),
  suspendedAt: z.number().optional(),
  suspendReason: z.string().optional(),
  seat: z.object({ status: SeatStatus, error: z.string().optional() }),
  sandbox: z.object({
    status: SandboxStatus,
    machineId: z.string().optional(),
    host: z.string().optional(),
    error: z.string().optional(),
  }),
  /** Names of teams that invited this person — an admin activates them first. */
  invitedTo: z.array(z.string()).optional(),
  /** The newcomer's answers on the registration form. */
  registration: z.object({
    role: z.string(),
    purpose: z.string(),
    company: z.string().optional(),
    telegram: z.string().optional(),
    source: z.string().optional(),
    updatedAt: z.number(),
  }).optional(),
  /** What GitHub said about them at their last GitHub sign-in. */
  github: z.object({
    id: z.string(),
    login: z.string(),
    name: z.string().optional(),
    avatarUrl: z.string().optional(),
    /** ISO time the GitHub account was created. */
    createdAt: z.string().optional(),
    publicRepos: z.number().optional(),
    followers: z.number().optional(),
    bio: z.string().optional(),
    blog: z.string().optional(),
    company: z.string().optional(),
  }).optional(),
  githubGrant: GithubGrant.optional(),
});
export type AccessRow = z.infer<typeof AccessRow>;

/**
 * External edition: the agent bundle the hub serves, the one waiting for the
 * owner, and the one before (rollback). `GET /api/admin/agent-release`; the
 * approve and rollback POSTs answer with the same shape. On the internal hub
 * these endpoints are 404.
 */
export const AgentReleaseApproved = z.object({
  sha: z.string(),
  version: z.string(),
  approvedAt: z.number(),
  /** The approving admin's address (or id); `system` for the first-boot approval. */
  approvedBy: z.string(),
});
export type AgentReleaseApproved = z.infer<typeof AgentReleaseApproved>;

export const AgentReleasePending = z.object({
  /** Absent when the offered files are too broken to hash. */
  sha: z.string().optional(),
  version: z.string().optional(),
  /** False = never served and cannot be approved. */
  signatureOk: z.boolean(),
  /** Why an unsigned or inconsistent bundle is not usable. */
  error: z.string().optional(),
});
export type AgentReleasePending = z.infer<typeof AgentReleasePending>;

export const AgentReleaseMachine = z.object({
  name: z.string(),
  agentVersion: z.string(),
  online: z.boolean(),
});
export type AgentReleaseMachine = z.infer<typeof AgentReleaseMachine>;

export const AgentReleaseStatus = z.object({
  approved: AgentReleaseApproved.optional(),
  pending: AgentReleasePending.optional(),
  previous: z.object({ sha: z.string(), version: z.string() }).optional(),
  machines: z.array(AgentReleaseMachine),
  /** How many release keys this hub trusts; 0 = no bundle can be valid. */
  trustedKeys: z.number().int(),
  /** A bundle was approved here before but the approved copy is gone or damaged:
   *  nothing is served until the owner approves one again. Absent otherwise. */
  approvedLost: z.boolean().optional(),
  /** The viewer has a confirmed authenticator. Present on GET only. */
  authenticatorEnrolled: z.boolean().optional(),
});
export type AgentReleaseStatus = z.infer<typeof AgentReleaseStatus>;

/** `POST /api/admin/agent-release/approve`. */
export const AgentReleaseApproveRequest = z.object({ sha: z.string(), code: z.string() });
export type AgentReleaseApproveRequest = z.infer<typeof AgentReleaseApproveRequest>;

/** `POST /api/admin/agent-release/rollback`. */
export const AgentReleaseRollbackRequest = z.object({ code: z.string() });
export type AgentReleaseRollbackRequest = z.infer<typeof AgentReleaseRollbackRequest>;

/** An email a platform admin opened the product for BEFORE that person ever
 *  signed in. It has no `userId` — the account is born at their first SSO
 *  login, and this promise is claimed in that same transaction. */
export const PreauthorizedEmail = z.object({
  email: z.string(),
  note: z.string().optional(),
  createdAt: z.number(),
  createdBy: z.string(),
});
export type PreauthorizedEmail = z.infer<typeof PreauthorizedEmail>;

export const ProvisionJobKind = z.enum(['sandbox_create', 'sandbox_suspend', 'sandbox_resume', 'sandbox_delete', 'sandbox_rotate_key']);
export type ProvisionJobKind = z.infer<typeof ProvisionJobKind>;
export const ProvisionJobStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type ProvisionJobStatus = z.infer<typeof ProvisionJobStatus>;

/** One sandbox provisioning job as the admin page and the provisioner see it. */
export const ProvisionJob = z.object({
  jobId: z.string(),
  userId: z.string(),
  email: z.string().optional(),
  kind: ProvisionJobKind,
  status: ProvisionJobStatus,
  host: z.string().optional(),
  attempts: z.number().int(),
  machineId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  claimedAt: z.number().optional(),
  finishedAt: z.number().optional(),
});
export type ProvisionJob = z.infer<typeof ProvisionJob>;

export const MemberSummary = z.object({
  userId: z.string(),
  /** Absent for an account without an address (Telegram-only sign-in). */
  email: z.string().optional(),
  fullName: z.string().optional(),
  role: WorkspaceRole,
  joinedAt: z.number(),
});
export type MemberSummary = z.infer<typeof MemberSummary>;

export const ProjectShare = z.object({
  projectShareId: z.string(),
  workspaceId: z.string(),
  machineId: z.string(),
  ownerUserId: z.string(),
  root: z.string(),
  name: z.string(),
  createdAt: z.number(),
  /**
   * Access level granted to workspace members. 'view' (default) = read-only
   * (managers see the owner's work); 'control' = members may START and drive
   * their own sessions inside this root (but not full machine control:
   * no terminal, no file RPC). Absent = 'view' (back-compat with older hubs).
   */
  access: z.enum(['view', 'control']).optional(),
  /**
   * Which sessions inside this root a control-share member sees. 'team'
   * (default, the employee model) = only sessions started by other members —
   * the device owner's own work stays private. 'everyone' = every session under
   * the root, the owner's included (a community team on one sandbox). Absent =
   * 'team'.
   */
  visibility: z.enum(['team', 'everyone']).optional(),
  /**
   * The people this share is limited to. Absent = the whole team (as before);
   * present = only these workspace members (plus the workspace owner and the
   * device owner) can see or work in it. `role` is a label (`lead` | `member`
   * | `partner`), the rights are equal. Set by an integration through the
   * hub's service API, read-only in the UI.
   */
  members: z
    .array(
      z.object({
        userId: z.string(),
        role: z.enum(['lead', 'member', 'partner']),
        name: z.string().optional(),
      }),
    )
    .optional(),
});
export type ProjectShare = z.infer<typeof ProjectShare>;

export const DeviceSummary = z.object({
  machineId: z.string(),
  ownerUserId: z.string(),
  name: z.string(),
  os: z.enum(['mac', 'windows', 'linux']),
  online: z.boolean(),
  lastSeen: z.number(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

export const AuditEvent = z.object({
  auditEventId: z.string(),
  workspaceId: z.string(),
  actorUserId: z.string(),
  actorName: z.string().optional(),
  action: z.string(),
  targetKind: z.string(),
  targetId: z.string(),
  createdAt: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/**
 * Support access on request (external edition): the workspace owner opens a
 * time-limited account for HegAI support. Optional fields are absent, never null.
 */
export const SupportGrantStatus = z.enum(['active', 'expired', 'revoked']);
export type SupportGrantStatus = z.infer<typeof SupportGrantStatus>;

export const SupportGrant = z.object({
  grantId: z.string(),
  workspaceId: z.string(),
  supportUserId: z.string(),
  grantedBy: z.string(),
  role: z.enum(['member', 'manager']),
  note: z.string().optional(),
  createdAt: z.number(),
  expiresAt: z.number(),
  revokedAt: z.number().optional(),
  closedAt: z.number().optional(),
  status: SupportGrantStatus,
  /** The one-time sign-in link has been spent. */
  linkUsed: z.boolean(),
  linkExpiresAt: z.number(),
});
export type SupportGrant = z.infer<typeof SupportGrant>;

/** `POST /api/workspaces/{id}/support-grants` — the link is in this answer only. */
export const SupportGrantCreated = z.object({ grant: SupportGrant, link: z.string() });
export type SupportGrantCreated = z.infer<typeof SupportGrantCreated>;

export const SupportGrantList = z.object({ grants: z.array(SupportGrant) });
export type SupportGrantList = z.infer<typeof SupportGrantList>;

/** `.../support-grants/{grant}/log[?before=<createdAt>]` — what the support
 *  account did, newest first, up to 1000 per call; `total` counts them all. */
export const SupportGrantLog = z.object({ events: z.array(AuditEvent), total: z.number() });
export type SupportGrantLog = z.infer<typeof SupportGrantLog>;

/**
 * Wire protocol between the browser and the central service. The central
 * service translates these into the agent protocol (protocol.ts) and fans the
 * agent's events back to subscribed browsers.
 */

// ---------------------------------------------------------------------------
// Snapshot of a connected machine and its sessions (server -> browser)
// ---------------------------------------------------------------------------

export const MachineSnapshot = z.object({
  machine: MachineInfo,
  owner: z.object({ userId: z.string(), email: z.string().optional(), fullName: z.string().optional() }).optional(),
  canControl: z.boolean().optional(),
  /** May the viewer START / drive sessions here (control-share member) even
   *  without full machine control? Absent = false. */
  canStart: z.boolean().optional(),
  /** 'sandbox' = a hosted machine the hub provisioned for its owner. Claude
   *  and Codex both run there once the owner has logged in from «Начало»
   *  (24.09.2026; earlier sandboxes were Codex-only); whether its Codex is the
   *  member's own login or a gateway seat is `runtimes.codex.provider`.
   *  Absent = a personal device. */
  kind: z.enum(['personal', 'sandbox']).optional(),
  /** Does anybody but the owner work on this box? True when the machine carries
   *  at least one project share. Absent = false.
   *
   *  `kind` does NOT answer this and must not be used for it: `kind` records how
   *  the device was ENROLLED, and the shared employee sandbox is enrolled as an
   *  ordinary personal device — on the live hub it reads `personal` while
   *  carrying nine control-shares. */
  shared: z.boolean().optional(),
  online: z.boolean(),
  lastSeen: z.number(),
  sessions: z.array(SessionSummary),
  /** This machine's Claude account usage/limits, if the agent reported them. */
  usage: UsageInfo.optional(),
  /** This machine's OpenAI Codex account limits, if the agent reported them. */
  codexUsage: UsageInfo.optional(),
  /** Locally-computed "how you build with AI" profile, if the agent reported one. */
  profile: BuilderProfile.optional(),
  /** Latest hardware/process telemetry sample, if the agent reported one. */
  stats: MachineStatsSchema.optional(),
  /** What this machine's Claude and Codex ARE — found, logged in as whom, own
   *  login or a gateway. Absent = an agent too old to say: draw «нет данных»,
   *  never a warning. Controllers only, like `usage`. */
  runtimes: RuntimeStatus.optional(),
});
export type MachineSnapshot = z.infer<typeof MachineSnapshot>;

/**
 * Per-run "attention" state, derived by the central service from the agent's
 * stream/tool_request/run_status events. Drives needs-attention badges, the
 * notification center, and the parallel-session board.
 *  - working          : agent is actively producing output
 *  - needs_attention  : a tool approval is pending (you must decide)
 *  - idle             : the turn finished; the run is waiting on you
 *  - error            : the run errored
 */
export const AttentionState = z.enum(['working', 'needs_attention', 'idle', 'error']);
export type AttentionState = z.infer<typeof AttentionState>;

/** A live (open) run as the central service sees it, fanned out to every UI. */
export const ActiveRunInfo = z.object({
  runId: z.string(),
  machineId: z.string(),
  machineName: z.string().optional(),
  sessionId: z.string(),
  title: z.string().optional(),
  project: z.string().optional(),
  state: AttentionState,
  /** Short preview of the last assistant output (for board cards). */
  preview: z.string().optional(),
  /** ms timestamp of the last state change. */
  since: z.number(),
  /** Last user input at the agent, independent of attention-state transitions. */
  taskStartedAt: z.number().int().positive().optional(),
  /** ms timestamp of the last frame the run's agent sent for it (stream,
   *  status, tool request). A run that is `working` with this far in the past
   *  is waiting on something — a model call, a hung tool — and the UI says so
   *  instead of showing a bare «working…». Absent from a hub too old to track
   *  it. */
  lastEventAt: z.number().optional(),
  /** The last frame was a `tool_use`, so the runtime is INSIDE a tool and not
   *  talking to the model. The CLI emits a heartbeat on every API request, so
   *  while it thinks the frames keep coming; inside a tool there are none, and
   *  in this product that is most of the time — a release build or a deploy is
   *  four minutes. Without this the silence badge fired on ordinary work.
   *  Absent from a hub too old to track it. */
  awaitingTool: z.boolean().optional(),
  /** Who opened this run: a native app, the web, the fleet HTTP API, or the
   *  backend-request intake (`POST /api/backend-requests`). Absent for runs
   *  opened before the opener said `hello` (treated as 'web').
   *
   *  A value this build does not know reads as absent instead of failing: this
   *  field sits on every run of every `snapshot` / `activity`, so a strict enum
   *  turned ONE unknown origin into a dropped frame for the whole fleet — no
   *  run list at all, every pane detached, and each send bouncing with
   *  «Прогон уже идёт». It happened with 'fleet', and again on 20.10.2026 with
   *  'backend-request', which the hub had been sending since 25.08. */
  origin: z.enum(['app', 'web', 'fleet', 'backend-request']).optional().catch(undefined),
  /** What `needs_attention` actually means for this run. The hub raises that
   *  state for ANY pending tool request, but the two cases read very
   *  differently to a person: `question` is the agent asking something
   *  (AskUserQuestion, ExitPlanMode) and deserves "ждёт ответа";
   *  `permission` is a tool waiting to be allowed to run and deserves
   *  "ждёт подтверждения". Saying "ждёт ответа" for a permission prompt sent
   *  people hunting for a question nobody asked. Absent when nothing is
   *  pending, or from a hub too old to send it. */
  pendingKind: z.enum(['question', 'permission']).optional(),
  /** Name of the tool waiting on a decision, so a client can say which one. */
  pendingTool: z.string().optional(),
  /** Identity of the prompt the run is stopped on. A prompt the agent
   *  re-issues after a reconnect carries the SAME id, which is how a notifier
   *  tells «asked again because the socket blipped» from «asked something new»
   *  — without it every hub restart re-announced every waiting question. */
  pendingRequestId: z.string().optional(),
  /** Who started this run (hub-injected). Drives the owner badge + the employee
   *  activity-visibility filter. Absent for legacy/unowned runs. */
  ownerUserId: z.string().optional(),
  ownerName: z.string().optional(),
  /** Session category (see categories.ts), if the run was started with one. */
  category: z.string().optional(),
});
export type ActiveRunInfo = z.infer<typeof ActiveRunInfo>;

// ---------------------------------------------------------------------------
// Browser -> Central
// ---------------------------------------------------------------------------

/**
 * Which of a window's session views sent this (24.09.2026). One browser window
 * holds ONE /ui socket however many panes of the split it shows, so a reply
 * the hub sends back — a refusal, the ack of an open, the replay of a
 * subscribed turn — has to say which pane asked, or the refusal puts the text
 * back into the wrong composer. The hub copies it onto every frame it sends
 * this socket while handling the message (`reply_ref` in server-rs). Opaque to
 * the hub; absent = the window's only view, as every client before it.
 */
const ChannelRef = z.string().max(64).optional();

const Open = z.object({
  type: z.literal('open'),
  ref: ChannelRef,
  machineId: z.string(),
  sessionId: z.string(),
  /** Optional first user turn to send on resume. */
  message: z.string().optional(),
  /** Optional images to attach to that first turn. */
  images: z.array(ImageInput).optional(),
  /** Optional non-image attachments for the same turn (see FileInput). */
  files: z.array(FileInput).optional(),
  /** Private machine: the content fields sealed in one envelope (docs/E2EE.md). */
  e2e: E2eField,
  /** Model / effort chosen in the composer before continuing (27.09.2026).
   *  The hub validates them exactly as `new_session`'s and drops a bad value
   *  rather than failing the open. */
  model: z.string().optional(),
  effort: EffortLevel.optional(),
});

// Start a brand-new session in `cwd` on a machine (no sessionId yet). The hub
// allocates the run, the agent mints the real session id → `session_started`.
const NewSession = z.object({
  type: z.literal('new_session'),
  ref: ChannelRef,
  machineId: z.string(),
  cwd: z.string(),
  /** Optional first user turn. */
  message: z.string().optional(),
  /** Optional images attached to that first turn (screenshot → new session). */
  images: z.array(ImageInput).optional(),
  /** Optional non-image attachments for the same turn (see FileInput). */
  files: z.array(FileInput).optional(),
  /** Private machine: the content fields sealed in one envelope (docs/E2EE.md). */
  e2e: E2eField,
  /** Optional session category. The hub prefixes the first turn with the
   *  matching skill (`/<skill> <message>`) and persists the category. */
  category: SessionCategory.optional(),
  /** Which coding agent to start. Owners and managers choose; a workspace
   *  `member` is always put on Codex regardless of what is asked, because
   *  Claude on their machine would spend the device owner's login. Omitted =
   *  Claude. */
  source: z.enum(['claude', 'codex']).optional(),
  /** The three run settings, chosen BEFORE the first turn rather than after it.
   *  They are the same three that `set_model` / `set_effort` /
   *  `set_permission_mode` change mid-session, and they mean the same thing —
   *  what is new is only that the first turn already runs under them. That
   *  matters most for `permissionMode`: asking for `plan` after the model has
   *  started editing is not planning, and a first turn is exactly when the
   *  choice is load-bearing.
   *
   *  All three are advisory. A machine that does not offer a mode
   *  (`MachineInfo.permissionModes`) or a model still starts the session under
   *  its own default rather than refusing — a start that fails over a picker is
   *  worse than a start that ignores it. */
  model: z.string().optional(),
  effort: EffortLevel.optional(),
  permissionMode: PermissionMode.optional(),
});

// Force takeover (browser -> central): for a session live in an editor, ask the
// agent to terminate that writer and resume here as the sole writer.
const Takeover = z.object({
  type: z.literal('takeover'),
  ref: ChannelRef,
  machineId: z.string(),
  sessionId: z.string(),
  message: z.string().optional(),
  images: z.array(ImageInput).optional(),
  /** Optional non-image attachments for the same turn (see FileInput). */
  files: z.array(FileInput).optional(),
  /** Private machine: the content fields sealed in one envelope (docs/E2EE.md). */
  e2e: E2eField,
  /** See `Open.model` / `Open.effort`. */
  model: z.string().optional(),
  effort: EffortLevel.optional(),
});

const Input = z.object({
  type: z.literal('input'),
  ref: ChannelRef,
  runId: z.string(),
  text: z.string(),
  /** Optional images attached to this turn. */
  images: z.array(ImageInput).optional(),
  /** Optional non-image attachments for the same turn (see FileInput). */
  files: z.array(FileInput).optional(),
  /** Private machine: the content fields sealed in one envelope (docs/E2EE.md). */
  e2e: E2eField,
  /** Private machine: text + image count + file names for the other screens'
   *  `user_turn`, sealed separately so they need not carry the attachment bytes. */
  turnE2e: E2eField,
});

/**
 * «I have seen this session» — the person had it open on screen. The hub
 * stamps its own clock (no client time: devices disagree), keeps the latest
 * stamp per user and session, and tells the person's other sockets
 * (`session_reads`), so a finished session read on one device stops showing
 * as unread on all of them. Send it when a session becomes visible and again
 * while it stays visible and new output arrives; clients throttle.
 */
const SessionReadMsg = z.object({
  type: z.literal('session_read'),
  machineId: z.string(),
  sessionId: z.string(),
});

const Interrupt = z.object({ type: z.literal('interrupt'), runId: z.string(), ref: ChannelRef });
const CloseRun = z.object({ type: z.literal('close'), runId: z.string(), ref: ChannelRef });

const ToolDecision = z.object({
  type: z.literal('tool_decision'),
  ref: ChannelRef,
  runId: z.string(),
  requestId: z.string(),
  allow: z.boolean(),
  /** Modified tool input returned to the SDK — how an AskUserQuestion answer or
   *  an approved ExitPlanMode selection travels back (PermissionResult.updatedInput). */
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  /** Apply this permission mode together with the decision (used by the native-
   *  style ExitPlanMode choices). */
  permissionMode: PermissionMode.optional(),
  message: z.string().optional(),
  e2e: E2eField,
});

const Rescan = z.object({ type: z.literal('rescan'), machineId: z.string() });

// Kanban stage of a session (Flow board). Mutable, hub-persisted per
// (machineId, sessionId). Requires control access. `stage` is validated against
// the SessionStage enum on the hub; an omitted/empty stage clears it (off-board).
const SetStage = z.object({
  type: z.literal('set_stage'),
  machineId: z.string(),
  sessionId: z.string(),
  stage: z.string().optional(),
});

// End a session outright (used by the Flow board's "confirm Done" action). The
// hub closes an active cc-remote run if there is one, else asks the agent to
// terminate the external editor writer (end_external_session). Control-gated.
const EndSession = z.object({
  type: z.literal('end_session'),
  machineId: z.string(),
  sessionId: z.string(),
});

// Attach / detach this replaceable UI socket to an already-open run's stream.
// Neither unsubscribe nor socket disconnect owns the run lifetime; only an
// explicit CloseRun (or an agent terminal state) stops the single writer.
const Subscribe = z.object({ type: z.literal('subscribe'), runId: z.string(), ref: ChannelRef });
const Unsubscribe = z.object({ type: z.literal('unsubscribe'), runId: z.string(), ref: ChannelRef });

// Generic RPC to a machine (files, git, session ops, models, history).
const RpcRequest = z.object({
  type: z.literal('rpc_request'),
  requestId: z.string(),
  machineId: z.string(),
  method: RpcMethodSchema,
  params: z.record(z.string(), z.unknown()),
});

// Read-only mirror of a live session's transcript (browser -> central). The
// browser allocates `mirrorId` so it can correlate the `mirror_opened` ack (and
// every `mirror_data`) to THIS open — never by arrival order, which races when
// two opens are in flight.
const MirrorOpenB = z.object({ type: z.literal('mirror_open'), mirrorId: z.string(), machineId: z.string(), sessionId: z.string(), cwd: z.string() });
const MirrorCloseB = z.object({ type: z.literal('mirror_close'), mirrorId: z.string() });

// Terminal (browser -> central). The browser allocates `termId` (see MirrorOpenB
// for why) so the `term_opened` ack matches by id, not by FIFO order.
const TermOpen = z.object({ type: z.literal('term_open'), termId: z.string(), machineId: z.string(), cwd: z.string().optional() });
const TermInput = z.object({ type: z.literal('term_input'), termId: z.string(), data: z.string(), e2e: E2eField });
const TermResize = z.object({ type: z.literal('term_resize'), termId: z.string(), cols: z.number(), rows: z.number() });
const TermCloseB = z.object({ type: z.literal('term_close'), termId: z.string() });

// Run controls.
const SetModel = z.object({ type: z.literal('set_model'), runId: z.string(), model: z.string().optional() });
const SetPermissionMode = z.object({
  type: z.literal('set_permission_mode'),
  runId: z.string(),
  mode: PermissionMode,
  /** Private machine: the mode sealed (the clear one is a hint the agent ignores). */
  e2e: E2eField,
});
const SetEffort = z.object({
  type: z.literal('set_effort'),
  runId: z.string(),
  effort: EffortLevel.optional(),
  ultracode: z.boolean().optional(),
});

// Push registration (native mobile clients). The web app never sends these; the
// hub stores the APNs device token in memory and pushes on attention transitions
// (needs_attention / error / idle-after-long-work). Re-sent on every connect.
const RegisterPush = z.object({
  type: z.literal('register_push'),
  deviceToken: z.string(),
  platform: z.enum(['ios', 'android']),
});
const UnregisterPush = z.object({ type: z.literal('unregister_push'), deviceToken: z.string(), platform: z.enum(['ios', 'android']).optional() });

// Keepalive: an idle browser link gets reaped by NAT / load-balancer idle
// timeouts; the UI pings every 25s to keep the path warm. The hub ignores it.
const Ping = z.object({ type: z.literal('ping') });

// Backgrounded client hush: `pause` stops ALL hub->this-socket traffic (a
// suspended app cannot drain its socket, and a full outbound queue got the peer
// dropped as slow — the "reconnect on every app switch" failure). `resume`
// lifts the gate and is answered with one fresh snapshot, so the client
// re-syncs without reconnecting. Server-side WS pings keep the quiet pipe
// alive through NAT/nginx meanwhile.
const Pause = z.object({ type: z.literal('pause') });
const Resume = z.object({ type: z.literal('resume') });

/** The `hello.caps` entry that moves `machine_stats` from push-always to
 *  on-demand — see `StatsInterest`. */
export const CAP_STATS_ON_DEMAND = 'statsOnDemand';

/**
 * «I am (not) showing hardware telemetry right now.» Meaningful only from a
 * client that announced `statsOnDemand` in `hello.caps`: the hub then sends it
 * `machine_stats` only while the last `stats_interest` said `on: true`, and on
 * the transition to `on: true` replies at once with the last stored sample of
 * every machine the viewer controls (so the screen does not wait up to 30 s
 * for the next agent sample). `on: false` stops the stream. A client WITHOUT
 * the cap keeps receiving every sample, exactly as before, and its
 * `stats_interest` is ignored.
 *
 * The state is per socket and dies with it: send it again after a reconnect.
 * It survives `pause`/`resume` (a paused socket gets nothing either way).
 */
const StatsInterest = z.object({ type: z.literal('stats_interest'), on: z.boolean() });

// Client self-identification, sent once on connect (before any `open`). Lets the
// hub tag each run's `origin` so the board can split App vs Web. The web app may
// omit it (the hub treats an unidentified client as 'web').
const Hello = z.object({
  type: z.literal('hello'),
  client: z.enum(['app', 'web']),
  /**
   * Optional things this build understands that the hub must not assume.
   *
   * `sessionDelta` = "send me `machine_sessions` for one machine instead of
   * re-sending every machine's list". `sessionPatch` = "and go finer still:
   * `session_updates` with only the sessions that changed". Both have to be
   * negotiated rather than switched on, because a client that does not know a
   * message simply ignores it — and a build that stopped receiving snapshots
   * would quietly show a frozen session list forever.
   *
   * `statsOnDemand` = "send me `machine_stats` only while I say so with
   * `stats_interest`" (see `StatsInterest`).
   */
  caps: z.array(z.string().max(40)).max(16).optional(),
});

/** Context budget for the focused run, relayed from the agent. Drives the
 *  "how full is this session" indicator and the compact prompt. */
const ContextUsageOut = z.object({
  type: z.literal('context_usage'),
  /** The pane this answers — see `ChannelRef`. */
  ref: ChannelRef,
  runId: z.string(),
  sessionId: z.string(),
  totalTokens: z.number(),
  maxTokens: z.number(),
  percentage: z.number(),
  autoCompactThreshold: z.number().optional(),
  autoCompactEnabled: z.boolean(),
});

/** Compact the focused run's context on demand (browser -> central). */
const CompactRun = z.object({
  type: z.literal('compact'),
  runId: z.string(),
  ref: ChannelRef,
});

/** Every memory the viewer owns, across all scopes. Metadata only — bodies are
 *  fetched one at a time with `memory_read`, because the corpus is a few
 *  hundred notes and shipping every body to draw a list would be waste. Unlike
 *  the agent's `memory_catalog` this is NOT machine-scoped: the browser is
 *  looking at the user's own store, not at what one host should hold. */
const MemoryListReq = z.object({
  type: z.literal('memory_list'),
  requestId: z.string(),
});

/** One memory's body. Addressed by its full identity rather than an opaque id
 *  so the browser needs no extra state beyond what the list already gave it. */
const MemoryReadReq = z.object({
  type: z.literal('memory_read'),
  requestId: z.string(),
  scope: MemoryScope,
  scopeKey: z.string(),
  path: z.string().min(1).max(512),
});

/** Tombstone a memory. Deletion is hub-side only: the row is marked and every
 *  agent learns about it through the catalog, which is what stops a machine
 *  that still holds the file from pushing it straight back. */
const MemoryDeleteReq = z.object({
  type: z.literal('memory_delete'),
  requestId: z.string(),
  scope: MemoryScope,
  scopeKey: z.string(),
  path: z.string().min(1).max(512),
});

/** Structured annotation of one assistant turn, produced by the hub's LLM pass
 *  (and, before that lands, approximated client-side by heuristics). Every
 *  field optional — an empty enrichment is a valid answer: "nothing to add". */
export const EnrichmentSchema = z.object({
  /** Optional semantic navigation title, only for purpose=session_title. */
  sessionTitle: z.string().min(3).max(40).optional(),
  /** What one tap can send into the session. `send` is the literal message.
   *
   *  `kind` says what KIND of move the button is, because they are not
   *  interchangeable and a person must not fire one thinking it was another:
   *
   *  - `answer` — the turn ended with a question and this answers it.
   *  - `next`   — the obvious next step in THIS piece of work.
   *  - `idea`   — an adjacent thing worth doing that nobody asked for. It
   *               starts new work rather than continuing the thread, so the
   *               strip renders it apart from the other two.
   *
   *  Absent means `answer`: that was the only kind before, and a hub that has
   *  not been updated keeps meaning it.
   *
   *  (There used to be `decisions` and `digest` here — a summary of the turn,
   *  shown above the buttons under an «итог» kicker. It restated a turn the
   *  reader had just read, which is the one thing a strip under the transcript
   *  must not do; the buttons were always the part that earned its space.) */
  /** Why the agent stopped, as the hub's model judged it: `done` (finished,
   *  the buttons are extras), `question` (it asked something), `blocked` (it
   *  cannot go on without the user). Rides only alongside buttons. Absent from
   *  a hub that predates it and from heuristic strips. */
  handoff: z.enum(['question', 'blocked', 'done']).optional(),
  quickReplies: z
    .array(
      z.object({
        label: z.string().max(60),
        send: z.string().max(500),
        kind: z.enum(['answer', 'next', 'idea']).optional(),
      }),
    )
    .max(5)
    .optional(),
});
export type Enrichment = z.infer<typeof EnrichmentSchema>;

/** Enrich one assistant turn. The BROWSER carries the text: at the moment that
 *  matters (run just went idle) the hub's replica lags the screen, and the
 *  browser is the one place the rendered text reliably exists for history,
 *  live and mirror alike. The hub validates, checks the viewer's ACL on the
 *  session, caches, and proxies to the LLM gateway — it never logs the text. */
const EnrichReq = z.object({
  type: z.literal('enrich_request'),
  purpose: z.enum(['session_title']).optional(),
  requestId: z.string(),
  machineId: z.string(),
  sessionId: z.string(),
  source: z.enum(['claude', 'codex']).optional(),
  /** Tail-turn identity — the cache key, alongside a hash of the text. */
  uuid: z.string().max(200),
  /** The turn's text, client-truncated (keep the end: the question lives there). */
  text: z.string().min(1).max(16_000),
  /** The user turn that prompted it, for context only. */
  userText: z.string().max(4_000).optional(),
  /** What the turn DID, not just what it said: the user's ask, every tool
   *  call, every error, a little of the exchanges before. Built by the web
   *  (`buildTurnDigest`); without it the model judged a turn by its closing
   *  summary and proposed steps the agent had already taken. */
  digest: z.string().max(16_000).optional(),
});

export const BrowserToCentral = z.discriminatedUnion('type', [
  SessionReadMsg,
  EnrichReq,
  MemoryListReq,
  MemoryReadReq,
  MemoryDeleteReq,
  CompactRun,
  Open,
  NewSession,
  Takeover,
  Input,
  Interrupt,
  CloseRun,
  ToolDecision,
  Rescan,
  Subscribe,
  Unsubscribe,
  RpcRequest,
  MirrorOpenB,
  MirrorCloseB,
  TermOpen,
  TermInput,
  TermResize,
  TermCloseB,
  SetModel,
  SetPermissionMode,
  RegisterPush,
  UnregisterPush,
  SetEffort,
  SetStage,
  EndSession,
  Ping,
  Pause,
  Resume,
  StatsInterest,
  Hello,
]);
export type BrowserToCentral = z.infer<typeof BrowserToCentral>;

// ---------------------------------------------------------------------------
// Central -> Browser
// ---------------------------------------------------------------------------

export const RoadmapConfig = z.object({
  groups: z.array(z.object({
    id: z.string(),
    name: z.string(),
    blurb: z.string().default(''),
    projects: z.array(z.string()),
  })),
  unassigned: z.object({
    name: z.string(),
    blurb: z.string().default(''),
  }),
});
export type RoadmapConfig = z.infer<typeof RoadmapConfig>;

/**
 * A team member's machine as the team's owner or a manager sees it on
 * «Машины» (14.11.2026, Owner: «менеджер видел машины команды»): READ-ONLY
 * hardware, never a way in. Deliberately not a `MachineSnapshot`: no sessions,
 * no usage/profile, no control flags — so nothing that lists `machines`
 * (side panel, pickers) ever offers it. The hub strips on send: `stats.top`
 * (process command lines) is always empty, and `runtimes` keep only
 * present/auth/provider/version/checkedAt/expiresAt (no account e-mail, plan,
 * path, error or detail). Its live samples arrive as the ordinary
 * `machine_stats` / `runtime_status` messages, stripped the same way.
 */
export const TeamMachine = z.object({
  machine: MachineInfo,
  owner: z.object({ userId: z.string(), email: z.string().optional(), fullName: z.string().optional() }),
  online: z.boolean(),
  lastSeen: z.number(),
  stats: MachineStatsSchema.optional(),
  runtimes: RuntimeStatus.optional(),
});
export type TeamMachine = z.infer<typeof TeamMachine>;

const Snapshot = z.object({
  type: z.literal('snapshot'),
  viewer: ViewerContext.optional(),
  machines: z.array(MachineSnapshot),
  /** Team members' machines for the workspace owner / a manager, read-only
   *  (`TeamMachine`). Absent for everyone else and on older hubs. A machine the
   *  viewer already has in `machines` is never repeated here. */
  teamMachines: z.array(TeamMachine).optional(),
  /** All currently-open runs across machines (board + attention). */
  activeRuns: z.array(ActiveRunInfo).optional(),
  /** Server-owned editorial product grouping for roadmap-capable clients. */
  roadmap: RoadmapConfig.optional(),
});

/**
 * One machine's session list, replacing that machine's entry in the snapshot.
 *
 * The snapshot is the fleet, and re-sending the fleet because one machine moved
 * is what made an idle phone pay hundreds of KB every few seconds: measured on
 * this fleet, the difference between consecutive snapshots was routinely ONE
 * session's `lastModified` inside 981 sessions across eight machines.
 *
 * Sent only to a client that asked for it in `hello.caps` — everyone else keeps
 * getting whole snapshots, so an older build is stale-proof rather than broken.
 * Clients replace the matching entry by `machine.machineId` (and append if they
 * somehow do not have it); everything not about sessions — active runs, usage,
 * telemetry — keeps arriving on its own existing delta.
 */
const MachineSessions = z.object({
  type: z.literal('machine_sessions'),
  machine: MachineSnapshot,
});

/**
 * The sessions of one machine that actually changed — the same idea as
 * `machine_sessions` taken one step down.
 *
 * A machine's whole list is still ~90 KB, and the thing that provokes it is
 * routinely a single session's `lastModified` moving while somebody types. This
 * carries only the entries that differ, so that costs a few hundred bytes.
 *
 * Merge semantics, and clients must implement all three:
 *  - `sessions` — upsert by `sessionId`; an entry replaces its predecessor
 *    WHOLE (never field-by-field: an absent optional means absent, and merging
 *    per field would resurrect a `livePid` the agent just stopped reporting).
 *  - `removed` — drop those ids. Removing one that is not held is a no-op, so a
 *    client that connected mid-stream is never wrong for having missed it.
 *  - Re-sort the machine's list newest-first afterwards; the hub's own ordering
 *    does not survive a patch.
 *
 * Gated on the `sessionPatch` capability, separately from `sessionDelta`: a
 * client already in the field understands the machine-level message and not
 * this one.
 */
const SessionUpdates = z.object({
  type: z.literal('session_updates'),
  machineId: z.string(),
  sessions: z.array(SessionSummary),
  removed: z.array(z.string()).optional(),
});

// Lightweight delta: the central re-sends the full active-run list whenever any
// run's attention state changes (cheaper than rebroadcasting the snapshot).
const Activity = z.object({
  type: z.literal('activity'),
  runs: z.array(ActiveRunInfo),
});

// Lightweight usage delta: a machine's account limits refreshed. Sent instead of
// a full snapshot so a 180s usage poll doesn't re-broadcast every session.
const UsageMsg = z.object({
  type: z.literal('usage'),
  machineId: z.string(),
  usage: UsageInfo,
});

/**
 * Read marks of this person (see `session_read`): sent once after `hello`
 * with the recent ones, then one entry at a time as any of their devices
 * reads. `at` is hub time in ms — compare it with `ActiveRunInfo.since` of the
 * finished run: read at or after it means the completion was seen.
 */
const SessionReadsMsg = z.object({
  type: z.literal('session_reads'),
  reads: z.array(z.object({ machineId: z.string(), sessionId: z.string(), at: z.number() })),
});

/**
 * Finished turns of this person's own runs, sent once after `session_reads`
 * (last three days). `at` is the run's `since` at the finish, in hub time, so
 * it compares with read marks and with an `activity` run seen going idle. A
 * run does not outlive an agent restart or the hub's six-hour idle reaper; this
 * is how a device that slept through the finish still learns of it. No text
 * of the answer: the hub keeps this past transcript purges and private mode.
 */
const SessionCompletionsMsg = z.object({
  type: z.literal('session_completions'),
  completions: z.array(
    z.object({ machineId: z.string(), sessionId: z.string(), at: z.number() }),
  ),
});

// Lightweight stage delta: a session's kanban stage changed (drag / confirm Done).
// Sent instead of a full snapshot. `stage` absent => the session left the board.
const SessionStageMsg = z.object({
  type: z.literal('session_stage'),
  machineId: z.string(),
  sessionId: z.string(),
  stage: z.string().optional(),
});

// Transient "a real commit just landed in this session" nudge → the Flow card
// shows a "готово к закрытию" affordance. Not persisted (ephemeral like attention
// state); cleared by the web when the card moves to Done or is dismissed.
const SessionCommittedMsg = z.object({
  type: z.literal('session_committed'),
  machineId: z.string(),
  sessionId: z.string(),
});

const CodexUsageMsg = z.object({
  type: z.literal('codex_usage'),
  machineId: z.string(),
  usage: UsageInfo,
});

// Lightweight builder-profile delta: a machine recomputed its coding-style
// profile. Same rationale as UsageMsg — a refresh shouldn't rebroadcast sessions.
const ProfileMsg = z.object({
  type: z.literal('builder_profile'),
  machineId: z.string(),
  profile: BuilderProfile,
});

const Opened = z.object({
  type: z.literal('opened'),
  /** The pane this answers — see `ChannelRef`. */
  ref: ChannelRef,
  runId: z.string(),
  machineId: z.string(),
  sessionId: z.string(),
});

// A new_session run's real session id, once the SDK mints it (browser replaces
// the empty placeholder it attached with).
const SessionStarted = z.object({
  type: z.literal('session_started'),
  /** The pane this answers — see `ChannelRef`. */
  ref: ChannelRef,
  runId: z.string(),
  sessionId: z.string(),
});

const Stream = z.object({
  type: z.literal('stream'),
  /** The pane this answers — see `ChannelRef`. */
  ref: ChannelRef,
  runId: z.string(),
  sessionId: z.string(),
  event: z.object({
    kind: z.enum(['system', 'assistant', 'partial', 'tool_use', 'result', 'error', 'status']),
    text: z.string().optional(),
    /** Machine-readable meaning of the event, when the agent could tell — the
     *  same vocabulary as `Stream.event.code` in protocol.ts (`budget_exhausted`,
     *  `turn_failed`, `api_retry`, `rate_limit`, `compact_started|done|failed`,
     *  `stderr`, …). The UI keys behaviour on it — a card, a folded log line,
     *  the «Сжимаю…» button — instead of matching text. Absent = plain event. */
    code: z.string().optional(),
    /** Structured payload for the code (attempt counters, token counts, cost). */
    data: z.record(z.string(), z.unknown()).optional(),
    /** Private machine: `text`, `raw`, `data` sealed (docs/E2EE.md). */
    e2e: E2eField,
  }),
});

const ToolRequestMsg = z.object({
  type: z.literal('tool_request'),
  /** The pane this answers — see `ChannelRef`. */
  ref: ChannelRef,
  runId: z.string(),
  sessionId: z.string(),
  requestId: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  /** Private machine: `input` and `title` sealed. */
  e2e: E2eField,
});

/** That request has been answered — by another client, another tab, or another
 *  pane of the same tab — so drop its modal. A `tool_request` is fanned out to
 *  EVERY viewer that may drive the run, and until this existed the copy nobody
 *  answered stayed on screen: the plan looked like it had been asked twice, and
 *  pressing the stale one sent a decision the agent silently drops. */
const ToolResolvedMsg = z.object({
  type: z.literal('tool_resolved'),
  runId: z.string(),
  requestId: z.string(),
});

/** What a person handed a run, for every screen attached to it (hub-made;
 *  `user_turn_frame` in server-rs/src/hub/attachments.rs). The composer that sent it
 *  already shows an echo and folds this into it by text; every OTHER screen —
 *  the desktop following a run the phone drives — had nothing, and the answer
 *  streamed in under the previous one with the question missing (28.09.2026).
 *  Replayed to a late subscriber with the rest of the turn. */
const UserTurnMsg = z.object({
  type: z.literal('user_turn'),
  ref: ChannelRef,
  runId: z.string(),
  sessionId: z.string(),
  /** One turn, one id: the fold ignores a turn it already shows. */
  turnId: z.string(),
  /** Capped at 16 KiB characters for the other screens (`USER_TURN_TEXT_MAX`);
   *  the whole text goes to the agent and into the transcript. */
  text: z.string(),
  /** `text` is the head of a longer message. */
  truncated: z.boolean().optional(),
  ts: z.number().optional(),
  /** How many pictures came with it — the bytes stay with the sender. */
  images: z.number().int().nonnegative().optional(),
  /** Names of attached files. */
  files: z.array(z.string()).optional(),
  /** Private machine: `text` (then ''), image count and file names, sealed. */
  e2e: E2eField,
});
export type UserTurnMsg = z.infer<typeof UserTurnMsg>;

const RunStatusMsg = z.object({
  type: z.literal('run_status'),
  /** The pane this answers — see `ChannelRef`. */
  ref: ChannelRef,
  runId: z.string(),
  sessionId: z.string(),
  state: RunState,
  /** Agent clock: last user input accepted for this task; replayed on reconnect. */
  taskStartedAt: z.number().int().positive().optional(),
  error: z.string().optional(),
  /** Private machine: `error` sealed (docs/E2EE.md). */
  e2e: E2eField,
  /** Why a terminal state happened (see protocol.ts `RunStatus.code`).
   *  `resume_refused` = nothing sent with the `open` was delivered; the client
   *  gives the text and attachments back. */
  code: z.string().optional(),
});

/** The focused run's permission mode changed (relayed from the agent) so the UI
 *  indicator tracks the real mode instead of the last value it set optimistically. */
const RunModeMsg = z.object({
  type: z.literal('run_mode'),
  /** The pane this answers — see `ChannelRef`. */
  ref: ChannelRef,
  runId: z.string(),
  sessionId: z.string(),
  mode: PermissionMode,
});

/** The focused run's live model / reasoning settings (relayed from the agent,
 *  and replayed by the hub on subscribe). Without it the composer's model and
 *  effort pickers have no way back to the truth: `set_model` / `set_effort` only
 *  travel outward, so every reload reset them to a "default" the run may not be
 *  on. Absent `model`/`effort` = the account default is in force. */
const RunSettingsMsg = z.object({
  type: z.literal('run_settings'),
  /** The pane this answers — see `ChannelRef`. */
  ref: ChannelRef,
  runId: z.string(),
  sessionId: z.string(),
  model: z.string().optional(),
  activeModel: z.string().optional(),
  effort: EffortLevel.optional(),
  /**
   * The level the turn is ACTUALLY running at (twin of `activeModel`), as
   * opposed to `effort`, which is only what somebody pinned. Belongs here and
   * not just on the agent-facing schema: this decoder is a zod parse, so a
   * field missing from THIS object is stripped on arrival — the value crosses
   * the wire, passes the hub, and vanishes one line before the UI reads it.
   * That is exactly how it was lost, with every other layer looking correct.
   *
   * And the WIDE domain, which is the other half of the same lesson: declaring
   * the field with `EffortLevel` left `max` out, and `max` is precisely the
   * value only this field can carry — the CLI reports it and nothing can pin
   * it. A frame carrying it then failed the parse ENTIRELY, so a session
   * running at max lost its model updates too, and the decoder's `catch`
   * dropped the message with nothing logged.
   */
  activeEffort: ActiveEffortLevel.optional(),
  ultracode: z.boolean().optional(),
});

const ErrorMsg = z.object({
  type: z.literal('error'),
  /** The pane this answers — see `ChannelRef`. */
  ref: ChannelRef,
  message: z.string(),
  /**
   * Machine-readable reason, for the errors a client must DO something about
   * rather than merely show.
   *
   * `run_gone` is the one that matters: the message never reached the session,
   * so the client has to give the text back instead of leaving the person
   * looking at an empty composer and a flash. Matching on the human sentence
   * would work until someone rewords it.
   *
   * `machine_offline` says the same thing for a different reason: the run is
   * alive, but its agent has no socket right now (reconnecting), so the hub
   * refused to forward rather than drop the frame on the floor. Same recovery.
   *
   * `attachments_dropped` rides with a message that WAS delivered, minus the
   * attachments that did not fit the per-message budget — named in the text.
   *
   * A string rather than an enum so a client built before a code existed still
   * decodes the frame and shows the sentence.
   *
   * `run_active` = the session already has a live run; the refusal carries its
   * `runId` so the client can subscribe to that run instead of reopening (the
   * CLI's b0503f9 recovery). Declared here because the web's zod silently
   * strips fields the schema does not name.
   */
  code: z.string().optional(),
  /** With `run_active`: the id of the run holding the session's lock. */
  runId: z.string().optional(),
});

const RpcResponse = z.object({
  type: z.literal('rpc_response'),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  /** Private machine: an `ok:false` answer's `error` text sealed (then a placeholder). */
  e2e: E2eField,
});

const TermOpened = z.object({ type: z.literal('term_opened'), termId: z.string(), machineId: z.string() });
const TermData = z.object({ type: z.literal('term_data'), termId: z.string(), data: z.string(), e2e: E2eField });
const TermExit = z.object({ type: z.literal('term_exit'), termId: z.string(), code: z.number().optional() });

const MirrorOpened = z.object({ type: z.literal('mirror_opened'), mirrorId: z.string(), machineId: z.string() });
const MirrorDataMsg = z.object({
  type: z.literal('mirror_data'),
  mirrorId: z.string(),
  replace: z.boolean(),
  messages: z.array(HistoryMessageSchema).max(200),
});
/** The mirror's agent went away — the live view is dead, not just quiet. */
// Lightweight hardware delta: a machine's periodic telemetry sample. Same
// rationale as UsageMsg — a ~30s stats poll must not re-broadcast the snapshot.
const MachineStatsMsg = z.object({
  type: z.literal('machine_stats'),
  machineId: z.string(),
  stats: MachineStatsSchema,
});

/** A machine's runtimes changed (login appeared, codex installed, a probe
 *  started failing). Same private fan-out as `usage`. */
const RuntimeStatusMsg = z.object({
  type: z.literal('runtime_status'),
  machineId: z.string(),
  runtimes: RuntimeStatus,
});

const MirrorExit = z.object({ type: z.literal('mirror_exit'), mirrorId: z.string() });

/** Answer to `memory_list`. `ok:false` carries `error` and no `memories` —
 *  optional here means ABSENT, never null (see CLAUDE.md). */
const MemoryListResult = z.object({
  type: z.literal('memory_list_result'),
  requestId: z.string(),
  ok: z.boolean(),
  memories: z.array(MemoryEntry).optional(),
  error: z.string().optional(),
});

/** Answer to `memory_read`. A tombstoned or absent note is `ok:false` rather
 *  than an empty body, so the UI can say "gone" instead of drawing a blank. */
const MemoryReadResult = z.object({
  type: z.literal('memory_read_result'),
  requestId: z.string(),
  ok: z.boolean(),
  content: z.string().optional(),
  error: z.string().optional(),
});

/** Answer to `memory_delete`. The UI refetches the list on success rather than
 *  patching it locally, so nothing but the outcome is carried here. */
const MemoryDeleteResult = z.object({
  type: z.literal('memory_delete_result'),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

/** Answer to `enrich_request`. `ok:false` carries `error` and no enrichment;
 *  "enrichment not configured" is a terminal one — the client stops asking.
 *  Optional means ABSENT, never null (CLAUDE.md rule 3). */
const EnrichResult = z.object({
  type: z.literal('enrich_result'),
  requestId: z.string(),
  ok: z.boolean(),
  enrichment: EnrichmentSchema.optional(),
  error: z.string().optional(),
});

export const CentralToBrowser = z.discriminatedUnion('type', [
  SessionReadsMsg,
  SessionCompletionsMsg,
  EnrichResult,
  MemoryListResult,
  MemoryReadResult,
  MemoryDeleteResult,
  ContextUsageOut,
  Snapshot,
  MachineSessions,
  SessionUpdates,
  Activity,
  UsageMsg,
  CodexUsageMsg,
  ProfileMsg,
  MachineStatsMsg,
  RuntimeStatusMsg,
  SessionStageMsg,
  SessionCommittedMsg,
  Opened,
  SessionStarted,
  Stream,
  ToolRequestMsg,
  ToolResolvedMsg,
  UserTurnMsg,
  RunStatusMsg,
  RunModeMsg,
  RunSettingsMsg,
  ErrorMsg,
  RpcResponse,
  TermOpened,
  TermData,
  TermExit,
  MirrorOpened,
  MirrorDataMsg,
  MirrorExit,
]);
export type CentralToBrowser = z.infer<typeof CentralToBrowser>;

export function decodeBrowserToCentral(raw: string): BrowserToCentral {
  return BrowserToCentral.parse(JSON.parse(raw));
}
export function decodeCentralToBrowser(raw: string): CentralToBrowser {
  return CentralToBrowser.parse(JSON.parse(raw));
}
