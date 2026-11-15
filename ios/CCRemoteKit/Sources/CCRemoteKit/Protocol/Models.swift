import Foundation

// MARK: - Tolerant string enums
//
// Every discriminant that could gain a new value in a future hub deploy decodes
// unknown strings to `.unknown` instead of throwing — one new enum value must
// never brick the whole frame (or the app).

public enum OsKind: String, Codable, Sendable {
    case mac, windows, linux, unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = OsKind(rawValue: raw) ?? .unknown
    }
}

public enum AttentionState: String, Codable, Sendable, Hashable {
    case working, needs_attention, idle, error, unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AttentionState(rawValue: raw) ?? .unknown
    }
}

public enum RunState: String, Codable, Sendable {
    case started, idle, ended, error, yielded, unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RunState(rawValue: raw) ?? .unknown
    }
}

public enum PermissionMode: String, Codable, Sendable, CaseIterable {
    case `default`, plan, acceptEdits, bypassPermissions, dontAsk, auto, unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PermissionMode(rawValue: raw) ?? .unknown
    }
    /// The three modes the UI exposes as a picker (matching the web).
    public static let exposed: [PermissionMode] = [.default, .plan, .acceptEdits]
    /// What the mode DOES, not what the wire calls it. `default` is the wire's
    /// word for "ask me before every write" — printed literally it told the
    /// person holding the control nothing, and left every picker in the app
    /// reading "Default". The raw values are the contract and do not change.
    public var label: String {
        switch self {
        case .default: return "Ask first"
        case .plan: return "Plan"
        case .acceptEdits: return "Auto-edit"
        case .bypassPermissions: return "No prompts"
        case .dontAsk: return "No prompts"
        case .auto: return "Auto"
        case .unknown: return "—"
        }
    }
}

/// Reasoning effort settable live on a running session (mirrors `EffortLevel` in
/// protocol.ts). `max` is intentionally omitted — it isn't live-settable.
public enum EffortLevel: String, Codable, Sendable, CaseIterable, Identifiable {
    case low, medium, high, xhigh
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        // NOT "Max": the runtime has a separate `max` above this one, so the
        // word claims a ceiling this level does not hold — and to anyone who
        // knows the levels it reads as a lie («it says max, but I'm on high»).
        // The web said so first; this is the client that had not caught up.
        case .xhigh: return "Very high"
        }
    }
}

/// Who the hub thinks we are, and which workspaces that user can see. Arrives in
/// the snapshot (and from `/api/me`) — the app ignored it entirely while it
/// authenticated as the machine owner.
public struct WorkspaceSummary: Codable, Hashable, Identifiable, Sendable {
    public let workspaceId: String
    public let name: String
    /// "personal" | "organization"
    public let kind: String
    /// "owner" | "manager" | "member"
    public let role: String
    public var id: String { workspaceId }
    public var isPersonal: Bool { kind == "personal" }
    public var displayName: String { isPersonal ? "Моя работа" : name }
}

/// The viewer's hosted sandbox, as the community rollout reports it
/// (`ViewerAccess.sandbox` on the wire). `status` is one of none | queued |
/// running | ready | failed | suspended.
public struct ViewerSandbox: Codable, Hashable, Sendable {
    public let status: String
    public var machineId: String?
    public var machineName: String?
}

/// Where the viewer stands in the community rollout (`ViewerAccess` on the
/// wire). `state` is waitlist | active | suspended; `plan` is employee |
/// community. Older hubs omit the whole object — treat absent as active.
public struct ViewerAccess: Codable, Hashable, Sendable {
    public let state: String
    public let plan: String
    public var sandbox: ViewerSandbox?
    public var deviceCap: Int?
    public var isActive: Bool { state == "active" }
}

public struct ViewerContext: Codable, Hashable, Sendable {
    public let userId: String
    /// Absent for an account without an address (Telegram-only sign-in).
    /// Required here used to drop the WHOLE viewer from the snapshot decode.
    public let email: String?
    public var fullName: String?
    /// The Telegram account linked as a way in (`@username`, or `tg:<id>`).
    public var telegram: String?
    public var platformAdmin: Bool = false
    public let workspace: WorkspaceSummary
    public var workspaces: [WorkspaceSummary] = []
    /// Absent on hubs that predate the community rollout.
    public var access: ViewerAccess?
    public var displayName: String { fullName ?? email ?? "Без имени" }
    /// False only when the hub says so; an absent `access` means the product
    /// is fully open to this viewer.
    public var isAccessActive: Bool { access?.isActive ?? true }

    /// Personal storage is not a team. Keep it on the wire for account caches,
    /// but show only actual teams in navigation, as the web's teamsOf does.
    public var teams: [WorkspaceSummary] {
        var result = workspaces.filter { $0.kind == "organization" }
        if workspace.kind == "organization", !result.contains(where: { $0.id == workspace.id }) {
            result.append(workspace)
        }
        return result
    }

    /// What the workspace switcher offers: teams only (personal is never a
    /// choice once a team exists), and nothing at all below two of them.
    public var switcherChoices: [WorkspaceSummary] {
        let available = teams
        return available.count >= 2 ? available : []
    }

    /// Preserve a chosen team; migrate an old personal selection to a team.
    /// Own machines remain accessible in an organization workspace at the hub.
    public func preferredWorkspace(rememberedId: String, hasQueuedMessages: Bool = false) -> WorkspaceSummary {
        let available = teams
        let preferred = available.first { $0.id == rememberedId }
            ?? available.first { $0.role == "owner" }
            ?? available.first
            ?? workspace
        // Reconnecting clears in-memory follow-ups and changes the durable
        // offline queue's scope. Never do that automatically while it has work.
        return hasQueuedMessages ? workspace : preferred
    }
}

/// One periodic hardware sample from an agent (`MachineStatsSchema`). All byte
/// fields are bytes.
public struct MachineStats: Codable, Hashable, Sendable {
    public let ts: Double
    public let platform: String
    public let cpuCount: Int
    public let load1: Double
    public let cpuPercent: Double
    public let memTotal: Double
    public let memUsed: Double
    public let swapTotal: Double
    public let swapUsed: Double
    public let diskTotal: Double
    public let diskUsed: Double
    public let uptimeSec: Double
    public let agentRss: Double
    public let agentCpuPercent: Double
}

/// A process as reported by `proc.list`.
public struct ProcessSample: Codable, Hashable, Identifiable, Sendable {
    public let pid: Int
    /// CPU percent as reported by ps (may exceed 100 on multicore).
    public let cpu: Double
    /// Resident set size, bytes.
    public let rss: Double
    public let command: String
    public var id: Int { pid }
}

/// Kanban stages for the Flow board — mirrors `shared/src/stages.ts`.
public enum SessionStage: String, CaseIterable, Identifiable, Codable, Sendable {
    case backlog, planning, in_progress, testing, done
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .backlog: return "Бэклог"
        case .planning: return "Планирование"
        case .in_progress: return "В работе"
        case .testing: return "Тестирование"
        case .done: return "Готово"
        }
    }
}

/// Session categories — mirrors `shared/src/categories.ts`. Starting a session
/// with one prefixes the first turn with the matching skill, and the category
/// then rides along in the inventory as a chip.
public enum SessionCategory: String, CaseIterable, Identifiable, Codable, Sendable {
    case rambling, sync, ship, verify, bugs, mobile, feature, codex, backlog, research, webpage, text, tz
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .rambling: return "Рамблинг"
        case .sync: return "Синхронизация"
        case .ship: return "Раскатать"
        case .verify: return "Проверить"
        case .bugs: return "Баги"
        case .mobile: return "Мобайл"
        case .feature: return "Большие фичи"
        case .codex: return "Ревью Codex'ом"
        case .backlog: return "Бэклог"
        case .research: return "Исследования"
        case .webpage: return "Веб-страница"
        case .text: return "Тексты"
        case .tz: return "ТЗ на бэкенд"
        }
    }
    /// The skill this category invokes — the id and the skill name are NOT the
    /// same everywhere (`ship` → `raskatai`, `codex` → `codex-review`), so a
    /// client that needs to know whether a machine can run a category has to
    /// compare against this, not against `rawValue`.
    public var skill: String {
        switch self {
        case .ship: return "raskatai"
        case .codex: return "codex-review"
        case .tz: return "backend-tz"
        default: return rawValue
        }
    }
    /// What the start screens offer. One entry, matching `SESSION_CATEGORIES`
    /// — the other eleven were a taxonomy above the composer that nobody used
    /// and are now `LEGACY_CATEGORIES`: still named and still chipped wherever
    /// an existing session carries one, never offered. `tz` is intake-only for
    /// its own reason (choosing it by hand would mean filing a spec with
    /// yourself).
    public static let pickable: [SessionCategory] = [.rambling]

    /// Can `machine` actually run this category? A `nil` skill list means the
    /// agent predates the skill bundle — that is "unknown", never "none", or
    /// every machine in the fleet loses its chips the day the hub updates.
    public func runnable(on skills: [String]?) -> Bool {
        guard let skills else { return true }
        return skills.contains(skill)
    }

    // Здесь жил `homeShortcuts` — ряд одноnажатийных стартов Главной, который
    // спрашивал «умеет ли ХОТЬ ОДНА онлайн-машина», а потом уводил на форму, где
    // машину выбирали заново. Главной нет, и вопрос стал точным: стартовый экран
    // уже знает, КУДА начинает, и отсеивает категории по скиллам именно ЭТОЙ
    // машины (`StartScreen.categories`). Приблизительный ответ был нужен только
    // экрану, который не знал точного.
}

/// What the run-controls menu offers: the four reasoning levels plus
/// **ultracode** (xhigh + workflow orchestration), which the wire carries as its
/// own flag rather than an effort value.
public enum EffortChoice: String, CaseIterable, Identifiable, Sendable {
    case low, medium, high, xhigh, ultracode
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        // NOT "Max": the runtime has a separate `max` above this one, so the
        // word claims a ceiling this level does not hold — and to anyone who
        // knows the levels it reads as a lie («it says max, but I'm on high»).
        // The web said so first; this is the client that had not caught up.
        case .xhigh: return "Very high"
        case .ultracode: return "Ultracode"
        }
    }
    public var effort: EffortLevel? { self == .ultracode ? nil : EffortLevel(rawValue: rawValue) }
    public var isUltracode: Bool { self == .ultracode }
}

public enum StreamKind: String, Codable, Sendable {
    case system, assistant, partial, tool_use, result, error, status, unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = StreamKind(rawValue: raw) ?? .unknown
    }
}

// MARK: - Domain entities (mirror shared/src/protocol.ts + web-protocol.ts)

public struct SessionSummary: Codable, Identifiable, Hashable, Sendable {
    public let sessionId: String
    /// Cleaned on arrival (`cleanTitle`) — raw titles are the first transcript
    /// line and are full of injected markdown/pseudo-tags.
    public var title: String
    public var cwd: String?
    public var project: String?
    public var gitBranch: String?
    public let lastModified: Double
    public var createdAt: Double?
    public var entrypoint: String?
    /// Set by the agent from the FIRST prompt («…Ответь одним словом: ок»):
    /// a scripted check, whatever title it later got (07.10.2026).
    public var automated: Bool?
    public var cliVersion: String?
    /// Present => a live editor holds this session; DO NOT resume (show Mirror).
    public var livePid: Int?
    /// Existing inventory signal from an editor process: busy | waiting | idle.
    /// A pid alone does not mean the agent is working; unknown values stay unknown.
    public var liveStatus: String?
    /// Which CLI produced this session ("codex" | "claude" | nil = claude).
    public var source: String?
    /// Sub-provider of a Codex thread, set by the hub: "opencode" = OpenCode Go
    /// (source stays "codex"). nil = plain Codex / Claude.
    public var provider: String?
    /// Session category (see `SessionCategory`), if started with one.
    public var category: String?
    /// Kanban stage for the Flow board; nil = off the board.
    public var stage: String?
    /// Codex-only recency heuristic (rollout touched recently). Display-only.
    public var active: Bool?
    /// Who this work belongs to, as the hub attributed it (workspace views).
    public var owner: MachineOwner?
    /// Set by the HUB: the transcript file is gone from the machine (Claude
    /// Code's cleanup, a wiped home) but the hub's replica still holds the
    /// history. Readable, never resumable — `open` is refused (web ddd1088).
    public var archived: Bool?

    public var id: String { sessionId }
    public var isLive: Bool { livePid != nil }
    public var isArchived: Bool { archived == true }
    /// Not work anyone comes back to (web `lib.ts` `isAutomatedSession` parity,
    /// 30.09.2026 — the drawer had drifted and showed «Ты — ревьюер диффа…»
    /// crons and a «tmp» project the web had long hidden).
    ///
    /// - Scripted: `sdk-cli` is the headless `claude -p` path — whoever owns it.
    ///   The owner exemption is gone on the web too: a cron started THROUGH
    ///   cc-remote carries an owner, so the exemption showed exactly those.
    ///   NOT `sdk-*`: older builds recorded app resumes as `sdk-ts`.
    /// - Scratch cwd / agent worktree: see `isScratchCwd`, `isWorktreeCwd`.
    /// - Probe title: liveness probes sent through cc-remote.
    public var isAutomated: Bool {
        SessionSummary.isScratchCwd(cwd) || SessionSummary.isWorktreeCwd(cwd)
            || SessionSummary.isProbeTitle(title) || entrypoint == "sdk-cli"
            || automated == true
    }

    /// A cwd the OS hands out as scratch: Windows `%LOCALAPPDATA%\Temp`, Linux
    /// `/tmp` and `/var/tmp` (the directories themselves too — 179 sessions sat
    /// in exactly `/tmp`), macOS `/var/folders/…/T` (also under `/private`).
    /// Matched on the ROOT, so a real `~/work/tmp/app` survives. Plus two agent
    /// working dirs, narrowly: a Claude Code scratchpad under `claude-*` /
    /// `.claude`, and `~/.cc-remote` right under a home.
    public static func isScratchCwd(_ cwd: String?) -> Bool {
        guard var p = cwd?.replacingOccurrences(of: "\\", with: "/").lowercased(), !p.isEmpty else {
            return false
        }
        while p.count > 1, p.hasSuffix("/") { p.removeLast() }
        if p.count > 2, p.dropFirst().hasPrefix(":/") { p = String(p.dropFirst(2)) }
        if p.hasPrefix("/private/") { p = String(p.dropFirst(8)) }
        if Re.test(#"/(claude-[^/]+|\.claude)/.*/scratchpad(/|$)"#, in: p) { return true }
        if Re.test(#"^/(root|home/[^/]+|users/[^/]+)/\.cc-remote(/|$)"#, in: p) { return true }
        return p == "/tmp" || p == "/var/tmp"
            || p.hasPrefix("/tmp/") || p.hasPrefix("/var/tmp/") || p.hasPrefix("/var/folders/")
            || p.hasPrefix("/windows/temp/") || p.contains("/appdata/local/temp/")
    }

    /// A run that isolated itself into `<repo>/.claude/worktrees/<name>`.
    public static func isWorktreeCwd(_ cwd: String?) -> Bool {
        guard let cwd else { return false }
        return cwd.replacingOccurrences(of: "\\", with: "/").lowercased().contains("/.claude/worktrees/")
    }

    /// Machine markers only — no role prompts, no one-word titles: a person
    /// opens real chats that way, and this hides a session from every list.
    public static func isProbeTitle(_ title: String?) -> Bool {
        guard let title else { return false }
        return Re.firstMatch(
            #"^\s*(echo probe|Ответь одним словом|reply with the single word|Run exactly this bash command|Оцени каждую сессию ниже по рубрике)"#,
            in: title, options: .caseInsensitive) != nil
    }
    public var categoryInfo: SessionCategory? { category.flatMap(SessionCategory.init(rawValue:)) }
    /// A Codex session resumed through the agent's app-server runtime.
    public var isCodex: Bool { source == "codex" }
    /// A Codex thread running on OpenCode Go (own logo, same runtime).
    public var isOpenCode: Bool { source == "codex" && provider == "opencode" }
}

extension SessionSummary {
    /// Lightweight inventory row while a new run awaits transcript discovery.
    public init(sessionId: String, title: String, project: String?, lastModified: Double) {
        self.sessionId = sessionId
        self.title = cleanTitle(title)
        self.project = project
        self.lastModified = lastModified
    }

}

public struct MachineInfo: Codable, Identifiable, Hashable, Sendable {
    public let machineId: String
    public let name: String
    public let os: OsKind
    public let agentVersion: String
    public var hostname: String?
    /// Skill slash-commands this machine can run. Absent on agents older than
    /// the skill bundle — see `SessionCategory.runnable(on:)`, which reads that
    /// as "unknown" rather than "none".
    public var skills: [String]?
    /// Permission modes this machine is willing to run under. Read it through
    /// `offeredPermissionModes` — the raw field is the machine's answer, and its
    /// ABSENCE is "no answer", never "yes to everything".
    public var permissionModes: [PermissionMode]?
    /// Codex has its own capability list; Claude's list cannot authorize it.
    public var codexPermissionModes: [PermissionMode]?
    /// The owner marked this machine private (docs/E2EE.md): its session content
    /// crosses the hub only as ciphertext. Present only as `true`. Read it through
    /// `isPrivate`.
    public var `private`: Bool?
    /// Random per agent process, sent whenever the machine holds a content key:
    /// what a phone seals is good for that one process.
    public var e2eEpoch: String?

    public var id: String { machineId }
    public var isPrivate: Bool { `private` == true }

    /// The modes a picker may offer here, narrowed to the ones this build has a
    /// word for.
    ///
    /// `bypassPermissions` — a session that never stops to ask — is the one mode
    /// whose availability is the MACHINE's call, which is why it is absent from
    /// the base trio and only ever appears because the agent listed it. An agent
    /// too old to publish the field has also never said it withholds anything,
    /// and reading that silence as consent would run a box without approvals on
    /// the strength of a message it never sent. Mirrors the hub's own
    /// `machine_offers_bypass` and the web's `PermissionModePicker`.
    public var offeredPermissionModes: [PermissionMode] {
        offeredPermissionModes(isCodex: false)
    }

    public func offeredPermissionModes(isCodex: Bool) -> [PermissionMode] {
        let offered = isCodex ? codexPermissionModes : permissionModes
        let known = (offered ?? []).filter { $0 != .unknown }
        let fallback: [PermissionMode] = isCodex ? [.default, .plan] : PermissionMode.exposed
        return known.isEmpty ? fallback : known
    }
}

/// A machine's runtimes as the agent reports them (web `RuntimeStatus`). Only
/// what the phone acts on is decoded; the rest of the reading is ignored.
public struct MachineRuntimes: Codable, Hashable, Sendable {
    public struct Claude: Codable, Hashable, Sendable {
        /// 'disabled' = switched off by the owner; other values are problems
        /// to fix on the machine (logged_out, token_expired, …).
        public var error: String?
        public init(error: String? = nil) { self.error = error }
    }
    public var claude: Claude?
    public init(claude: Claude? = nil) { self.claude = claude }
    public var claudeOff: Bool { claude?.error == "disabled" }
}

public struct MachineSnapshot: Codable, Identifiable, Hashable, Sendable {
    public var machine: MachineInfo
    /// Who owns this device, when the workspace knows.
    public var owner: MachineOwner?
    /// Full machine control (terminal, files, processes). Absent on older hubs
    /// => treat as true, matching the web's `canControl !== false`.
    public var canControl: Bool?
    /// May the viewer START sessions here without full control (a control-share
    /// member)? Absent = false.
    public var canStart: Bool?
    /// `"sandbox"` = a hosted box the hub provisioned (Codex through the
    /// gateway, no Claude login of its own). Absent = a personal device.
    public var kind: String?
    /// Does anybody but the owner work here? True once the machine carries at
    /// least one project share.
    ///
    /// `kind` does NOT answer this and must not be used for it: `kind` records
    /// how the device was ENROLLED, and the shared employee sandbox enrolled as
    /// an ordinary personal device — on the live hub it reads `personal` while
    /// carrying nine control-shares.
    public var shared: Bool?
    /// `var`, not wire-mutable: `FleetSnapshotStore` flips it to false when
    /// serving the persisted inventory to a cold-started offline app.
    public var online: Bool
    public let lastSeen: Double
    public var sessions: [SessionSummary]
    /// Provider limits are reported independently by each machine's agent.
    public var usage: UsageInfo? = nil
    public var codexUsage: UsageInfo? = nil
    /// Locally-computed "how you build with AI" profile, if the agent sent one.
    public var profile: BuilderProfile? = nil
    /// Latest hardware/process telemetry sample carried on the snapshot (deltas
    /// keep arriving as `machine_stats` frames).
    public var stats: MachineStats? = nil
    /// What this machine's Claude and Codex ARE. Absent = an agent too old to
    /// say — read as unknown, never as broken.
    public var runtimes: MachineRuntimes? = nil

    public var id: String { machine.machineId }
    /// The owner switched Claude off here (`CC_REMOTE_DISABLE_CLAUDE`): the
    /// machine has no Claude to offer — not in the picker, not in the limits.
    public var claudeOff: Bool { runtimes?.claudeOff == true }

    /// Older hubs omit the flag entirely; absence means "no restriction".
    public var hasControl: Bool { canControl != false }
    /// Can the viewer drive sessions here at all (control OR a control share)?
    public var canDrive: Bool { hasControl || canStart == true }
    /// A hosted sandbox: Codex through the gateway, never the owner's Claude.
    public var isSandbox: Bool { kind == "sandbox" }
    /// The SAME test that gates the start button (web `canStartAnywhere`).
    /// `=== true`, not `!== false`: both fields are optional and the two
    /// readings disagree on an older agent, and a shelf that offers what the
    /// button calls impossible is worse than either answer.
    public var canStartHere: Bool { canControl == true || canStart == true }
}

public struct MachineOwner: Codable, Hashable, Sendable {
    public let userId: String
    public var email: String?
    public var fullName: String?
}

/// Server-owned editorial grouping for the Roadmap and Map boards. The app's
/// fallback intentionally has no product aliases: an older server still shows
/// one lane per project instead of freezing stale editorial policy in a build.
public struct RoadmapConfig: Codable, Hashable, Sendable {
    public struct Group: Codable, Hashable, Sendable {
        public let id: String
        public let name: String
        public let blurb: String
        public let projects: [String]
    }

    public struct Label: Codable, Hashable, Sendable {
        public let name: String
        public let blurb: String
    }

    public let groups: [Group]
    public let unassigned: Label

    public static let fallback = RoadmapConfig(
        groups: [],
        unassigned: Label(name: "Без проекта", blurb: "Сессии без рабочей папки")
    )
}

public struct UsageWindow: Codable, Hashable, Sendable {
    public let utilization: Double
    public var resetsAt: Double?
}

public struct UsageLimit: Codable, Hashable, Sendable, Identifiable {
    public let key: String
    public let label: String
    public var group: String?
    public let percent: Double
    public var resetsAt: Double?
    public var active: Bool?
    public var id: String { key }
}

public struct UsageInfo: Codable, Hashable, Sendable {
    public var limits: [UsageLimit]?
    public var fiveHour: UsageWindow?
    public var sevenDay: UsageWindow?
    public var account: String?
    public var subscription: String?
    public let updatedAt: Double

    public var normalizedLimits: [UsageLimit] {
        if let limits, !limits.isEmpty { return limits }
        var rows: [UsageLimit] = []
        if let fiveHour {
            rows.append(.init(key: "session", label: "Session (5hr)", group: "session",
                              percent: fiveHour.utilization, resetsAt: fiveHour.resetsAt))
        }
        if let sevenDay {
            rows.append(.init(key: "weekly_all", label: "Weekly (7 day)", group: "weekly",
                              percent: sevenDay.utilization, resetsAt: sevenDay.resetsAt))
        }
        return rows
    }
}

public struct ActiveRunInfo: Codable, Identifiable, Hashable, Sendable {
    public let runId: String
    public let machineId: String
    public var machineName: String?
    public let sessionId: String
    public var title: String?
    public var project: String?
    public let state: AttentionState
    public var preview: String?
    public let since: Double
    public var taskStartedAt: Double?
    /// Which cc-remote client opened this run: "app" | "web" | nil (=> treat as web).
    public var origin: String?
    /// Who started this run (hub-injected) — the owner badge and the employee
    /// activity filter. Absent for legacy/unowned runs.
    public var ownerUserId: String?
    public var ownerName: String?
    /// Session category (categories.ts), if the run was started with one.
    public var category: String?
    /// What `needs_attention` means here: "question" — the agent asked
    /// something (AskUserQuestion / ExitPlanMode); "permission" — a tool is
    /// waiting to be allowed to run. The hub raises one state for both, and
    /// calling a permission prompt "ждёт ответа" sends people looking for a
    /// question nobody asked. Absent when nothing is pending, or from a hub
    /// too old to send it.
    public var pendingKind: String?
    /// Tool waiting on a decision, so the label can name it.
    public var pendingTool: String?
    /// Stable request identity survives an agent reconnect and replay.
    public var pendingRequestId: String?

    public var id: String { runId }
    public var categoryInfo: SessionCategory? { category.flatMap(SessionCategory.init(rawValue:)) }

    /// The state, said the way a person reads it. Mirrors `attentionLabel` in
    /// `web/src/lib.ts` — one rule, two clients.
    public var attentionLabel: String {
        switch pendingKind {
        case "question": return "ждёт ответа"
        case "permission": return "ждёт подтверждения"
        default: return "ждёт решения"
        }
    }
}

// MARK: - Chat history (mirror shared/src/rpc.ts)

public enum RenderBlock: Decodable, Hashable, Sendable {
    case text(String)
    case thinking(String)
    case toolUse(id: String, name: String, input: JSONValue)
    case toolResult(toolUseId: String, text: String, isError: Bool)
    /// Bytes are fetched separately through session.image using this opaque ref.
    /// Older agents may send only a marker.
    case image(ref: String?)
    /// A picture the runtime MADE (`generated: true` on the wire; ref `gen:…`),
    /// carried on an assistant message of its own. `prompt` is the generator's
    /// own wording, when known. A generated block without a ref has nothing to
    /// fetch and degrades to the plain `.image` marker, as an old agent's would.
    case generatedImage(ref: String, prompt: String?)
    case unknown

    private enum K: String, CodingKey {
        case kind, text, id, name, input, toolUseId, isError, ref, generated, prompt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        switch kind {
        case "text":
            self = .text((try? c.decode(String.self, forKey: .text)) ?? "")
        case "thinking":
            self = .thinking((try? c.decode(String.self, forKey: .text)) ?? "")
        case "tool_use":
            self = .toolUse(
                id: (try? c.decode(String.self, forKey: .id)) ?? "",
                name: (try? c.decode(String.self, forKey: .name)) ?? "",
                input: (try? c.decode(JSONValue.self, forKey: .input)) ?? .null
            )
        case "tool_result":
            self = .toolResult(
                toolUseId: (try? c.decode(String.self, forKey: .toolUseId)) ?? "",
                text: (try? c.decode(String.self, forKey: .text)) ?? "",
                isError: (try? c.decode(Bool.self, forKey: .isError)) ?? false
            )
        case "image":
            let ref = try? c.decode(String.self, forKey: .ref)
            if (try? c.decode(Bool.self, forKey: .generated)) == true, let ref, !ref.isEmpty {
                let prompt = (try? c.decode(String.self, forKey: .prompt))?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                self = .generatedImage(ref: ref, prompt: prompt?.isEmpty == false ? prompt : nil)
            } else {
                self = .image(ref: ref)
            }
        default:
            self = .unknown
        }
    }
}

public enum MessageRole: String, Codable, Sendable {
    case user, assistant, system, unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MessageRole(rawValue: raw) ?? .unknown
    }
}

public struct HistoryMessage: Decodable, Identifiable, Hashable, Sendable {
    public let role: MessageRole
    public let uuid: String
    public let blocks: [RenderBlock]
    /// When the turn was written, ms since epoch (`HistoryMessageSchema.ts` in
    /// shared/src/rpc.ts). Absent — never null — from agents too old to send it,
    /// and then the reader shows no time rather than an invented one.
    public let ts: Double?

    public var id: String { uuid }
    public var date: Date? { ts.map { Date(timeIntervalSince1970: $0 / 1000) } }
    /// Memberwise construction for render-side regrouping (the custom
    /// `init(from:)` below suppresses the synthesized one).
    public init(role: MessageRole, uuid: String, blocks: [RenderBlock], ts: Double? = nil) {
        self.role = role
        self.uuid = uuid
        self.blocks = blocks
        self.ts = ts
    }
    private enum K: String, CodingKey { case type, uuid, blocks, ts }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        self.role = (try? c.decode(MessageRole.self, forKey: .type)) ?? .unknown
        self.uuid = (try? c.decode(String.self, forKey: .uuid)) ?? UUID().uuidString
        self.blocks = (try? c.decode([RenderBlock].self, forKey: .blocks)) ?? []
        self.ts = (try? c.decodeIfPresent(Double.self, forKey: .ts)) ?? nil
    }
}

public struct StreamUsageData: Decodable, Sendable {
    public let totalTokens: Int?
    public let status: String?
    public let rateLimitType: String?
    public let utilization: Double?
    public let resetsAt: Double?
    /// `session_state`: the CLI's own turn state, `running` or `idle`.
    public let state: String?
    /// `background_tasks`: the FULL current set of the run's background tasks
    /// (an empty list means none are left). Absent on every other code.
    public let tasks: [RunBackgroundTask]?
    /// `subagents`: the FULL current set of the run's sub-agents, a level like
    /// `tasks` (shared/src/subagents.ts). Malformed rows are dropped one by one.
    public let agents: [Subagent]?
    /// `tool_use`: the call's id — what a sub-agent card in the live tail is
    /// anchored on (`Subagent.toolUseId`).
    public let id: String?
    /// `image_gen` (`ImageGenEventData` in shared/src/rpc.ts): `id` and `state`
    /// above, plus epoch-ms `startedAt`, the generator's `prompt`, the `ref` the
    /// picture is fetched by and a failure's `error`. Absent on every other code.
    public let startedAt: Double?
    public let prompt: String?
    public let ref: String?
    public let error: String?

    public init(totalTokens: Int? = nil, status: String? = nil, rateLimitType: String? = nil,
                utilization: Double? = nil, resetsAt: Double? = nil, state: String? = nil,
                tasks: [RunBackgroundTask]? = nil, agents: [Subagent]? = nil, id: String? = nil,
                startedAt: Double? = nil, prompt: String? = nil, ref: String? = nil, error: String? = nil) {
        self.totalTokens = totalTokens
        self.status = status
        self.rateLimitType = rateLimitType
        self.utilization = utilization
        self.resetsAt = resetsAt
        self.state = state
        self.tasks = tasks
        self.agents = agents
        self.id = id
        self.startedAt = startedAt
        self.prompt = prompt
        self.ref = ref
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case totalTokens, status, rateLimitType, utilization, resetsAt, state, tasks, agents, id
        case startedAt, prompt, ref, error
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Optional telemetry must not make the enclosing stream frame fail.
        totalTokens = try? c.decode(Int.self, forKey: .totalTokens)
        status = try? c.decode(String.self, forKey: .status)
        rateLimitType = try? c.decode(String.self, forKey: .rateLimitType)
        utilization = try? c.decode(Double.self, forKey: .utilization)
        resetsAt = try? c.decode(Double.self, forKey: .resetsAt)
        state = try? c.decode(String.self, forKey: .state)
        // Malformed rows drop one by one, as `parseBackgroundTasks` does on web.
        tasks = (try? c.decode([LossyRunBackgroundTask].self, forKey: .tasks))?.compactMap(\.task)
        agents = (try? c.decode([LossySubagent].self, forKey: .agents))
            .map { Array($0.compactMap(\.agent).prefix(Subagent.maxCount)) }
        id = (try? c.decode(String.self, forKey: .id)).flatMap { $0.isEmpty ? nil : $0 }
        startedAt = try? c.decode(Double.self, forKey: .startedAt)
        prompt = (try? c.decode(String.self, forKey: .prompt)).flatMap { $0.isEmpty ? nil : $0 }
        ref = (try? c.decode(String.self, forKey: .ref)).flatMap { $0.isEmpty ? nil : $0 }
        error = (try? c.decode(String.self, forKey: .error)).flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// A task the CLI runs in the background for the followed run — a Bash with
/// `run_in_background`, a backgrounded subagent. Mirrors `RunBackgroundTask` in
/// web/src/sessionChannel.ts; `since` is ms since epoch.
public struct RunBackgroundTask: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let type: String
    public let description: String
    public let since: Double
    /// The sub-agent that started it; absent for the session's own tasks.
    public let owner: String?
    /// That sub-agent's task id: two helpers can share a name.
    public let ownerId: String?

    public init(id: String, type: String = "", description: String = "", since: Double,
                owner: String? = nil, ownerId: String? = nil) {
        self.id = id
        self.type = type
        self.description = description
        self.since = since
        self.owner = owner
        self.ownerId = ownerId
    }

    /// Tasks with this key are one line to a person: same kind, same words,
    /// same owner. Stop takes the whole row, so no key for a sub-agent (even
    /// while its `subagents` entry is missing), a task that says nothing about
    /// itself, or a description the agent may have cut at 200 (usually a long
    /// command) — `backgroundTaskRepeatKey` on web.
    public var repeatKey: String? {
        if type.range(of: "agent", options: .caseInsensitive) != nil || description.utf16.count >= 200 { return nil }
        let d = description.trimmingCharacters(in: .whitespacesAndNewlines)
        return d.isEmpty ? nil : [type, ownerId ?? "", d].joined(separator: "\u{0}")
    }

    /// Shell syntax a sentence written for a person does not carry: a Bash
    /// started without a description arrives with the COMMAND in its place.
    private static let shellSyntax = try! NSRegularExpression(
        pattern: #"\$\(|\$\{|\$[A-Za-z_]|&&|\|\||[;|`<>]|2>&1|\bdo\b[\s\S]*\bdone\b"#)

    /// What «в фоне: …» names the task by: its description when a person could
    /// have written it, otherwise just what kind of thing it is
    /// (`backgroundTaskLabel` on web).
    public var label: String {
        let d = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(d.startIndex..., in: d)
        let sentence = !d.isEmpty && Self.shellSyntax.firstMatch(in: d, range: range) == nil
        if type.range(of: "agent", options: .caseInsensitive) != nil { return sentence ? d : "агент" }
        if d.isEmpty { return "команда" }
        // A command in place of a description is worded like a step («Жду»,
        // «Прогоняю тесты на stage»), not a bare «команда» (31.10.2026); the
        // «Bash · what» reader tells a sentence from `sleep 30` / `npm test`.
        let said = StepText.action("Bash · \(d)").text
        return said == "Выполняю команду" || said == "Запускаю команду" ? "команда" : said
    }
}

private struct LossyRunBackgroundTask: Decodable {
    let task: RunBackgroundTask?
    private enum K: String, CodingKey { case id, type, description, since, owner, ownerId }
    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: K.self),
              let id = try? c.decode(String.self, forKey: .id) else { task = nil; return }
        task = RunBackgroundTask(id: id,
                              type: (try? c.decode(String.self, forKey: .type)) ?? "",
                              description: (try? c.decode(String.self, forKey: .description)) ?? "",
                              since: (try? c.decode(Double.self, forKey: .since)) ?? Date().timeIntervalSince1970 * 1000,
                              owner: (try? c.decode(String.self, forKey: .owner)).flatMap { $0.isEmpty ? nil : $0 },
                              ownerId: (try? c.decode(String.self, forKey: .ownerId)).flatMap { $0.isEmpty ? nil : $0 })
    }
}

public struct StreamEvent: Decodable, Sendable {
    public let kind: StreamKind
    public let text: String?
    public let code: String?

    public let data: StreamUsageData?

    public init(kind: StreamKind, text: String?, code: String? = nil, data: StreamUsageData? = nil) {
        self.kind = kind
        self.text = text
        self.code = code
        self.data = data
    }
}

// MARK: - Models RPC

public struct ModelInfoLite: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String?
    /// Wire model id this row's `id` resolves to ('opus' -> 'claude-opus-5-5').
    /// The run reports the RESOLVED id, so without this a picker cannot tell
    /// which of its own alias rows is the one currently running.
    public var resolved: String?
    /// Efforts this model takes, as the runtime names them. Plain strings on
    /// purpose — the CLI also reports 'max', which is not live-settable.
    public var efforts: [String]?
    /// Explicitly false = the effort control does nothing on this model.
    public var supportsEffort: Bool?

    public init(id: String, name: String? = nil, resolved: String? = nil,
                efforts: [String]? = nil, supportsEffort: Bool? = nil) {
        self.id = id
        self.name = name
        self.resolved = resolved
        self.efforts = efforts
        self.supportsEffort = supportsEffort
    }
}

/// Mirror of `DEFAULT_MODELS` in shared/src/rpc.ts — the fallback shown when a
/// machine's `models.list` is unreachable. Current generation only, ordered
/// most to least capable. Keep the two lists in step; a model bump that lands
/// on one client only is worse than no bump at all.
public let DEFAULT_MODELS: [ModelInfoLite] = [
    .init(id: "claude-fable-5-1", name: "Fable 5.1"),
    .init(id: "claude-opus-5-5", name: "Opus 5.5"),
    .init(id: "claude-sonnet-5-5", name: "Sonnet 5.5"),
]

/// Context budget for a live run. Mirrors the `context_usage` frame; the
/// numbers come from the CLI and are never recomputed here.
/// What a live run is actually set to, as reported by the agent. nil `model` /
/// `effort` = no explicit pick, the account default is running — and
/// `activeModel` is the resolved wire id that names it.
public struct RunSettingsInfo: Codable, Equatable, Sendable {
    public let model: String?
    public let activeModel: String?
    public let effort: EffortLevel?
    public let ultracode: Bool

    public init(model: String?, activeModel: String?, effort: EffortLevel?, ultracode: Bool) {
        self.model = model
        self.activeModel = activeModel
        self.effort = effort
        self.ultracode = ultracode
    }

    /// The picker row this run is on: `.ultracode` outranks a plain effort,
    /// because it IS xhigh plus orchestration rather than a level beside it.
    public var effortChoice: EffortChoice? {
        if ultracode { return .ultracode }
        guard let effort else { return nil }
        return EffortChoice(rawValue: effort.rawValue)
    }
}

public enum ContextCompactionState: Sendable {
    case idle, requested, running, completed, failed
    public var pending: Bool { self == .requested || self == .running }
}

public struct ContextUsageInfo: Equatable, Sendable {
    public let totalTokens: Int
    public let maxTokens: Int
    public let percentage: Double
    public let autoCompactThreshold: Double?
    public let autoCompactEnabled: Bool

    /// Percent at which the runtime compacts on its own — the number that
    /// actually matters, since it differs between runtimes.
    public var tripPercent: Int {
        // A fraction (0.95), a percent, or — on 1M-context models — a token
        // count (967000), which `t * 100` turned into «96700000%».
        guard autoCompactEnabled, let t = autoCompactThreshold, t > 0 else { return 100 }
        let pct: Double
        if t <= 1 { pct = t * 100 } else if t <= 100 { pct = t } else if maxTokens > 0 { pct = t / Double(maxTokens) * 100 } else { pct = 100 }
        return Swift.min(100, Int(pct.rounded()))
    }
    public var isNearLimit: Bool { Int(percentage.rounded()) >= Swift.max(50, tripPercent - 15) }
}

// MARK: - Local (client-only) types

public struct ActiveRun: Equatable, Sendable {
    public var runId: String?
    public let machineId: String
    public let sessionId: String
}

/// A session address with no run attached — used where only "which session on
/// which machine" matters (recovery prompts, stage changes).
public struct SessionRef: Equatable, Sendable {
    public let machineId: String
    public let sessionId: String

    public init(machineId: String, sessionId: String) {
        self.machineId = machineId
        self.sessionId = sessionId
    }
}

public struct TranscriptLine: Identifiable, Equatable, Sendable {
    public let id: Int
    public enum Kind: String { case system, assistant, tool_use, result, status, error, user }
    public let kind: Kind
    public var text: String
    public var streaming: Bool = false
    /// Images the operator attached to this (user) turn — echoed locally so the
    /// chat shows what was sent. Hub confirmations contain only their count.
    public var images: [ImageAttachment] = []
    /// When present, this line renders a full history message (backlog) instead
    /// of raw text — lets scrollback keep block rendering while live lines stay text.
    public var history: HistoryMessage?
    /// Receipt time, ms since epoch. Live `stream` frames carry no timestamp, so
    /// this is when the client first saw the line; the convergence pass replaces
    /// the whole tail with the file's own `ts` once the transcript catches up.
    public var ts: Double? = nil
    public var turnId: String? = nil
    public var truncated: Bool = false
    public var attachedImageCount: Int? = nil
    public var attachmentOnly: Bool = false
    public var files: [String] = []
    /// Status identity is retained independently of its localized wording.
    public var code: String? = nil
    /// A `tool_use` line's call id (the stream event's `data.id`), the anchor
    /// of a sub-agent card in the live tail. Absent from older agents.
    public var toolUseId: String? = nil
    /// A `status` line with `code == "image_gen"`: the live card of one picture
    /// being drawn, upserted by its id (`TranscriptUpdates.imageGen`).
    public var imageGen: ImageGenCard? = nil
    /// An unanswered echo shown after a replay gap; its eventual hub frame
    /// supplies the authoritative position, even if it was confirmed before.
    var replayPending: Bool = false

    public static func attachmentLabel(images: Int, files: [String]) -> String {
        let pictures = images > 0 ? [images == 1 ? "картинка" : "\(images) картинки"] : []
        let names = pictures + files
        return names.isEmpty ? "" : "[\(names.joined(separator: ", "))]"
    }
}

/// A follow-up message queued while a run is busy (flushes on idle).
public struct QueuedMessage: Identifiable, Equatable, Sendable {
    public let id: Int
    public var text: String
    public var images: [ImageAttachment] = []
}

/// An image attached to a user turn (screenshot / photo). `data` is the already
/// downscaled JPEG/PNG bytes; `dataBase64` is what crosses the wire (mirrors
/// `ImageBlock` in shared/src/protocol.ts).
public struct ImageAttachment: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let mediaType: String
    public let data: Data
    public init(id: UUID = UUID(), mediaType: String, data: Data) {
        self.id = id
        self.mediaType = mediaType
        self.data = data
    }
    public var dataBase64: String { data.base64EncodedString() }
}

// `Playbook` lived here: saved prompt chips above the session composer
// ("Тесты", "Коммит", "Ревью diff"). The row was removed in acde81e — screen
// space above a running conversation belongs to the conversation — and the view
// sat unrendered for a month afterwards. Choosing a workflow now happens where
// it belongs, at the START of work: `SessionCategory` above, which resolves to
// a real skill on the machine instead of a canned sentence.

public struct ToolRequest: Identifiable, Equatable, Sendable {
    public let runId: String
    public let requestId: String
    public let tool: String
    public let input: JSONValue
    public var title: String?
    public var id: String { requestId }
    public static func == (a: ToolRequest, b: ToolRequest) -> Bool { a.requestId == b.requestId }
}

public struct NotifItem: Identifiable, Equatable, Sendable {
    public let id: Int
    public let runId: String
    public let machineId: String
    public let sessionId: String
    public let title: String
    public var machineName: String?
    public let state: AttentionState
    public let ts: Date
    /// Carried from the run so the row can say what is pending — a question or
    /// a permission. See `ActiveRunInfo.pendingKind`.
    public var pendingKind: String?
    public var pendingTool: String?
    /// The prompt this entry is about; a different one pending means this one
    /// was answered (or timed out) and the entry has nothing left to say.
    public var pendingRequestId: String? = nil
    /// Hub time (ms since epoch, `ActiveRunInfo.since`) of the run state that
    /// produced this entry. A read mark at or after it means the entry was seen
    /// on another device (`NotificationEngine.dismiss(…upTo:)`).
    public var since: Double? = nil
}

public struct FlashError: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let message: String
}
