import Foundation
import Observation
import os

/// The entire client/backend layer — a direct port of `web/src/useCentral.ts`.
/// One `URLSessionWebSocketTask` to `<hubURL>?token=…`, a reconnect state machine
/// with exponential backoff, a 45s protocol ping, an id-correlated RPC map, and
/// term/mirror registries. Snapshot is authoritative after every (re)connect.
@MainActor
@Observable
public final class CentralClient {
    public enum ConnStatus: Equatable { case connecting, open, closed }

    // MARK: Observable state (mirrors CentralState)
    public private(set) var status: ConnStatus = .closed
    /// The fleet as the UI shows it — scripted runs filtered out unless
    /// `showAutomated`. One choke point, not a filter per screen: the counts,
    /// the project drill, the recents and the palette all have to agree, or
    /// the history says 91 and shows 3 (web `visibleMachines` parity).
    ///
    /// For the `.primary` role this is seeded from disk in `init` so the app
    /// opens onto the whole fleet (offline) instead of an empty list; replaced
    /// wholesale by the first live snapshot. Panes start empty.
    public private(set) var machines: [MachineSnapshot] = []
    /// The unfiltered inventory — persistence and delivery logic read this so
    /// hiding a session from lists never breaks delivering into it.
    public private(set) var allMachines: [MachineSnapshot] = []
    /// Known filtered rows must not be recreated from activity as provisional sessions.
    public private(set) var hiddenAutomatedSessionKeys: Set<String> = []
    /// Why hide at all: the CRM lead-research loop on stage runs every 20
    /// minutes, each run a fresh transcript — ~72 sessions a day, and a
    /// project's history becomes ninety identical rows with the human work
    /// buried underneath.
    public var showAutomated: Bool = UserDefaults.standard.bool(forKey: "showAutomatedSessions") {
        didSet {
            UserDefaults.standard.set(showAutomated, forKey: "showAutomatedSessions")
            applyMachines(allMachines)
        }
    }
    /// How many sessions the automated filter is holding back right now.
    public var automatedHidden: Int {
        hiddenAutomatedSessionKeys.count
    }
    /// Who the hub says we are, and the workspaces available to us. Nil until the
    /// first snapshot (or on hubs that predate workspaces).
    public private(set) var viewer: ViewerContext?
    /// Кто смотрел снимок флота, сохранённый на диске этого аккаунта. Только
    /// для показа кэша до ответа хаба — права, команды и сброс аккаунта
    /// по-прежнему решает проверенный `viewer` из снапшота.
    public private(set) var cachedViewerId: String?
    /// Списки сейчас из кэша на диске, а не от хаба (до первого снапшота).
    public private(set) var fleetIsCached = false
    /// Чей это экран для фильтра «мои»: проверенный хабом, иначе из кэша.
    public var effectiveViewerId: String? { viewer?.userId ?? cachedViewerId }
    public private(set) var activeRuns: [ActiveRunInfo] = [] {
        didSet { e2eeRunIndex = Dictionary(activeRuns.map { ($0.runId, $0.machineId) }, uniquingKeysWith: { a, _ in a }) }
    }
    public private(set) var roadmapConfig = RoadmapConfig.fallback
    /// Latest hardware sample per machine (30s cadence, pushed by agents).
    public private(set) var machineStats: [String: MachineStats] = [:]
    /// Builder profile per machine — seeded from the snapshot, refreshed by
    /// `builder_profile` deltas.
    public private(set) var profiles: [String: BuilderProfile] = [:]
    /// `machineId::sessionId` of sessions whose work has been committed — the
    /// Flow board offers to close those.
    public private(set) var committed: Set<String> = []
    /// Shared Codex subscription quota (one figure for the whole team). It lives
    /// behind an HTTP endpoint, not the socket, so it is polled separately.
    public private(set) var gatewayUsage: UsageInfo?
    public private(set) var budgetUsage: UsageInfo?
    public private(set) var rateLimitNotices = RateLimitNotices()

    private let rest = RestClient()
    /// The hub's REST side, configured by `connect()` alongside the socket.
    /// Exposed read-only so feature code (team management, quotas) can call it
    /// without owning a second, unconfigured client.
    public var api: RestClient { rest }
    /// Workspace management (members, invites, shares, audit, devices) over the
    /// same configured REST client.
    @ObservationIgnored public private(set) lazy var team = TeamApi(rest: rest)
    private var quotaTask: Task<Void, Never>?
    public private(set) var lines: [TranscriptLine] = [] {
        // Any direct write replaces the list a pending replay was built on
        // (a focus switch, a reset): that replay no longer belongs on screen.
        didSet {
            if replayStage != nil { replayStage = nil; replayCommit?.cancel() }
            if lines.isEmpty { hasCurrentAssistantLines = false }
        }
    }
    /// Retained pre-gap prose is readable, but cannot confirm a newly idle turn.
    public private(set) var hasCurrentAssistantLines = false
    /// The turn a (re)subscribe replays, assembled off screen. The hub sends it
    /// as up to 400 separate frames (`backlog`, server-rs/src/hub.rs) and the
    /// receive loop yields between frames, so applying them to `lines` one by
    /// one redrew the transcript per frame: the reply "retyped itself", the
    /// ⚙ counter climbed again from 1, and the constant height changes left the
    /// session open mid-scroll instead of at the bottom. It is published in one
    /// write at the first quiet gap, or after `replayMaxHold` at the latest.
    ///
    /// A hub that says how many frames follow (`opened.backlog`) is waited out
    /// to the last one instead: a long turn's backlog is up to 256 KB, and over
    /// a radio — with the main actor busy laying out the history opening at the
    /// same time — it outran both timers, so everything after them was again
    /// written frame by frame (23.11.2026).
    private struct ReplayStage {
        let runId: String
        var lines: [TranscriptLine]
        var echoes: [TranscriptLine]
        var pendingEchoIDs: Set<Int>
        let started: Date
        /// Replay frames the hub announced (`stream` and `user_turn`); nil
        /// from a hub that does not count.
        var expected: Int? = nil
        /// Replay frames of this run handled since the stage opened.
        var received = 0
        /// When the last of them came. The stall is measured from here, not
        /// from the last frame of any kind: a terminal, a mirror or the fleet
        /// keep the socket busy and would push a stall back for good.
        var lastProgress = Date()
    }
    @ObservationIgnored private var replayStage: ReplayStage?
    /// The live lines of sessions left in the middle of a turn, by
    /// `machineId::sessionId`. Coming back used to start the turn from an empty
    /// screen: the card counted the steps of the old disk copy, then of the
    /// replay, and the turn's steps were rebuilt in front of you (24.10.2026).
    /// Brought back only to the same run while it is still mid-turn — exactly
    /// the lines a reconnect keeps; the replay that follows replaces them.
    private struct ParkedLines {
        let runId: String
        /// The turn they belong to (`taskStartedAt ?? since`): a run outlives
        /// its turns, and the next one must not get this one's lines.
        let phase: Double?
        let lines: [TranscriptLine]
    }
    @ObservationIgnored private var parkedLines: [String: ParkedLines] = [:]
    @ObservationIgnored private var parkedOrder: [String] = []
    static let parkedCapacity = 4
    @ObservationIgnored private var replayCommit: Task<Void, Never>?
    static let replayQuietGap: TimeInterval = 0.08
    static let replayMaxHold: TimeInterval = 0.5
    /// With a counted backlog: no frame for this long means one was lost on
    /// the way (undecodable, or sealed and unreadable) — publish what came.
    static let replayStallGap: TimeInterval = 1.5
    public private(set) var active: ActiveRun? {
        didSet {
            if let change = modelChange,
               active?.machineId != change.machineId || active?.sessionId != change.sessionId
                || (change.runId != nil && active?.runId != change.runId) {
                finishModelChange()
            }
            let bindsPendingRun = oldValue != nil && oldValue?.runId == nil &&
                oldValue?.machineId == active?.machineId && oldValue?.sessionId == active?.sessionId
            let sameRun = oldValue?.runId != nil && oldValue?.runId == active?.runId
            if oldValue != active && !bindsPendingRun && !sameRun {
                turnProgress = nil
            }
            if oldValue?.runId != active?.runId {
                background = []
                turnIdle = false
                hasCurrentAssistantLines = false
                permissionMode = nil
                contextUsage = nil
                resetCompaction()
                runSettings = nil
                if active?.runId == nil { activeState = nil }
            }
        }
    }
    public private(set) var busy = false {
        didSet {
            if busy && turnProgress == nil { turnProgress = TurnProgress() }
            if !busy { turnProgress = nil }
        }
    }
    public private(set) var turnProgress: TurnProgress?
    /// What the followed run still runs in the background — a long Bash, a
    /// backgrounded subagent. The agent withholds the turn's `result` while one
    /// lives, so `busy` stays true; this is what the view names instead of a
    /// bare «работает…» (web 2fcb085, «в фоне: … · m:ss»).
    public private(set) var background: [RunBackgroundTask] = []
    /// The followed run's sub-agents — the agent's `subagents` level, kept with
    /// the run it came from so another run's set never shows (web `subagentsOf`).
    private var subagentsOf: (runId: String, agents: [Subagent])?
    /// The cards' live facts and the panel's sub-agent rows (shared/src/subagents.ts).
    public var subagents: [Subagent] {
        guard let level = subagentsOf, level.runId == active?.runId else { return [] }
        return level.agents
    }
    /// The CLI reported `idle`: the TURN is over even though the JOB (a
    /// background task) is not. `running` — the CLI waking on its task — and
    /// any new turn clear it.
    public private(set) var turnIdle = false
    /// A (re)subscribe replays the run's current state, a non-empty task list
    /// included. What it cannot replay is the EMPTY list sent while this client
    /// was away — so the set the client still holds may name tasks that already
    /// finished, and would show «в фоне» and hold back completion for good.
    private func forgetBackground() {
        background = []
        // The hub replays the latest sub-agent level on subscribe; what it
        // cannot replay is one that changed while this client was away.
        subagentsOf = nil
        turnIdle = false
    }
    /// Show «в фоне: …» rather than «работает…»: a task lives and the turn
    /// itself is over (the CLI said `idle`, or the turn's `result` came).
    public var waitingOnBackground: Bool { !background.isEmpty && (turnIdle || !busy) }
    /// Attention state of the focused run, mirrored from the activity feed.
    /// `.error` means the run is finished but still holds the hub's single-writer
    /// lock — the UI offers "close it" rather than a composer that would send
    /// input into a dead runtime.
    public private(set) var activeState: AttentionState?
    /// Set when the hub refuses `open` because the session still carries a run
    /// this client has no runId for (classically one left in `error`). Without a
    /// surfaced exit the session is unusable until someone opens the web UI, so
    /// the chat turns this into a "close the run and continue" action.
    public private(set) var blockedSession: SessionRef?
    public private(set) var toolReq: ToolRequest?
    /// Server-authoritative mode for the focused run; nil until the agent reports it.
    public private(set) var permissionMode: PermissionMode?
    /// Server-authoritative model / reasoning settings for the focused run; nil
    /// until the agent reports them. The pickers follow this rather than their
    /// own last write, which said "default" for a run that was on something else.
    public private(set) var runSettings: RunSettingsInfo?
    public private(set) var sessionSettings = SessionSettingsStore()
    private struct ModelChange {
        let id = UUID()
        let machineId: String
        let sessionId: String
        let model: String?
        var runId: String?
    }
    private var modelChange: ModelChange?
    private var modelChangeTimeout: Task<Void, Never>?
    public var isChangingModel: Bool { modelChange != nil }
    /// Focused run's context budget, or nil until it reports (older runtimes
    /// never do). Drives the composer indicator and the compact prompt.
    public private(set) var contextUsage: ContextUsageInfo?
    public private(set) var compactionState: ContextCompactionState = .idle
    private var compactionTimeout: Task<Void, Never>?
    /// Follow-up messages typed while the run is busy. They flush one-by-one when
    /// the run goes idle, so you can queue next steps without babysitting the turn.
    public private(set) var outbox: [QueuedMessage] = []
    /// Messages sent while the hub or the machine was unreachable. Persisted on
    /// disk (see `OfflineOutboxStore`) and delivered by `flushPending()` once the
    /// connection returns. Ordered — FIFO per session. `.primary` only — panes
    /// neither load nor flush it (N panes would each redeliver the queue).
    public var pending: [PendingMessage] { durableOutbox?.messages ?? [] }
    public private(set) var lastError: FlashError?
    /// Two failed handshakes with no frame received => probably a bad token/URL.
    public private(set) var authWarning = false

    /// Bumped on the first connect, and afterwards ONLY when a gap in the
    /// connection turns out to have cost us something — see `focusedRunSignature`.
    /// Views key their `.task` on it, so a bump means "re-read the transcript":
    /// worth it when a turn ran while the app was suspended, pure churn when the
    /// session sat still and the only thing that changed was the socket.
    public private(set) var connectionEpoch = 0
    /// Bumped each time `resume` is sent on a socket that stayed open through a
    /// background stint. While paused the hub DROPS `mirror_data` (and every other
    /// fan-out) for this socket, so a live subscription that spans the pause has a hole
    /// in it that no later frame fills. Subscriptions that are not re-sent by the
    /// snapshot (the mirror) key on this to reopen — the replacement-socket path needs
    /// no such counter, because it already closes every subscription.
    public private(set) var resumeCount = 0
    /// Bumped when a socket delivers its first frame, FIRST connect and replacements
    /// alike (unlike `connectionEpoch`, which skips replacements to spare the open chat a
    /// re-read). For caches that cannot tell a new socket from the old one by `status`
    /// alone, e.g. a reconnect that SwiftUI never observed as `.closed`.
    public private(set) var socketGeneration = 0

    public let notifs = NotificationEngine()
    public private(set) var completionReads = SessionCompletionReads()
    /// Read marks that arrived before the first snapshot told us whose they are
    /// (and so which account's store keeps them).
    private var earlyReads: [SessionRead] = []
    private var earlyCompletions: [SessionCompletion] = []
    /// Per session key: when we last told the hub «seen», and the retry for a
    /// mark held back by the 10 s throttle.
    private var readSentAt: [String: Date] = [:]
    private var readRetry: [String: Task<Void, Never>] = [:]
    private static let readThrottle: TimeInterval = 10

    /// Every transcript this phone has read, kept on disk (see `TranscriptCache`).
    public private(set) var navigationTitles = NavigationTitles()
    public private(set) var transcripts: TranscriptCache
    public private(set) var accountGeneration = 0
    public private(set) var storageScope: String = "signed-out"
    public var requiresAIConsent = false
    public private(set) var aiDataSharingAllowed = false
    public var aiConsentRequested = false

    public func acceptAIDataSharing() throws {
        guard viewer != nil, storageScope.hasPrefix("account-") else { throw ClientError.connectionClosed }
        try AIDataConsent.save(directory: storage.directory(storageScope))
        aiDataSharingAllowed = true
        aiConsentRequested = false
        // Do not auto-submit a draft or old queued message upon agreement.
    }

    public func withdrawAIDataSharing() throws {
        try AIDataConsent.remove(directory: storage.directory(storageScope))
        aiDataSharingAllowed = false
    }

    private var canUseAI: Bool { !requiresAIConsent || aiDataSharingAllowed }
    /// Whether text may go to the hub's LLM passes (polish, enrichment) —
    /// the same gate the work-driving messages pass.
    public var aiAllowed: Bool { canUseAI }

    private let storage: ClientStorage
    private var durableOutbox: PersistentOutbox?
    private var accountOutboxes: [String: PersistentOutbox] = [:]
    private var accountFleets: [String: FleetSnapshotStore] = [:]
    private var fleetStore: FleetSnapshotStore?
    /// How far the background sweep has got, for Settings. `total` is the number of
    /// sessions that actually need fetching, not the size of the fleet.
    public private(set) var prefetchDone = 0
    public private(set) var prefetchTotal = 0
    public var prefetching: Bool { prefetchTotal > 0 && prefetchDone < prefetchTotal }

    // MARK: Private machines (docs/E2EE.md). The logic is in CentralClient+E2ee.swift;
    // the state lives here because an extension cannot hold stored properties.
    /// This phone's keys for private machines. Shared by every client in the process.
    @ObservationIgnored let keyRing: E2eeKeyRing
    /// Bumped when a key is added or forgotten: what views that show a lock read.
    public private(set) var e2eeRevision = 0
    /// Set to ask the app to show the pairing sheet (a locked session, the machine card).
    public var pairRequest: PairRequest?
    /// run -> machine, learned ONLY from what this phone itself opened. A hub that
    /// says a run lives elsewhere does not get to move it.
    @ObservationIgnored var e2eeRunMachine: [String: String] = [:]
    @ObservationIgnored var e2eeRunIndex: [String: String] = [:]
    @ObservationIgnored var e2eeRpcMachine: [String: String] = [:]
    @ObservationIgnored var e2eeTermMachine: [String: String] = [:]
    @ObservationIgnored var e2eeMirrorMachine: [String: String] = [:]
    @ObservationIgnored var e2eeRpcMethod: [String: String] = [:]
    /// Machines already purged from disk this launch (see `purgePrivateTraces`).
    @ObservationIgnored var e2eePurged: Set<String> = []
    /// Machines whose current envelopes name a key this phone does not hold (after a
    /// rotation): the session is locked until the new code is paired.
    public internal(set) var e2eeStale: Set<String> = []
    /// Sends to a private machine that did not go out. Kept in memory only (never the
    /// disk outbox) so the text comes back to the composer.
    public internal(set) var failedPrivate: [FailedPrivateSend] = []

    func e2eeKeysChanged() { e2eeRevision += 1 }

    // MARK: Internals
    @ObservationIgnored private let socketFactory: SocketFactory
    @ObservationIgnored private let pushDecisions: PushDecisionSender
    @ObservationIgnored private let decodeFrame: (String) async -> HubMessage?

    /// Host-supplied "keep me alive" assertion; see `BackgroundGrace`. iOS passes a
    /// `UIApplication`-backed one, macOS keeps the no-op.
    @ObservationIgnored private let grace: BackgroundGrace
    /// Fired when the hub asks for a tool decision, so the host can nudge the user
    /// (haptics on iOS). The socket itself must not know what feedback means here.
    @ObservationIgnored public var onToolRequest: (() -> Void)?

    /// What this client instance is FOR. `.primary` is the app's one main
    /// connection: it owns the on-disk stores (fleet snapshot, offline outbox,
    /// transcript prefetch), quota polling and push registration. `.pane` is a
    /// scoped per-view connection (the Columns split): same protocol, but every
    /// shared-resource side effect is gated off — five panes writing one outbox
    /// file or redelivering the same queued messages is corruption, not zeal.
    public enum ClientRole: Sendable { case primary, pane }
    @ObservationIgnored public let role: ClientRole

    public convenience init(grace: BackgroundGrace = NoBackgroundGrace(), role: ClientRole = .primary) {
        self.init(grace: grace, role: role, socketFactory: URLSessionSocket.init,
                  decodeFrame: CentralClient.decode)
    }

    init(grace: BackgroundGrace = NoBackgroundGrace(), role: ClientRole = .primary,
         storageRoot: URL = ClientStorage.applicationSupport,
         keyRing: E2eeKeyRing = .shared,
         socketFactory: @escaping SocketFactory,
         decodeFrame: @escaping (String) async -> HubMessage? = CentralClient.decode) {
        self.keyRing = keyRing
        storage = ClientStorage(root: storageRoot)
        transcripts = TranscriptCache(directory: ClientStorage(root: storageRoot).directory("signed-out"))
        self.socketFactory = socketFactory
        pushDecisions = PushDecisionSender(factory: socketFactory, grace: grace)
        self.decodeFrame = decodeFrame
        self.grace = grace
        self.role = role

    }
    private var task: (any WebSocketConnection)?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    /// Fires when a keepalive ping goes unanswered (see `keepalive`).
    private var pongWatch: Task<Void, Never>?
    /// How many screens want hardware telemetry, and what the hub was last told
    /// on THIS socket (see `setStatsInterest`).
    private var statsInterestCount = 0
    private var statsInterestSent = false
    private var reconnectTask: Task<Void, Never>?
    private var errClearTask: Task<Void, Never>?
    /// Watchdog for the on-activate liveness probe (see `probeSocket`).
    private var probeTask: Task<Void, Never>?
    /// Host assertion held across `appWillBackground` (see `beginBackgroundGrace`).
    private var backgroundGrace: Int?
    private var graceTask: Task<Void, Never>?
    /// Closes the post-reconnect catch-up question (see `resolveCatchUp`).
    private var catchUpWindow: Task<Void, Never>?
    /// The background transcript sweep (see `prefetchTranscripts`).
    private var prefetchTask: Task<Void, Never>?
    private var prefetchRunning = false
    private var prefetchGeneration = 0
    private var lastSweepAt: Date?
    /// When each session was last fetched by the sweep (in memory, per account:
    /// `stopPrefetch` clears it). The cache index only knows the session mtime.
    private var prefetchedAt: [String: Date] = [:]
    /// Snapshots arrive every few seconds; the disk copy for offline cold starts
    /// only needs to be roughly current.
    private var lastFleetSaveAt: Date?
    @ObservationIgnored private var fleetSaveCatchUp: Task<Void, Never>?
    @ObservationIgnored private var backgroundedAt: Date?

    private var epoch = 0
    private var retry = 0
    private var gotFrameThisConnect = false
    private var failedHandshakes = 0
    private var stopped = false
    /// Fires if the WebSocket never completes its protocol handshake. Without it a
    /// connection that stalls on a waking network parks the client in
    /// `.connecting` forever: the ping loop skips every tick while not `.open`,
    /// and `isStale` requires `.open` too — so nothing recovers until the user
    /// backgrounds the app again.
    ///
    /// It is armed against the HTTP 101 (see `SocketObserver`), NOT against the
    /// first application frame. The hub's opening snapshot is megabytes on a real
    /// fleet and `receive()` only returns once a whole message has arrived —
    /// timing that out tore down a perfectly healthy socket mid-download and
    /// looped forever, which looked exactly like "nothing loads".
    private var handshakeTask: Task<Void, Never>?
    private static let handshakeTimeout: TimeInterval = 10
    /// A subscription belongs to one socket, while `active.runId` survives
    /// reconnects. The fresh socket must explicitly attach to the hub fanout.
    private var attachedRunId: String?

    /// Wall-clock of the last sign of life (inbound frame OR a WebSocket pong).
    /// iOS can suspend a backgrounded socket WITHOUT surfacing an error, leaving
    /// `status == .open` over a dead pipe; the gap here is how we detect that on
    /// return to foreground. NOTE: liveness is refreshed by protocol-level pongs
    /// (see `keepalive()`), NOT by app frames — the hub is silent when idle, so a
    /// long quiet stretch is normal, not a dead socket.
    private var lastFrameAt = Date()
    /// Focused run's identity+progress as of the moment we backgrounded. On
    /// return it answers the only question that matters: did anything actually
    /// happen while the hub was paused at us? If not, there is nothing to catch
    /// up and re-reading the transcript is pure churn the user sees as "the
    /// history reloads every time I switch apps".
    private var pausedRunSignature: String?
    /// Set when a foreground probe succeeded; cleared by the first snapshot or
    /// activity frame that follows, which is what decides whether the focused
    /// chat needs to re-read at all.
    public private(set) var pendingCatchUp = false
    /// False only for the very first socket of an explicit `connect()`. Every
    /// socket after that is a REPLACEMENT for one we lost — the session on screen
    /// is the same session, so bumping `connectionEpoch` on sight (which is what
    /// re-reads the whole transcript and yanks the scroll to the bottom) is wrong
    /// unless the run actually moved. iOS kills a suspended app's socket routinely,
    /// so this is the difference between "switched apps" and "the chat reloaded
    /// from scratch".
    private var reconnecting = false
    /// Longer than `pingInterval`, or an idle healthy socket would read as stale
    /// between two pings (a stale socket is probed on every foreground).
    private let staleAfter: TimeInterval = 70

    private var url: URL?
    /// Kept so a workspace switch can rebuild the same connection.
    private var endpoint = ""
    private var token = ""
    public private(set) var workspaceId: String?
    private var idCounter = 0
    private func nextId() -> Int { idCounter += 1; return idCounter }

    /// APNs device token — re-sent on every connect (tokens rotate; hub map is
    /// in memory), so notifications survive a hub restart within one app launch.
    private var pushToken: String?

    private let pendingRpc = PendingRegistry<JSONValue, Void>()
    private let memoryLists = PendingRegistry<[MemoryEntry], Void>()
    private let memoryReads = PendingRegistry<String, Void>()
    private let memoryDeletes = PendingRegistry<Void, Void>()
    /// 35s, not the default 30: the hub itself waits up to 30s on its LLM
    /// gateway, and a client timeout that fires first would drop a real answer.
    private let enrichRequests = PendingRegistry<EnrichReply, Void>(timeoutSeconds: 35)
    /// "enrichment not configured" is terminal for a hub: once seen, every
    /// further request would be the same no. Reset only by an explicit
    /// `connect` (a different hub may be configured), never by a reconnect.
    private var enrichUnavailable = false
    /// What the hub said to one `enrich_request`. `notConfigured` must not
    /// collapse into `result(nil)`: the first means "ask nobody, use the
    /// heuristic", the second "the model looked and found nothing".
    private enum EnrichReply { case result(Enrichment?), notConfigured }

    public struct TermSub { let onData: (String) -> Void; let onExit: (Int?) -> Void }
    public struct MirrorSub { let sink: (Bool, [HistoryMessage]) -> Void; let onExit: (() -> Void)? }
    private var termSubs: [String: TermSub] = [:]
    private var mirrorSubs: [String: MirrorSub] = [:]
    private let termOpens = PendingRegistry<TerminalHandle, TerminalHandle>()
    private let mirrorOpens = PendingRegistry<MirrorHandle, MirrorHandle>()

    private let log = Logger(subsystem: "net.hegai.ccremote", category: "central")

    // MARK: Lifecycle

    /// (Re)point the client at a hub. Tears down any existing connection and
    /// starts fresh. `endpoint` is the full ws URL including path (no query).
    public func connect(endpoint: String, token: String, workspaceId: String? = nil) {
        let scope = storage.scope(endpoint: endpoint, token: token, workspace: workspaceId)
        let changed = self.endpoint != endpoint || self.token != token || self.workspaceId != workspaceId
        if changed {
            // Initial launch may already have applied CC_SCREEN/deep links.
            // Only replacing an existing account invalidates that navigation.
            if !self.endpoint.isEmpty { accountGeneration += 1 }
            stopPrefetch()
            quotaTask?.cancel(); quotaTask = nil
            lastQuotaAt = nil
            rest.configure(hubURL: "", token: "")
            resetAccountState()
        }
        reconnectTask?.cancel(); reconnectTask = nil
        stopped = false
        // An explicit connect (launch, hub/token edit, workspace switch) really is
        // a new world: the first frame must bump the epoch so the open chat loads.
        reconnecting = false
        pendingCatchUp = false
        pausedRunSignature = nil
        catchUpWindow?.cancel(); catchUpWindow = nil
        enrichUnavailable = false
        teardownSocket()
        self.endpoint = endpoint
        self.token = token
        self.workspaceId = workspaceId
        activateStorage(scope)
        var comps = URLComponents(string: endpoint)
        var query = [URLQueryItem(name: "token", value: token)]
        // The hub scopes the whole snapshot (machines, sessions, viewer) to this
        // workspace; switching is a reconnect, exactly as on the web.
        if let workspaceId, !workspaceId.isEmpty {
            query.append(URLQueryItem(name: "workspaceId", value: workspaceId))
        }
        comps?.queryItems = query
        guard let u = comps?.url, ["ws", "wss"].contains(u.scheme ?? ""),
              u.host != nil, !token.isEmpty else {
            url = nil
            flashError("Invalid hub URL.")
            status = .closed
            return
        }
        url = u
        rest.configure(hubURL: endpoint, token: token)
        startQuotaPolling()
        openSocket()
    }

    /// The gateway quota refreshes upstream every five minutes, so polling faster
    /// only buys radio wake-ups. Between polls the figure is refreshed on demand
    /// (`refreshQuota()`, e.g. when the limits sheet opens) and on every return to
    /// the foreground; nothing runs while the app is in the background.
    static let quotaInterval: TimeInterval = 300
    /// Two refreshes closer than this collapse into one (app-switch storms).
    private static let quotaMinGap: TimeInterval = 30
    private var lastQuotaAt: Date?

    private func startQuotaPolling() {
        guard role == .primary, backgroundedAt == nil else { return }
        quotaTask?.cancel()
        quotaTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if let last = self.lastQuotaAt {
                    let wait = Self.quotaMinGap - Date().timeIntervalSince(last)
                    if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                    guard !Task.isCancelled else { return }
                }
                async let gateway = self.rest.gatewayQuota()
                async let budget = try? self.rest.get("api/budget", as: BudgetInfo.self)
                let (usage, personal) = await (gateway, budget)
                guard !Task.isCancelled else { return }
                self.lastQuotaAt = Date()
                if self.gatewayUsage != usage { self.gatewayUsage = usage }
                let asUsage = personal?.asUsage
                if self.budgetUsage != asUsage { self.budgetUsage = asUsage }
                try? await Task.sleep(for: .seconds(Self.quotaInterval))
            }
        }
    }

    /// Refresh the gateway quota and personal budget now (collapsed with a
    /// refresh that ran in the last 30 s) and restart the 5-minute cadence from
    /// here. For a screen that is about to show the figures. No-op while the app
    /// is in the background or signed out.
    public func refreshQuota() {
        guard role == .primary, url != nil, !stopped, backgroundedAt == nil else { return }
        startQuotaPolling()
    }

    /// The one place the inventory lands: raw goes to `allMachines`, the
    /// filtered view to `machines`. Everything the UI reads flows through here.
    /// Titles are cleaned once, on the way in, exactly like the web's central
    /// reducer — every list, card and header then shows a plain label instead of
    /// the first line of injected markdown. Shared by the snapshot and the
    /// per-machine delta so one path can never forget it.
    private static func withCleanTitles(_ snap: MachineSnapshot) -> MachineSnapshot {
        var s = snap
        s.sessions = s.sessions.map { session in
            var x = session
            x.title = cleanTitle(x.title)
            return x
        }
        return s
    }

    private func applyMachines(_ raw: [MachineSnapshot]) {
        // First sight of a private flag (a whole snapshot, too): purge what the phone cached
        // for sessions it knew AND for those the snapshot brings.
        for snap in raw where snap.machine.isPrivate { purgePrivateTraces(snap.machine.machineId, incoming: snap.sessions) }
        allMachines = raw
        var hidden = Set<String>()
        machines = showAutomated ? raw : raw.map { visibleSnapshot($0, fresh: nil, hidden: &hidden) }
        hiddenAutomatedSessionKeys = hidden
    }

    /// One machine as the UI shows it: scripted sessions filtered out. `fresh`
    /// names the sessions whose fields just changed — only those are judged
    /// (`isAutomated` is a handful of string scans per session, ×1000 sessions ×
    /// every patch frame was the cost); the rest keep the verdict the last pass
    /// recorded in `hiddenAutomatedSessionKeys`. `nil` judges every session.
    private func visibleSnapshot(_ snap: MachineSnapshot, fresh: Set<String>?,
                                 hidden: inout Set<String>) -> MachineSnapshot {
        let machineId = snap.machine.machineId
        var kept: [SessionSummary] = []
        kept.reserveCapacity(snap.sessions.count)
        for session in snap.sessions {
            let key = "\(machineId)::\(session.sessionId)"
            let automated: Bool
            if let fresh, !fresh.contains(session.sessionId) {
                automated = hiddenAutomatedSessionKeys.contains(key)
            } else {
                automated = session.isAutomated
            }
            if automated { hidden.insert(key) } else { kept.append(session) }
        }
        guard kept.count != snap.sessions.count else { return snap }
        var s = snap
        s.sessions = kept
        return s
    }

    /// One machine's entry lands in both copies of the inventory, the others stay
    /// as they are (a patch for machine A used to re-filter machines B…Z too).
    /// See `visibleSnapshot` for `fresh`.
    private func applyMachine(_ snap: MachineSnapshot, fresh: Set<String>?) {
        let id = snap.machine.machineId
        if snap.machine.isPrivate { purgePrivateTraces(id, incoming: snap.sessions) }
        if let i = allMachines.firstIndex(where: { $0.machine.machineId == id }) {
            allMachines[i] = snap
        } else {
            allMachines.append(snap)
        }
        var shown = snap
        if !showAutomated {
            var hidden = hiddenAutomatedSessionKeys.filter { !$0.hasPrefix(id + "::") }
            shown = visibleSnapshot(snap, fresh: fresh, hidden: &hidden)
            hiddenAutomatedSessionKeys = hidden
        }
        if let i = machines.firstIndex(where: { $0.machine.machineId == id }) {
            machines[i] = shown
        } else {
            machines.append(shown)
        }
    }

    /// In-place field update, applied to BOTH copies of the inventory — and only
    /// when the value really changed: an `@Observable` setter notifies for an
    /// equal value too, and `usage` / `codex_usage` frames repeat unchanged.
    private func updateMachine(_ machineId: String, _ mutate: (inout MachineSnapshot) -> Void) {
        if let i = allMachines.firstIndex(where: { $0.machine.machineId == machineId }) {
            var copy = allMachines[i]
            mutate(&copy)
            if copy != allMachines[i] { allMachines[i] = copy }
        }
        if let i = machines.firstIndex(where: { $0.machine.machineId == machineId }) {
            var copy = machines[i]
            mutate(&copy)
            if copy != machines[i] { machines[i] = copy }
        }
    }

    /// Same-value writes to `machineStats` / `profiles` would invalidate every
    /// reader of the whole dictionary. A sample whose readings equal the last
    /// one (the timestamp aside) is not news.
    private func setStats(_ stats: MachineStats, for machineId: String) {
        if let old = machineStats[machineId], old.sameReading(as: stats) { return }
        machineStats[machineId] = stats
    }

    private func setProfile(_ profile: BuilderProfile, for machineId: String) {
        if profiles[machineId] != profile { profiles[machineId] = profile }
    }

    /// `cleanTitle` is four regex passes; an activity frame carries every run of
    /// the fleet and repeats the same titles. Bounded memo by raw string.
    @ObservationIgnored private var cleanTitleMemo: [String: String] = [:]
    private func cleanedTitle(_ raw: String) -> String {
        if let hit = cleanTitleMemo[raw] { return hit }
        if cleanTitleMemo.count >= 512 { cleanTitleMemo.removeAll(keepingCapacity: true) }
        let cleaned = cleanTitle(raw)
        cleanTitleMemo[raw] = cleaned
        return cleaned
    }

    /// Switch the active workspace: the hub decides visibility per socket, so
    /// this is a reconnect with a different scope rather than a filter.
    public func switchWorkspace(_ id: String) {
        guard id != workspaceId, !endpoint.isEmpty, !token.isEmpty else { return }
        connect(endpoint: endpoint, token: token, workspaceId: id)
    }

    /// Sign out: forget this session HERE at once, and end it ON THE HUB
    /// (`POST /api/logout` with its bearer) — it used to live on for 90 days.
    /// The token is captured before the disconnect and revoked by its own
    /// one-off client, so a sign-in that follows immediately can never have
    /// ITS session revoked by this one's late request. `false` when the hub
    /// did not confirm.
    @discardableResult
    public func signOutEverywhere() async -> Bool {
        await signOut().value
    }

    /// The synchronous half, for a button: the session is captured and the
    /// connection dropped THIS instant, before the caller clears its settings
    /// — nothing that happens afterwards can change which token is revoked.
    /// The hub is told on the returned task.
    @discardableResult
    public func signOut() -> Task<Bool, Never> {
        let endpoint = endpoint
        let token = token
        disconnect()
        return Task { await Self.revoke(endpoint: endpoint, token: token) }
    }

    /// End a session this client is NOT holding — one minted for a hub the app
    /// has since moved away from (a sign-in that finished after a hub switch).
    @discardableResult
    public static func revoke(session token: String, at endpoint: String) -> Task<Bool, Never> {
        Task { await revoke(endpoint: endpoint, token: token) }
    }

    /// End the CURRENT session on the hub without touching the connection —
    /// for «Это не я», which must keep the way out on screen if this fails.
    public func revokeSession() async -> Bool {
        await Self.revoke(endpoint: endpoint, token: token)
    }

    /// `true` only when the hub CONFIRMS it revoked the session
    /// (`{"revoked": true}`): a hub from before bearer sign-out answered 204
    /// and deleted nothing, and «вы вышли» must not be said on that.
    private static func revoke(endpoint: String, token: String) async -> Bool {
        guard !endpoint.isEmpty, !token.isEmpty else { return false }
        struct Reply: Decodable { let revoked: Bool? }
        let rest = RestClient()
        rest.configure(hubURL: endpoint, token: token)
        do {
            let reply = try await rest.post("api/logout", body: [String: String](), as: Reply.self)
            return reply.revoked == true
        } catch {
            return false
        }
    }

    /// After the hub has accepted account erasure, remove local caches for
    /// every visible workspace of this identity, without touching other accounts.
    public var localAccountScopes: Set<String> {
        var scopes: Set<String> = [storageScope]
        if let viewer {
            scopes.formUnion(storage.scopesForAccount(endpoint: endpoint, user: viewer.userId))
            for workspace in viewer.workspaces {
                scopes.insert("account-" + ClientStorage.digest([endpoint, viewer.userId, workspace.workspaceId]))
            }
        }
        return scopes
    }

    public func eraseLocalAccountData(additionalScopes: Set<String> = []) async throws {
        let scopes = localAccountScopes.union(additionalScopes)
        try await eraseStoredAccountData(scopes: scopes)
        // The keys of private machines are this phone's, not the account's, but
        // deleting the account's local data deletes them too.
        guard keyRing.removeAll() else { throw ClientError.rpc("Не удалось удалить ключи из Keychain.") }
        e2eeKeysChanged()
    }

    /// Resume a confirmed local deletion after sign-out or a failed disk write.
    /// Scopes are captured before the remote deletion, never from a new account.
    public func eraseStoredAccountData(scopes: Set<String>) async throws {
        if scopes.contains(storageScope) {
            let cache = transcripts
            disconnect()
            await cache.retire()
        }
        for scope in scopes {
            accountOutboxes.removeValue(forKey: scope)?.retire()
            accountFleets.removeValue(forKey: scope)?.retire()
        }
        try storage.erase(scopes: scopes)
    }

    /// Intentional disconnect (Settings edit / teardown) — no auto-retry.
    public func disconnect() {
        accountGeneration += 1
        stopped = true
        stopPrefetch()
        reconnectTask?.cancel(); reconnectTask = nil
        quotaTask?.cancel(); quotaTask = nil
        lastQuotaAt = nil
        catchUpWindow?.cancel(); catchUpWindow = nil
        endBackgroundGrace()
        teardownSocket()
        resetAccountState()
        endpoint = ""
        token = ""
        workspaceId = nil
        url = nil
        rest.configure(hubURL: "", token: "")
        activateStorage("signed-out")
    }

    private func resetAccountState() {
        pushDecisions.cancelAll()
        e2eePurged = []
        failedPrivate = []
        e2eeStale = []
        active = nil
        activeState = nil
        attachedRunId = nil
        parkedLines.removeAll()
        parkedOrder.removeAll()
        lines = []
        outbox = []
        busy = false
        toolReq = nil
        blockedSession = nil
        permissionMode = nil
        contextUsage = nil
        runSettings = nil
        viewer = nil
        cachedViewerId = nil
        fleetIsCached = false
        applyMachines([])
        activeRuns = []
        profiles = [:]
        machineStats = [:]
        committed = []
        gatewayUsage = nil
        budgetUsage = nil
        rateLimitNotices.clearPending()
        roadmapConfig = .fallback
        lastError = nil
        errClearTask?.cancel()
        failedHandshakes = 0
        authWarning = false
        notifs.clear()
        notifs.resetSeed()
        notifs.viewerId = nil
        earlyReads = []
        earlyCompletions = []
        readRetry.values.forEach { $0.cancel() }
        readRetry = [:]
        readSentAt = [:]
        readAnnouncedPhase = [:]
        completionReads.setVisibleSession(nil)
    }

    private func activateStorage(_ scope: String) {
        guard storageScope != scope else { return }
        stopPrefetch()
        storageScope = scope
        // Purge markers and unsent private words belong to the store they were made for.
        e2eePurged = []
        failedPrivate = []
        let directory = storage.directory(scope)
        aiDataSharingAllowed = scope.hasPrefix("account-") && AIDataConsent.load(directory: directory) != nil
        aiConsentRequested = false
        completionReads = SessionCompletionReads(directory: role == .primary && scope.hasPrefix("account-") ? directory : nil)
        transcripts = TranscriptCache(directory: directory)
        navigationTitles = NavigationTitles(directory: directory)
        sessionSettings = SessionSettingsStore(directory: directory)
        rateLimitNotices = RateLimitNotices(directory: directory)
        if role == .primary && scope != "signed-out" {
            let queue = accountOutboxes[scope] ?? PersistentOutbox(directory: directory)
            let fleet = accountFleets[scope] ?? FleetSnapshotStore(directory: directory)
            accountOutboxes[scope] = queue
            accountFleets[scope] = fleet
            durableOutbox = queue
            fleetStore = fleet
        } else {
            durableOutbox = nil
            fleetStore = nil
        }
        let cached = fleetStore?.load() ?? []
        applyMachines(cached)
        cachedViewerId = scope.hasPrefix("account-") ? fleetStore?.loadViewerId() : nil
        fleetIsCached = !cached.isEmpty
        lastFleetSaveAt = nil
        if let error = durableOutbox?.loadError { flashError("Не удалось прочитать очередь: \(error)") }
    }

    private func stopPrefetch() {
        prefetchTask?.cancel(); prefetchTask = nil
        prefetchGeneration += 1
        prefetchRunning = false
        lastSweepAt = nil
        prefetchedAt = [:]
        prefetchDone = 0
        prefetchTotal = 0
    }

    /// scenePhase → .background hook. Tell the hub to stop streaming at this
    /// socket: a suspended app cannot drain it, and a full outbound queue got
    /// the peer dropped as a slow link — which surfaced as "the hub falls off
    /// every time I leave the app". The hub's server-side pings keep the quiet
    /// pipe alive through NAT/nginx while we're gone; `resume` re-syncs on
    /// return. Old hubs ignore the message — behavior degrades to exactly the
    /// pre-pause world, nothing worse.
    public func appWillBackground() {
        backgroundedAt = Date()
        // Nobody sees the limits meter now; the next foreground refreshes it.
        quotaTask?.cancel(); quotaTask = nil
        // A liveness check started in the foreground must not finish in the
        // background: its pong would send `resume` (un-pausing the hub into a socket the
        // OS is about to suspend) and its deadline would tear the socket down. The next
        // foreground runs its own probe. Likewise an old keepalive deadline would fire
        // after the return, ahead of (and against) that new probe.
        probeTask?.cancel(); probeTask = nil
        pongWatch?.cancel(); pongWatch = nil
        // A reconnect scheduled in the foreground must not open in the background:
        // the hub sends the initial snapshot on connect, before our `pause` can be
        // read, so a suspended app would download the whole fleet. The return to
        // the foreground reconnects at once (`appDidBecomeActive`, status != .open).
        reconnectTask?.cancel(); reconnectTask = nil
        // Кэш для следующего холодного запуска — до любых проверок связи.
        if !stopped, viewer != nil { saveFleetSnapshot(force: true) }
        guard !stopped, status == .open else { return }
        pausedRunSignature = focusedRunSignature
        // Suspension can land between this call and the frame reaching the wire —
        // and a hub that never heard `pause` keeps fanning out into a socket
        // nobody is draining, which is how the connection died in the first place.
        // A short expiring task buys the flush (and, incidentally, keeps the socket
        // alive across the app switches that are over in a few seconds).
        // A suspended app cannot drain replies anyway, and the reads keep the far
        // agents busy for a screen nobody is looking at.
        prefetchTask?.cancel()
        beginBackgroundGrace()
        // Telemetry nobody looks at is not worth the hub's frames either.
        syncStatsInterest()
        // The assertion exists only to flush this frame: end it as soon as the
        // socket took it (or failed) instead of holding it for the full timer.
        sendRaw(.pause) { [weak self] _ in self?.endBackgroundGrace() }
    }

    /// A named host assertion, ended on the next activation, on our own timer, or —
    /// last resort — by the host's expiration handler.
    ///
    /// The 10s timer is there so that expiration handler stays a formality we
    /// normally never reach. On a host that grants nothing (macOS) `begin` returns
    /// nil and this whole path is inert.
    private func beginBackgroundGrace() {
        endBackgroundGrace()
        backgroundGrace = grace.begin("cc-remote-pause")
        guard backgroundGrace != nil else { return }
        graceTask = Task { [weak self] in
            // Fallback only: the pause completion normally ends the assertion
            // within milliseconds (see `appWillBackground`).
            try? await Task.sleep(for: .seconds(10))
            guard let self, !Task.isCancelled else { return }
            self.endBackgroundGrace()
        }
    }

    private func endBackgroundGrace() {
        graceTask?.cancel(); graceTask = nil
        guard let token = backgroundGrace else { return }
        grace.end(token)
        backgroundGrace = nil
    }

    /// scenePhase → .active hook. A closed pipe reconnects immediately. An
    /// `.open` socket is NEVER torn down on suspicion — not even a stale one:
    /// staleness after a background stint just means the pings didn't run, so
    /// the probe (one RTT) is the arbiter, and a full reconnect with its
    /// multi-megabyte snapshot is the fallback, not the default.
    public func appDidBecomeActive(fromBackground: Bool) {
        endBackgroundGrace()
        let away = backgroundedAt.map { Date().timeIntervalSince($0) } ?? 0
        backgroundedAt = nil
        guard !stopped, url != nil else { return }
        // Back on screen: refresh the limits meter now, then every 5 minutes.
        if quotaTask == nil { startQuotaPolling() }
        if status != .open {
            forceReconnect()
        } else if fromBackground && away > Self.suspendedAfter {
            // iOS усыпляет приложение через ~30 с в фоне; после этого сокет
            // почти всегда мёртв, а живой всё равно ответил бы на `resume`
            // полным снапшотом. Ждать 8 с пинга значит показывать пустую связь
            // ради экономии, которой нет: новый сокет сразу (09.10.2026).
            pendingCatchUp = true
            forceReconnect()
        } else if fromBackground || isStale {
            pendingCatchUp = true
            probeSocket()
        }
    }

    /// Сколько секунд фона считаем «приложение уже усыпляли».
    static let suspendedAfter: TimeInterval = 30

    /// Сеть сменилась (Wi-Fi ↔ сотовая, вышли из лифта). Хост зовёт это из
    /// своего монитора пути: без него смену сети замечал только упавший пинг,
    /// до 25 с спустя. Сеть появилась, а связи нет — сразу новый сокет; связь
    /// «есть» — проверить пингом, старый путь мог умереть вместе с интерфейсом.
    public func networkPathChanged(satisfied: Bool) {
        guard !stopped, url != nil else { return }
        pathSatisfied = satisfied
        if !satisfied {
            // No route: attempts now would only fail and burn the backoff. Park
            // the pending retry at the slow safety interval; the path coming back
            // (below) reconnects at once.
            if status == .closed, backgroundedAt == nil, reconnectTask != nil { scheduleReconnect() }
            return
        }
        guard backgroundedAt == nil else { return }
        if status != .open { forceReconnect() } else { probeSocket() }
    }

    /// The host's path monitor says a route exists. Optimistic until told otherwise.
    private var pathSatisfied = true
    /// How long to wait between attempts while there is no network route — only a
    /// safety net for a monitor that never reports the route back.
    private static let offlineRetryDelay: TimeInterval = 60
    /// After this many consecutive failed attempts the delay ceiling rises from
    /// 10 s to 30 s (a hub that is down for minutes does not need 6 attempts/min).
    private static let slowBackoffAfter = 6

    /// Reconnect delay: 0.3 s for the first retry (a one-off drop in the
    /// foreground), then 1, 2, 4, 8, 10 s; from the `slowBackoffAfter`-th failure
    /// on, 30 s. `jitter` (±20 %) spreads a fleet of phones that lost the same hub.
    static func reconnectDelay(retry: Int, jitter: Double = Double.random(in: 0.8...1.2)) -> TimeInterval {
        let base: Double
        if retry == 0 { base = 0.3 }
        else if retry > slowBackoffAfter { base = 30 }
        else { base = min(10.0, pow(2.0, Double(retry - 1))) }
        return base * min(1.2, max(0.8, jitter))
    }

    /// Prove an `.open`-after-background socket with a ping. Pong → alive: lift
    /// the hub-side pause (answered with a fresh snapshot), refresh the machine
    /// we are looking at, and re-read history ONLY if the focused run actually
    /// moved while we were away. No pong and no inbound frame within the window
    /// → the pipe really died: hard-reconnect.
    ///
    /// The window is generous on purpose. A phone coming back from background
    /// often has to wake its radio first, and the round trip that follows can
    /// take seconds on a weak cell — the old 2.5s deadline turned that ordinary
    /// latency into a full teardown plus a multi-megabyte snapshot, every single
    /// app switch. Being slow to declare death costs one late frame; being quick
    /// costs the whole connection.
    private func probeSocket() {
        guard let task else { forceReconnect(); return }
        let myEpoch = epoch
        let probeStart = Date()
        probeTask?.cancel()
        probeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, !Task.isCancelled else { return }
            guard self.epoch == myEpoch, self.status == .open, self.backgroundedAt == nil else { return }
            if self.lastFrameAt < probeStart { self.forceReconnect() }
        }
        task.ping { [weak self] error in
            Task { @MainActor in
                // A probe answered after the app left again is moot (see `appWillBackground`).
                guard let self, self.epoch == myEpoch, self.backgroundedAt == nil else { return }
                self.probeTask?.cancel(); self.probeTask = nil
                if error != nil {
                    self.forceReconnect()
                } else {
                    self.lastFrameAt = Date()
                    self.resumeCount += 1
                    self.sendRaw(.resume)
                    self.syncStatsInterest()
                    if let machineId = self.active?.machineId { self.rescan(machineId: machineId) }
                    // Catch up only when there is something to catch up on. The
                    // signature is compared once the resumed snapshot lands, so
                    // an idle session survives an app switch untouched.
                    self.pendingCatchUp = true
                }
            }
        }
    }

    /// Warm the 24 newest transcripts automatically; a full offline download is
    /// an explicit Settings action (`force`). Network and cache work still needs
    /// main-actor RPC dispatch, so automatic warming is serial and paced.
    public func prefetchTranscripts(force: Bool = false) {
        // One background sweep per app is plenty — a pane rides the primary's cache.
        guard role == .primary else { return }
        // The hub broadcasts a snapshot every few seconds, and this is called from
        // that handler. Restarting the sweep each time cancelled it mid-flight —
        // it never got past the first handful of files before starting over.
        if force {
            prefetchTask?.cancel()
        } else {
            guard !prefetchRunning else { return }
            // Once it has finished there is nothing to find until sessions move,
            // and a running session moves every few seconds — so re-sweeping on
            // each snapshot re-downloaded live transcripts. Space them out.
            if let last = lastSweepAt,
               Date().timeIntervalSince(last) < TranscriptPrefetchPlan.automaticSweepInterval { return }
        }
        prefetchGeneration += 1
        let generation = prefetchGeneration
        let cache = transcripts
        prefetchRunning = true
        prefetchTask = Task(priority: .utility) { [weak self] in
            guard let self else { return }
            defer {
                if self.prefetchGeneration == generation {
                    self.prefetchRunning = false
                    self.lastSweepAt = Date()
                }
            }
            // Let the opening snapshot settle and the focused session load first.
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }

            var wanted: [TranscriptPrefetchPlan.Item] = []
            for item in TranscriptPrefetchPlan.candidates(self.machines.filter { !self.isPrivateMachine($0.machine.machineId) }, all: force,
                                                          viewerId: self.viewer?.userId, runs: self.activeRuns) {
                guard !Task.isCancelled, self.prefetchGeneration == generation else { return }
                if await self.hasFreshCache(machineId: item.machineId,
                                            sessionId: item.sessionId,
                                            lastModified: item.mtime) { continue }
                // A session fetched a few minutes ago that moved since is still
                // changing: wait for it to settle instead of fetching it again.
                if !force, let at = self.prefetchedAt["\(item.machineId)::\(item.sessionId)"],
                   Date().timeIntervalSince(at) < TranscriptPrefetchPlan.automaticMinAge { continue }
                wanted.append(item)
            }
            guard !Task.isCancelled, self.prefetchGeneration == generation else { return }
            wanted.sort { $0.mtime > $1.mtime }
            guard !wanted.isEmpty else { self.prefetchTotal = 0; self.prefetchDone = 0; return }
            guard !Task.isCancelled else { return }

            self.prefetchTotal = wanted.count
            self.prefetchDone = 0
            self.log.info("prefetching \(wanted.count) transcripts")

            await withTaskGroup(of: Void.self) { group in
                var next = 0
                let limit = force ? 3 : 1
                func schedule(_ g: inout TaskGroup<Void>) {
                    guard next < wanted.count else { return }
                    let item = wanted[next]
                    next += 1
                    g.addTask { [weak self] in
                        guard let self, !Task.isCancelled else { return }
                        if !force {
                            try? await Task.sleep(for: .milliseconds(250))
                            guard !Task.isCancelled else { return }
                        }
                        // A failure here is not worth surfacing: the session still
                        // opens, it just costs a round trip when you get to it.
                        let page = try? await self.sessionMessagesPage(
                            machineId: item.machineId, cwd: item.cwd,
                            sessionId: item.sessionId, source: item.source,
                            lastModified: item.mtime)
                        await MainActor.run {
                            if self.prefetchGeneration == generation {
                                self.prefetchDone += 1
                                // Отметка «качали только что» — только за настоящую
                                // загрузку: ошибка или stale-ответ ничего не положили
                                // в кэш, и 10 минут блокировки повтора были бы потерей.
                                if TranscriptPrefetchPlan.fetchedForReal(page) {
                                    self.prefetchedAt["\(item.machineId)::\(item.sessionId)"] = Date()
                                }
                            }
                        }
                    }
                }
                for _ in 0..<limit { schedule(&group) }
                while await group.next() != nil {
                    guard !Task.isCancelled else { break }
                    schedule(&group)
                }
            }
            await cache.flush()
            self.log.info("prefetch finished (\(self.prefetchDone)/\(self.prefetchTotal))")
        }
    }

    private func resolveCatchUp() {
        guard pendingCatchUp else { return }
        if pausedRunSignature != focusedRunSignature {
            pendingCatchUp = false
            pausedRunSignature = nil
            catchUpWindow?.cancel(); catchUpWindow = nil
            connectionEpoch += 1
            hasCurrentAssistantLines = false
            return
        }
        // Unchanged so far — but the hub's inventory lags the machine by a few
        // seconds, so the FIRST snapshot after a reconnect can still describe the
        // world as it was before the gap. We asked for a rescan on connect; hold
        // the question open long enough for its answer to arrive, then let it go.
        guard catchUpWindow == nil else { return }
        catchUpWindow = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, !Task.isCancelled else { return }
            self.pendingCatchUp = false
            self.pausedRunSignature = nil
            self.catchUpWindow = nil
        }
    }

    /// Everything about the focused session that means "the transcript moved":
    /// the run's identity/state/turn, plus the file's own mtime so a session
    /// driven from the web or the editor while we were away still re-reads.
    /// Nil only when nothing is focused at all.
    private var focusedRunSignature: String? {
        guard let cur = active else { return nil }
        var parts: [String] = []
        if let runId = cur.runId {
            if let run = activeRuns.first(where: { $0.runId == runId }) {
                parts.append("\(run.runId)|\(run.state.rawValue)|\(run.since)")
            } else {
                parts.append(runId)
            }
        }
        let session = machines.first { $0.machine.machineId == cur.machineId }?
            .sessions.first { $0.sessionId == cur.sessionId }
        parts.append(session.map { "\($0.lastModified)" } ?? "-")
        return parts.joined(separator: "#")
    }

    private var isStale: Bool {
        status == .open && Date().timeIntervalSince(lastFrameAt) > staleAfter
    }

    /// A key was added or forgotten: everything that arrived before it is a
    /// placeholder (or clear text that must go), so read it all again - the new
    /// snapshot carries the envelopes the key now opens (web reloads the page).
    func reconnectForKeyChange(scrub machineId: String? = nil) {
        // Whatever was shown for this machine before the key changed is unauthenticated
        // (placeholders, or clear text a hub made up): gone before the change is published.
        if let machineId { scrubDecrypted(machineId) }
        e2eeKeysChanged()
        forceReconnect()
    }

    /// A key was forgotten: nothing decrypted for that machine stays in memory.
    /// Titles and folders go back to the placeholder, the open transcript and any
    /// pending approval are dropped; the locked screen takes over.
    private func scrubDecrypted(_ machineId: String) {
        purgeDiskTraces(machineId)
        updateMachine(machineId) { snap in
            snap.sessions = snap.sessions.map { s in
                var x = s
                x.title = E2ee.placeholderTitle
                x.cwd = nil; x.project = nil; x.gitBranch = nil
                return x
            }
        }
        if active?.machineId == machineId {
            lines = []
            toolReq = nil
            replayStage = nil
            background = []
        }
        for key in parkedLines.keys where key.hasPrefix("\(machineId)::") { parkedLines[key] = nil }
        parkedOrder.removeAll { parkedLines[$0] == nil }
        e2eeRunMachine = e2eeRunMachine.filter { $0.value != machineId }
        e2eeRpcMachine = e2eeRpcMachine.filter { $0.value != machineId }
        e2eeTermMachine = e2eeTermMachine.filter { $0.value != machineId }
        e2eeMirrorMachine = e2eeMirrorMachine.filter { $0.value != machineId }
    }

    /// Tear the socket down and open a fresh one immediately (reset backoff).
    private func forceReconnect() {
        guard !stopped, url != nil else { return }
        reconnectTask?.cancel()
        retry = 0
        teardownSocket()
        suspendProgress()
        toolReq = nil
        permissionMode = nil
        contextUsage = nil
        runSettings = nil
        status = .connecting
        openSocket()
    }

    private func openSocket() {
        guard let url else { return }
        // A replacement socket keeps the answer pending catch-up. Changed
        // signatures invalidate it in resolveCatchUp; an unchanged turn keeps it.
        if !reconnecting { hasCurrentAssistantLines = false }
        epoch += 1
        let myEpoch = epoch
        gotFrameThisConnect = false
        lastFrameAt = Date()
        status = .connecting
        notifs.resetSeed()

        let t = socketFactory(url, { [weak self] in self?.socketDidOpen(myEpoch) },
                              { [weak self] code, reason in
                                  self?.socketDidClose(myEpoch, code: code, reason: reason)
                              })
        task = t
        startHandshakeWatchdog(myEpoch)
        t.resume()
        // Identify as the native app so the hub tags runs we open with origin=app
        // (the board splits App vs Web on this). First frame; re-sent each reconnect
        // because the hub drops the kind on disconnect. Queues until the socket opens.
        sendRaw(.hello(client: "app", caps: ["sessionDelta", "sessionPatch", "statsOnDemand"]))
        // The hub forgets pause and stats interest with the old socket. A socket
        // that (re)opens while the app is in the background must hush itself
        // again, or the hub streams a fresh snapshot into a suspended app.
        if backgroundedAt != nil {
            sendRaw(.pause)
        } else if statsInterestCount > 0 {
            sendRaw(.statsInterest(on: true))
            statsInterestSent = true
        }
        receiveTask = Task { [weak self] in await self?.receiveLoop(t, myEpoch) }
        startPing()
    }

    private func startHandshakeWatchdog(_ myEpoch: Int) {
        handshakeTask?.cancel()
        handshakeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.handshakeTimeout))
            guard !Task.isCancelled else { return }
            await self?.handshakeTimedOut(myEpoch)
        }
    }

    /// The transport handshake completed (HTTP 101). The socket is healthy even
    /// though no application frame has arrived yet — a large opening snapshot can
    /// take a while to stream in, and interrupting it would restart the download.
    fileprivate func socketDidOpen(_ myEpoch: Int) {
        guard myEpoch == epoch else { return }
        handshakeTask?.cancel()
        handshakeTask = nil
    }

    fileprivate func socketDidClose(_ myEpoch: Int, code: Int, reason: String?) {
        guard myEpoch == epoch else { return }
        log.warning("socket closed by peer: code=\(code) reason=\(reason ?? "-")")
    }

    /// The socket never spoke. Retry with backoff, but do NOT count this as a
    /// failed handshake — a stalled connection is a network symptom, not a bad
    /// token, and `authWarning` would send the user to edit a correct setting.
    private func handshakeTimedOut(_ expected: Int) {
        guard !stopped, expected == epoch, !gotFrameThisConnect else { return }
        log.warning("handshake stalled — reopening socket")
        teardownSocket()
        status = .closed
        scheduleReconnect()
    }

    private func teardownSocket() {
        if isChangingModel {
            finishModelChange(error: "Связь прервалась. Проверьте модель после подключения.")
        }
        // Invalidate before cancellation: delayed receive/decode/delegate/pong
        // callbacks must not mutate a replacement connection or a signed-out UI.
        epoch += 1
        status = .closed
        receiveTask?.cancel(); receiveTask = nil
        pingTask?.cancel(); pingTask = nil
        pongWatch?.cancel(); pongWatch = nil
        handshakeTask?.cancel(); handshakeTask = nil
        probeTask?.cancel(); probeTask = nil
        task?.cancel()
        task = nil
        attachedRunId = nil
        statsInterestSent = false
        durableOutbox?.connectionClosed()
        rejectConnectionWork()
    }

    private func rejectConnectionWork() {
        let closed = ClientError.connectionClosed
        pendingRpc.rejectAll(error: closed)
        memoryLists.rejectAll(error: closed)
        memoryReads.rejectAll(error: closed)
        memoryDeletes.rejectAll(error: closed)
        enrichRequests.rejectAll(error: closed)
        termOpens.rejectAll(error: closed)
        for (_, s) in termSubs { s.onExit(nil) }
        termSubs.removeAll()
        mirrorOpens.rejectAll(error: closed)
        for (_, s) in mirrorSubs { s.onExit?() }
        mirrorSubs.removeAll()

    }

    private func receiveLoop(_ t: any WebSocketConnection, _ myEpoch: Int) async {
        while !Task.isCancelled {
            do {
                let text = try await t.receive()
                guard myEpoch == epoch, !Task.isCancelled else { return }
                await onText(text, epoch: myEpoch)
            } catch {
                if myEpoch == epoch, !stopped, !Task.isCancelled { handleDrop() }
                return
            }
        }
    }

    private func onText(_ text: String, epoch expected: Int) async {
        lastFrameAt = Date()
        if !gotFrameThisConnect {
            gotFrameThisConnect = true
            socketGeneration += 1
            handshakeTask?.cancel(); handshakeTask = nil
            retry = 0
            failedHandshakes = 0
            authWarning = false
            status = .open
            // A REPLACEMENT socket is not new information. Nothing in `active` /
            // `activeRuns` has moved while we were disconnected (frames are the
            // only thing that moves them), so this is still the pre-gap state —
            // snapshot it here, then let `resolveCatchUp` compare it against what
            // the fresh snapshot brings and bump the epoch only if the run really
            // advanced. Same gate the background probe already used; it just never
            // covered the case where the socket died, which is the common one.
            if reconnecting {
                pausedRunSignature = focusedRunSignature
                pendingCatchUp = true
                catchUpWindow?.cancel(); catchUpWindow = nil
            } else {
                connectionEpoch += 1
            }
            reconnecting = true
            // Re-register the push token every connect (rotates; hub map is in RAM).
            if let pushToken { send(.registerPush(deviceToken: pushToken, platform: "ios"), quiet: true) }
            // The inventory we hold predates the gap, and `livePid` decides whether
            // the session shows a Mirror or a composer — refresh the machine we are
            // actually looking at before that decision is re-made.
            if let machineId = active?.machineId { rescan(machineId: machineId) }
        }
        // A frame is arriving, so the socket is not quiet: a staged replay must
        // not be published by its quiet-gap timer while this one decodes (a
        // history page decodes for a long time, and the rest of the backlog is
        // queued behind it). Re-armed once the frame is handled.
        if replayStage != nil { replayCommit?.cancel(); replayCommit = nil }
        defer { if replayStage != nil, replayCommit == nil { scheduleReplayCommit() } }
        // Decode off the main actor — a history/mirror frame runs up to 64 MiB
        // (see maximumMessageSize) and JSON-parsing one inline hitches the UI.
        // Awaited from the serial receive loop, so frame order is preserved and
        // the main actor stays free during the parse.
        // Private machine: envelopes are opened here, once, off the main actor, so
        // everything downstream reads the frames it always read. The loop awaits
        // it, so frame order is preserved.
        var text = text
        let e2eeInboundWork = e2eeInbound(for: text)
        let e2eeTouched = e2eeInboundWork != nil
        if let inbound = e2eeInboundWork {
            let raw = text
            let revision = e2eeRevision
            let result = await Task.detached(priority: .userInitiated, operation: { inbound.processDetailed(raw) }).value
            // A frame made against the keys as they were before a pairing must not lock the
            // machine after it; and a frame that opens with the current key unlocks it again.
            if e2eeRevision == revision {
                if let stale = result.staleKeyMachine, result.healedMachine != stale { e2eeStale.insert(stale) }
                if let healed = result.healedMachine, e2eeStale.contains(healed) { e2eeStale.remove(healed) }
            }
            guard let opened = result.text
            else { return }   // clear content for a run of a keyed machine: the hub's invention
            text = opened
        }
        guard let msg = await decodeFrame(text) else {
            // A frame that went through the private-machine opener may now hold
            // decrypted content: never put its text in the log.
            log.warning("dropped undecodable frame (\(text.utf8.count) bytes)\(e2eeTouched ? "" : ": \(text.prefix(120))")")
            return
        }
        guard expected == epoch, !Task.isCancelled else { return }
        handle(msg)
    }

    /// JSON-decode a hub frame. `nonisolated async` runs on the cooperative pool,
    /// not the `@MainActor` executor, so the parse never blocks the UI.
    nonisolated static func decode(_ text: String) async -> HubMessage? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(HubMessage.self, from: data)
    }

    /// How often the client pings the hub. The hub pings us every 25 s as well
    /// (server-rs/src/ws_api.rs) and that is what keeps NAT / Cloudflare / nginx
    /// from idling the pipe out (nginx `proxy_read_timeout` is 3600 s on /ui, the
    /// tightest middlebox ~100 s). Our own ping is therefore only the liveness
    /// probe, and it does not need to out-run the hub's.
    static let pingInterval: TimeInterval = 45
    /// A protocol ping with no pong (and no inbound frame) for this long means
    /// the pipe is dead. URLSession would eventually fail the ping on its own,
    /// after up to its 60 s request timeout; this bounds it. Worst-case time to
    /// notice a silently dead socket: `pingInterval` + `pongTimeout` = 65 s
    /// (was 25 s + URLSession's own timeout). A dropped interface is noticed at
    /// once by `NetworkPathWatcher`, and a closed socket by `receive()`.
    private static let pongTimeout: TimeInterval = 20

    private func startPing() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.pingInterval))
                guard !Task.isCancelled else { return }
                // Nothing to keep alive while the app is in the background: the
                // hub has been told to `pause`, and a suspended app cannot ping.
                guard let self, self.status == .open, self.backgroundedAt == nil else { continue }
                await self.keepalive()
            }
        }
    }

    /// WebSocket-level keepalive. The hub emits application frames ONLY on activity,
    /// so an idle-but-healthy socket is silent — we must never treat that as dead
    /// (doing so caused a reconnect storm). A protocol-level ping gets an automatic
    /// pong from the hub (axum/tungstenite), which both proves liveness and refreshes
    /// `lastFrameAt`; a ping error means the pipe is actually dead → reconnect.
    /// No app-level `{"type":"ping"}` any more: the hub ignores it, and the pong
    /// already exercises the same read path.
    private func keepalive() {
        guard let task else { return }
        let myEpoch = epoch
        let sentAt = Date()
        pongWatch?.cancel()
        pongWatch = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.pongTimeout))
            guard let self, !Task.isCancelled else { return }
            // Any inbound frame since the ping also proves the pipe is alive.
            guard self.epoch == myEpoch, self.status == .open, self.backgroundedAt == nil,
                  self.lastFrameAt < sentAt else { return }
            self.log.warning("no pong for \(Self.pongTimeout)s — reconnecting")
            self.forceReconnect()
        }
        task.ping { [weak self] error in
            Task { @MainActor in
                guard let self, self.epoch == myEpoch, self.status == .open else { return }
                self.pongWatch?.cancel(); self.pongWatch = nil
                // Failed while we were away: the return probe judges the socket.
                if error != nil { if self.backgroundedAt == nil { self.forceReconnect() } }
                else { self.lastFrameAt = Date() }
            }
        }
    }

    private func handleDrop() {
        teardownSocket()
        status = .closed
        if !gotFrameThisConnect {
            failedHandshakes += 1
            if failedHandshakes >= 2 { authWarning = true }
        }
        // Preserve runId: the hub owns the run lifecycle and this socket is only
        // a replaceable subscriber. The next snapshot re-attaches the fresh one.
        suspendProgress()
        toolReq = nil
        permissionMode = nil
        contextUsage = nil
        runSettings = nil

        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        // In the background iOS is about to suspend us; a socket opened now is
        // dead on arrival and its snapshot is megabytes nobody reads. The next
        // foreground (`appDidBecomeActive`) reconnects a closed socket at once.
        guard backgroundedAt == nil else { return }
        let delay: TimeInterval
        if pathSatisfied {
            delay = Self.reconnectDelay(retry: retry)
            retry += 1
        } else {
            delay = Self.offlineRetryDelay
        }
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            await self.openSocket()
        }
    }

    // MARK: Read marks (shared across devices through the hub)

    /// The host's single entry point for «this session is now on screen» (nil:
    /// nothing is). Clears the local unread dot, drops the bell's entries for
    /// that session and tells the hub so the person's other devices follow.
    public func setVisibleSession(_ key: String?) {
        completionReads.setVisibleSession(key)
        guard let key else { return }
        if let (machineId, sessionId) = Self.splitKey(key) { notifs.dismiss(machineId: machineId, sessionId: sessionId) }
        announceRead(key)
    }

    /// Marks from the hub: clear the unread dot, and drop the bell entries of the
    /// same session that the mark covers (`since <= at`) — error and decision
    /// entries have no unread dot, so they are matched by the mark itself.
    private func applySessionReads(_ reads: [SessionRead]) {
        completionReads.applyRemoteReads(reads)
        for read in reads where read.at.isFinite && !read.machineId.isEmpty && !read.sessionId.isEmpty {
            notifs.dismiss(machineId: read.machineId, sessionId: read.sessionId, upTo: read.at)
        }
    }

    private static func splitKey(_ key: String) -> (String, String)? {
        guard let range = key.range(of: "::") else { return nil }
        return (String(key[..<range.lowerBound]), String(key[range.upperBound...]))
    }

    /// Send `session_read` for a session that is on screen, at most once per
    /// `readThrottle` per session. A mark held back is retried when the window
    /// ends, so the last result of a burst is still reported. Never for nil.
    /// Phase (state + since) of the visible run last announced, per session.
    private var readAnnouncedPhase: [String: String] = [:]

    private func announceRead(_ key: String) {
        guard let (machineId, sessionId) = Self.splitKey(key), !sessionId.isEmpty else { return }
        let wait = readSentAt[key].map { Self.readThrottle - Date().timeIntervalSince($0) } ?? 0
        if wait > 0 {
            guard readRetry[key] == nil else { return }
            readRetry[key] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(wait))
                guard let self, !Task.isCancelled else { return }
                self.readRetry[key] = nil
                if self.completionReads.visibleSession == key { self.announceRead(key) }
            }
            return
        }
        if send(.sessionRead(machineId: machineId, sessionId: sessionId), quiet: true) { readSentAt[key] = Date() }
    }

    // MARK: Sending

    @discardableResult
    private func send(_ msg: ClientMessage, quiet: Bool = false,
                      completion: ((Error?) -> Void)? = nil) -> Bool {
        guard !msg.requiresAIDataConsent || canUseAI else {
            if !quiet { aiConsentRequested = true }
            return false
        }
        guard status == .open, task != nil else {
            // Deliberately silent. The socket drops whenever iOS suspends the app,
            // so this toast fired constantly — and it told the user to do the one
            // thing the client already does for them: retry. The header's
            // "переподключение…" line is the honest, non-intrusive version.
            _ = quiet
            return false
        }
        // Private machine: what carries content is sealed here or not sent at all.
        guard let wire = e2eeWire(msg, quiet: quiet) else { return false }
        sendRaw(msg, wire: wire, completion: completion)
        return true
    }

    private func sendRaw(_ msg: ClientMessage, wire: String? = nil, completion: ((Error?) -> Void)? = nil) {
        guard let task else { completion?(ClientError.connectionClosed); return }
        let str: String
        if let wire {
            str = wire
        } else {
            // Housekeeping frames (hello, ping, pause, stats) only. A frame that
            // can carry content never takes this road: it went through `e2eeWire`.
            guard !msg.carriesContent else { completion?(ClientError.connectionClosed); return }
            do { str = String(decoding: try JSONEncoder().encode(msg), as: UTF8.self) }
            catch { completion?(error); flashError("Не удалось подготовить сообщение."); return }
        }
        // A background assertion per frame is a UIKit round trip each: only for
        // what a person just did (a message, a decision, a stop) — never for
        // keepalive / subscription / telemetry housekeeping.
        let bg = Self.needsSendAssertion(msg) ? grace.begin("cc-send") : nil
        let grace = self.grace
        let myEpoch = epoch
        // Capture the destination NOW. By the time a failed send completes,
        // focus, account and even the connection may all have changed.
        let recover = completion == nil ? failedSendRecovery(msg) : nil
        task.send(str) { [weak self] error in
            if let bg { grace.end(bg) }
            if error != nil { recover?() }
            guard let self, self.epoch == myEpoch else { return }
            completion?(error)
        }
    }

    private static let readOnlyRpcMethods: Set<String> = [
        "session.messages", "session.subagent", "session.image", "models.list", "projects.list",
        "fs.list", "fs.read", "git.status", "git.branches", "proc.list",
    ]

    /// Whether losing this frame to a suspension would lose something the person
    /// did. Housekeeping and read-only requests re-run on the next foreground.
    private static func needsSendAssertion(_ msg: ClientMessage) -> Bool {
        switch msg {
        case .ping, .hello, .pause, .resume, .sessionRead, .subscribe, .unsubscribe,
             .registerPush, .unregisterPush, .statsInterest, .rescan, .memoryList, .memoryRead,
             .enrichRequest, .mirrorOpen, .mirrorClose:
            return false
        case let .rpcRequest(_, _, method, _):
            return !readOnlyRpcMethods.contains(method)
        default:
            return true
        }
    }

    // MARK: Hardware stats on demand

    /// Screens that show `machineStats` (the hardware tab) call this with `true`
    /// on appear and `false` on disappear — counted, so overlapping screens do
    /// not cancel each other. The hub (capability `statsOnDemand`) streams
    /// `machine_stats` only while the count is above zero and replays the latest
    /// samples when it becomes so. Interest is dropped while the app is in the
    /// background and re-sent after every reconnect / resume.
    public func setStatsInterest(_ on: Bool) {
        statsInterestCount = max(0, statsInterestCount + (on ? 1 : -1))
        syncStatsInterest()
    }

    /// Make the hub's idea of our interest match the wanted one, on an open socket.
    private func syncStatsInterest() {
        let want = statsInterestCount > 0 && backgroundedAt == nil
        guard status == .open, want != statsInterestSent else { return }
        statsInterestSent = want
        sendRaw(.statsInterest(on: want))
    }

    private func failedSendRecovery(_ msg: ClientMessage) -> (() -> Void)? {
        // A private machine's words are never parked on this phone's disk: a failed send
        // comes back through memory only (any machine the frame could be for counts).
        if let recovery = privateSendRecovery(msg) { return recovery }
        guard let queue = durableOutbox else { return nil }
        let message: PendingMessage
        switch msg {
        case let .input(runId, text, images):
            let target = activeRuns.first(where: { $0.runId == runId })
                .map { ($0.machineId, $0.sessionId) }
                ?? (active?.runId == runId ? active.map { ($0.machineId, $0.sessionId) } : nil)
            guard let target else { return nil }
            message = PendingMessage(machineId: target.0, sessionId: target.1,
                                     text: text, images: (images ?? []).map(PendingImage.init))
        case let .open(machineId, sessionId, text, images):
            if queue.isOpening(machine: machineId, session: sessionId) {
                let generation = epoch
                return { [weak self] in
                    guard self?.epoch == generation else { return }
                    queue.failOpen(machine: machineId, session: sessionId)
                }
            }
            guard !(text ?? "").isEmpty || !(images ?? []).isEmpty else { return nil }
            message = PendingMessage(machineId: machineId, sessionId: sessionId,
                                     text: text ?? "", images: (images ?? []).map(PendingImage.init))
        default: return nil
        }
        return { [weak self, queue] in
            do { try queue.append(message) }
            catch {
                if self?.durableOutbox === queue {
                    self?.flashError("Не удалось сохранить сообщение: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: Error toast

    public func flashError(_ message: String, ms: Double = 6000) {
        lastError = FlashError(message: message)
        errClearTask?.cancel()
        errClearTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(ms)))
            guard let self, !Task.isCancelled else { return }
            self.lastError = nil
        }
    }

    private func addLine(_ kind: TranscriptLine.Kind, _ text: String, images: [ImageAttachment] = [],
                         code: String? = nil, toolUseId: String? = nil) {
        let line = TranscriptLine(id: nextId(), kind: kind, text: text, images: images,
                                  ts: Date().timeIntervalSince1970 * 1000, code: code, toolUseId: toolUseId)
        if kind == .user, replayStage != nil {
            replayStage!.echoes.append(line)
            replayStage!.pendingEchoIDs.insert(line.id)
        } else if kind == .user {
            withLines { lines in
                var echo = line
                echo.replayPending = lines.contains { $0.replayPending }
                lines.append(echo)
            }
        } else { withLines { TranscriptUpdates.appendWire(line, to: &$0) } }
    }

    /// Mutate the staged replay while one is being assembled, `lines` otherwise.
    private func withLines(_ body: (inout [TranscriptLine]) -> Void) {
        if replayStage != nil { body(&replayStage!.lines) } else { body(&lines) }
    }

    private func scheduleReplayCommit() {
        replayCommit?.cancel()
        guard let stage = replayStage else { return }
        let delay: TimeInterval
        if let expected = stage.expected {
            delay = stage.received >= expected ? 0
                : max(0, Self.replayStallGap - Date().timeIntervalSince(stage.lastProgress))
        } else {
            let left = Self.replayMaxHold - Date().timeIntervalSince(stage.started)
            delay = max(0, min(Self.replayQuietGap, left))
        }
        replayCommit = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.commitReplay()
        }
    }

    /// Whether `msg` may be handled while the replay is still being assembled.
    /// The staged run's own frames obviously; so may everything that never
    /// touches `lines`. The hub's backlog is hundreds of separate frames and
    /// the socket keeps carrying the rest of the world between them — the
    /// history read's `rpc_response`, the fleet's `activity`, session-list
    /// patches. Each of those used to publish the stage early, and the rest of
    /// the backlog then landed frame by frame: the steps visibly played back
    /// from the first one and the phone lagged (24.10.2026).
    private func keepsReplayStage(_ msg: HubMessage, _ stage: ReplayStage) -> Bool {
        switch msg {
        case let .stream(runId, _, _): return runId == stage.runId
        case let .userTurn(runId, _, _, _, _, _, _, _): return runId == stage.runId
        case let .runMode(runId, _, _): return runId == stage.runId
        case let .runSettings(runId, _, _, _, _, _): return runId == stage.runId
        case .rpcResponse, .usage, .codexUsage, .runtimeStatus, .machineStats, .builderProfile,
             .sessionCommitted, .sessionStage, .sessionReads, .contextUsage, .enrichResult,
             .memoryListResult, .memoryReadResult, .memoryDeleteResult,
             .machineSessions, .sessionUpdates,
             .termOpened, .termData, .termExit, .mirrorOpened, .mirrorData, .mirrorExit:
            return true
        case let .activity(runs):
            // Neutral only while it says the staged run is still the attached,
            // replaying one: `ingestActivity` then just reconciles the clock.
            // A run that ended or moved re-subscribes and closes the dangling
            // line — that has to see the transcript in order.
            return attachedRunId == stage.runId
                && runs.contains { $0.runId == stage.runId && Self.replaysTurn($0.state) }
        default:
            return false
        }
    }

    private func commitReplay() {
        replayCommit?.cancel()
        replayCommit = nil
        guard let stage = replayStage else { return }
        replayStage = nil
        lines = TranscriptUpdates.finishReplay(lines: stage.lines, echoes: stage.echoes,
                                              pendingIDs: stage.pendingEchoIDs)
    }

    // MARK: Inbound dispatch (port of `handle` in useCentral)

    private func handle(_ msg: HubMessage) {
        // Anything but the staged run's own stream frames ends the replay: it is
        // published first, so every later message sees the transcript in order.
        // `run_mode` / `run_settings` come between `opened` and the backlog
        // (server-rs/src/hub.rs) and never touch `lines`, so they do not end it.
        if let stage = replayStage, !keepsReplayStage(msg, stage) { commitReplay() }
        // What the hub counted in `opened.backlog`: its replay window holds the
        // turn's stream frames and the person's `user_turn`s.
        let replayRun: String? = switch msg {
        case let .stream(runId, _, _): runId
        case let .userTurn(runId, _, _, _, _, _, _, _): runId
        default: nil
        }
        if let run = replayRun, run == replayStage?.runId {
            replayStage!.received += 1
            replayStage!.lastProgress = Date()
        }
        switch msg {
        case let .snapshot(machines, activeRuns, roadmap, viewer):
            if let viewer {
                let verifiedScope = storage.verifiedScope(endpoint: endpoint, viewer: viewer)
                if storageScope.hasPrefix("credential-"), let source = durableOutbox {
                    let owner = accountOutboxes[verifiedScope] ?? PersistentOutbox(directory: storage.directory(verifiedScope))
                    do { try source.transfer(to: owner) }
                    catch {
                        flashError("Не удалось перенести очередь аккаунта: \(error.localizedDescription)")
                        return
                    }
                    accountOutboxes[verifiedScope] = owner
                }
                let scope = storage.bind(endpoint: endpoint, token: token,
                                         requestedWorkspace: workspaceId, viewer: viewer)
                if let previous = self.viewer,
                   previous.userId != viewer.userId || previous.workspace.workspaceId != viewer.workspace.workspaceId {
                    accountGeneration += 1
                    resetAccountState()
                }
                activateStorage(scope)
                self.viewer = viewer
                // Scopes the Inbox to this person's own runs — `activity` carries
                // every run they may view, which for an admin is the whole fleet.
                notifs.viewerId = viewer.userId
                if !earlyReads.isEmpty {
                    applySessionReads(earlyReads)
                    earlyReads = []
                }
                if !earlyCompletions.isEmpty {
                    completionReads.applyCompletions(earlyCompletions)
                    earlyCompletions = []
                }
                // A socket that opened after the chat was already on screen owes the hub its mark.
                if let key = completionReads.visibleSession { announceRead(key) }
            }
            applyMachines(machines.map(Self.withCleanTitles))
            fleetIsCached = false
            self.roadmapConfig = roadmap ?? .fallback
            // The snapshot seeds what deltas keep fresh — a client that connects
            // after a machine last recomputed must not show an empty screen.
            for snap in machines {
                if let profile = snap.profile { setProfile(profile, for: snap.machine.machineId) }
                if let stats = snap.stats { setStats(stats, for: snap.machine.machineId) }
            }
            if let activeRuns { ingestActivity(activeRuns) }
            resolveCatchUp()
            // The inventory is what tells us which transcripts exist and whether our
            // copies are current, so the sweep can only start once it has landed.
            prefetchTranscripts()
            // …and it is also what tells us which machines are back — the moment
            // messages queued offline can finally go.
            flushPending()
            saveFleetSnapshot()

        case let .machineSessions(machine):
            // One machine's list in place of the whole fleet's. Everything the
            // snapshot arm does downstream still applies — this IS the inventory
            // landing, just for one machine.
            let fresh = Self.withCleanTitles(machine)
            applyMachine(fresh, fresh: nil)
            if let profile = fresh.profile { setProfile(profile, for: fresh.machine.machineId) }
            if let stats = fresh.stats { setStats(stats, for: fresh.machine.machineId) }
            resolveCatchUp()
            prefetchTranscripts()
            flushPending()
            saveFleetSnapshot()

        case let .sessionUpdates(machineId, sessions, removed):
            let fresh = sessions.map { session -> SessionSummary in
                var x = session
                x.title = cleanedTitle(x.title)
                return x
            }
            let dropped = Set(removed)
            guard let i = allMachines.firstIndex(where: { $0.machine.machineId == machineId }) else {
                // A patch for a machine we have never seen: the snapshot that
                // introduces it is on its way, and it will carry these anyway.
                break
            }
            var snap = allMachines[i]
            var list = snap.sessions.filter { !dropped.contains($0.sessionId) }
            var position: [String: Int] = [:]
            for (at, session) in list.enumerated() { position[session.sessionId] = at }
            for session in fresh {
                if let at = position[session.sessionId] {
                    list[at] = session
                } else {
                    position[session.sessionId] = list.count
                    list.append(session)
                }
            }
            // The hub's ordering does not survive a patch, and the project
            // grouping downstream documents its input as newest-first.
            snap.sessions = list.sorted { $0.lastModified > $1.lastModified }
            // Only this machine, and only the patched sessions are re-judged for
            // `isAutomated`; a patch that changed nothing writes nothing.
            if snap != allMachines[i] {
                applyMachine(snap, fresh: Set(fresh.map(\.sessionId)))
            }
            resolveCatchUp()
            prefetchTranscripts()
            flushPending()
            saveFleetSnapshot()

        case let .activity(runs):
            ingestActivity(runs)
            resolveCatchUp()
            flushPending()

        case let .usage(machineId, usage):
            updateMachine(machineId) { $0.usage = usage }

        case let .machineStats(machineId, stats):
            setStats(stats, for: machineId)

        case let .sessionCommitted(machineId, sessionId):
            committed.insert("\(machineId)::\(sessionId)")

        case let .sessionStage(machineId, sessionId, stage):
            // Unknown session => ignore silently; the next rescan catches up.
            updateMachine(machineId) { snap in
                if let si = snap.sessions.firstIndex(where: { $0.sessionId == sessionId }) {
                    snap.sessions[si].stage = stage
                }
            }
            // Web semantics (useCentral): any stage move clears the "commit
            // landed" nudge — the card was acted on.
            committed.remove("\(machineId)::\(sessionId)")

        case let .builderProfile(machineId, profile):
            setProfile(profile, for: machineId)

        case let .memoryListResult(requestId, ok, memories, error):
            if ok { memoryLists.resolve(id: requestId, value: memories ?? []) }
            else { memoryLists.reject(id: requestId, error: ClientError.rpc(error ?? "memory_list failed")) }

        case let .memoryReadResult(requestId, ok, content, error):
            if ok, let content { memoryReads.resolve(id: requestId, value: content) }
            else { memoryReads.reject(id: requestId, error: ClientError.rpc(error ?? "memory_read failed")) }

        case let .memoryDeleteResult(requestId, ok, error):
            if ok { memoryDeletes.resolve(id: requestId, value: ()) }
            else { memoryDeletes.reject(id: requestId, error: ClientError.rpc(error ?? "memory_delete failed")) }

        case let .enrichResult(requestId, ok, enrichment, error):
            if ok {
                enrichRequests.resolve(id: requestId, value: .result(enrichment))
            } else if error == "enrichment not configured" {
                // Terminal, not an error: the hub has no gateway, the heuristic
                // layer is the whole feature, and asking again would only cost
                // a round trip each turn.
                enrichUnavailable = true
                enrichRequests.resolve(id: requestId, value: .notConfigured)
            } else {
                enrichRequests.reject(id: requestId, error: ClientError.rpc(error ?? "enrich failed"))
            }

        case let .codexUsage(machineId, usage):
            updateMachine(machineId) { $0.codexUsage = usage }

        case let .runtimeStatus(machineId, runtimes):
            updateMachine(machineId) {
                $0.runtimes = runtimes
                // A Claude reading cached from before the switch must not
                // show up as limits (web 0fb379f).
                if runtimes.claudeOff { $0.usage = nil }
            }

        case let .opened(runId, machineId, sessionId, backlog):
            // The answer to an open must name the machine this phone asked; one that
            // names another is the hub's doing. Only matters (and is only dropped)
            // when a private machine is involved.
            if let cur = active, cur.machineId != machineId,
               cur.runId == runId || (cur.runId == nil && cur.sessionId == sessionId),
               isPrivateMachine(cur.machineId) || isPrivateMachine(machineId) {
                flashError("Хаб ответил за другую машину — ответ отброшен.")
                break
            }
            // If this open carried a queued offline message, it is now delivered.
            confirmPendingOpen(machineId: machineId, sessionId: sessionId)
            // Accept the ack only for the session still in focus; a late ack must
            // not hijack the view, and its run must stop streaming at us.
            if let cur = active,
               cur.runId == runId || (cur.machineId == machineId && cur.sessionId == sessionId) {
                // An `opened` for a run already mid-turn answers a (re)subscribe,
                // and the hub follows it with the WHOLE current turn from its
                // first frame (`backlog`, server-rs/src/hub.rs). The lines kept
                // across the reconnect already hold that turn, so the replay
                // appended a second copy — and every further reconnect in a long
                // turn one more: the same paragraph three times on a phone that
                // slept twice. Start the turn over from the replay, keeping only
                // the person's own unanswered message (web does the same on
                // reconnect — `keepUnansweredTail`, web/src/central-reducers.ts).
                // An idle run replays nothing, so its lines stay for convergence.
                let replays = Self.replaysTurn(activeRuns.first { $0.runId == runId }?.state)
                active = ActiveRun(runId: runId, machineId: machineId, sessionId: sessionId)
                attachedRunId = runId
                if cur.machineId == machineId { rememberRunMachine(runId, machineId) }
                if replays {
                    // Staged, not written: the lines on screen stay until the
                    // whole replay replaces them in one step.
                    replayStage = ReplayStage(runId: runId, lines: [],
                                              echoes: lines.filter { $0.kind == .user },
                                              pendingEchoIDs: Set(Self.keepUnansweredTail(lines).map(\.id)), started: Date(),
                                              expected: backlog)
                    scheduleReplayCommit()
                }
            } else {
                if attachedRunId == runId { attachedRunId = nil }
                send(.unsubscribe(runId: runId), quiet: true)
            }

        case let .sessionStarted(runId, sessionId):
            // A new session just learned its real id — bind it, then rescan so the
            // session shows up in the inventory list.
            guard let cur = active, cur.runId == runId else { break }
            active = ActiveRun(runId: runId, machineId: cur.machineId, sessionId: sessionId)
            rescan(machineId: cur.machineId)

        case let .userTurn(runId, _, turnId, text, truncated, ts, images, files):
            guard runId == active?.runId else { break }
            let id = nextId()
            let staging = replayStage != nil
            withLines { lines in
                TranscriptUpdates.userTurn(&lines, id: id, turnId: turnId, text: text,
                                           truncated: truncated ?? false, ts: ts,
                                           images: images ?? 0, files: files ?? [], matchEcho: !staging)
            }
            if staging { scheduleReplayCommit() }

        case let .stream(runId, _, event):
            guard runId == active?.runId else { break }
            if event.code == "control_failed", isChangingModel {
                finishModelChange(error: event.text ?? "Не удалось сменить модель.")
            }
            // A booting CLI answers 20–40 s late and the switch then applies
            // (16.10.2026). The agent says so at 10 s; past our 25 s we would
            // flash «не подтвердила» over a switch that is about to land. Wait
            // out the agent's own bound — the run_settings readback or its
            // `control_failed` ends the change either way.
            if event.code == "control_pending", let change = modelChange {
                modelChangeTimeout?.cancel()
                modelChangeTimeout = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(190))
                    guard !Task.isCancelled, let self, self.modelChange?.id == change.id else { return }
                    self.finishModelChange(error: "Модель не подтвердила переключение. Проверьте выбор и повторите.")
                }
            }
            // Written only on a change: an `@Observable` setter notifies even
            // for the same value, and a replay sends hundreds of these frames.
            if event.code == "turn_started" || event.code == "turn_usage" || event.kind == .partial ||
                event.kind == .assistant || event.kind == .tool_use {
                if !busy { busy = true }
                if turnIdle { turnIdle = false }
            }
            if event.code == "background_tasks" {
                background = event.data?.tasks ?? []
                break
            }
            if event.code == "subagents" {
                subagentsOf = (runId, event.data?.agents ?? [])
                break
            }
            // A picture being drawn: one card per id, kept in the transcript
            // in order (not folded into the step list) — see `ImageGenCard`.
            if event.code == "image_gen" {
                let id = nextId()
                withLines { TranscriptUpdates.imageGen(&$0, id: id, event: event, now: Date().timeIntervalSince1970 * 1000) }
                if replayStage != nil { scheduleReplayCommit() }
                break
            }
            // The CLI's own turn state. `idle` is the only sign that the TURN
            // ended while the JOB did not; `running` with nobody having typed is
            // the CLI waking itself on the task — work like any other.
            if event.code == "session_state" {
                if event.data?.state == "running" {
                    busy = true
                    turnIdle = false
                } else if event.data?.state == "idle" {
                    turnIdle = true
                }
                break
            }
            turnProgress?.receive(event)
            if event.code == "turn_usage" { break }
            if event.code == "rate_limit" {
                if let machineId = active?.machineId {
                    rateLimitNotices.receive(event.data, machineId: machineId)
                }
                // Exhaustion explains a stopped turn and stays in the transcript,
                // just as on web. Approaching the limit belongs above the composer.
                if event.data?.status == "rejected" {
                    let text = RateLimitNotice(data: event.data)?.message ?? event.text ?? "Лимит подписки исчерпан"
                    withLines { lines in
                        let turn = lines[(lines.lastIndex { $0.kind == .user && !$0.replayPending } ?? lines.startIndex)...]
                        if !turn.contains(where: { $0.code == "rate_limit" && $0.text == text }) {
                            TranscriptUpdates.appendWire(TranscriptLine(id: nextId(), kind: .status, text: text, code: "rate_limit"), to: &lines)
                        }
                    }
                }
                if replayStage != nil { scheduleReplayCommit() }
                break
            }
            switch event.code {
            case "compact_started":
                compactionState = .running
                watchCompaction(runId: runId)
            case "compact_done":
                compactionTimeout?.cancel()
                compactionState = .completed
            case "compact_failed":
                compactionTimeout?.cancel()
                compactionState = .failed
            default: break
            }
            if ["compact_started", "compact_done", "compact_failed"].contains(event.code ?? "") {
                let id = nextId()
                withLines { TranscriptUpdates.compaction(&$0, id: id, event: event) }
                if replayStage != nil { scheduleReplayCommit() }
                break
            }
            switch event.kind {
            case .partial:
                let text = event.text ?? ""
                let id = nextId()
                withLines { lines in
                    if let index = TranscriptUpdates.wireTail(lines), lines[index].kind == .assistant, lines[index].streaming {
                        lines[index].text += text
                    } else {
                        TranscriptUpdates.appendWire(TranscriptLine(id: id, kind: .assistant, text: text, streaming: true,
                                                    ts: Date().timeIntervalSince1970 * 1000), to: &lines)
                    }
                }
                if !text.isEmpty { hasCurrentAssistantLines = true }
            case .assistant:
                // Claude streams the reply as `partial` deltas and repeats the
                // whole block here, so a streaming tail just takes the final
                // text. Codex has no delta channel — this event IS its reply,
                // and dropping it left a Codex session showing its commands and
                // then nothing, which reads as a hung session.
                var finalized = false
                withLines { lines in
                    guard let index = TranscriptUpdates.wireTail(lines), lines[index].kind == .assistant, lines[index].streaming else { return }
                    var last = lines[index]
                    last.text = event.text ?? last.text
                    last.streaming = false
                    lines[index] = last
                    finalized = true
                }
                if !finalized, let text = event.text, !text.isEmpty {
                    addLine(.assistant, text)
                }
                if let text = event.text, !text.isEmpty { hasCurrentAssistantLines = true }
            case .result:
                busy = false
                withLines { TranscriptUpdates.closeLiveImageGen(&$0) }
                withLines { lines in
                    guard let index = TranscriptUpdates.wireTail(lines), lines[index].kind == .assistant, lines[index].streaming else { return }
                    var last = lines[index]
                    last.streaming = false
                    lines[index] = last
                }
                flushOutbox()
            default:
                // The code travels with the line: it is what tells a refused
                // tool or a CLI notice (machinery, folded into the gear) from a
                // status the person must read.
                let kind = TranscriptLine.Kind(rawValue: event.kind.rawValue) ?? .status
                addLine(kind, event.text ?? "", code: event.code,
                        toolUseId: kind == .tool_use ? event.data?.id : nil)
            }
            if replayStage != nil { scheduleReplayCommit() }

        case let .toolRequest(runId, _, requestId, tool, input, title):
            guard runId == active?.runId else { break }
            toolReq = ToolRequest(runId: runId, requestId: requestId, tool: tool, input: input, title: title)
            onToolRequest?()

        case let .runMode(runId, _, mode):
            guard runId == active?.runId else { break }
            permissionMode = mode

        case let .runSettings(runId, _, model, activeModel, effort, ultracode):
            guard runId == active?.runId else { break }
            runSettings = RunSettingsInfo(model: model, activeModel: activeModel,
                                          effort: effort, ultracode: ultracode)
            if let active, let runSettings {
                sessionSettings.remember(runSettings, machineId: active.machineId, sessionId: active.sessionId)
            }
            advanceModelChange()

        case let .contextUsage(runId, _, total, max, pct, threshold, autoOn):
            guard runId == active?.runId else { break }
            contextUsage = ContextUsageInfo(totalTokens: total, maxTokens: max, percentage: pct,
                                            autoCompactThreshold: threshold, autoCompactEnabled: autoOn)

        case let .runStatus(runId, _, state, error):
            guard runId == active?.runId else { break }
            switch state {
            case .started:
                busy = true
                hasCurrentAssistantLines = false
                addLine(.status, "session resumed")
            case .idle:
                busy = false
                flushOutbox()
            default:
                busy = false
                attachedRunId = nil
                active = nil
                outbox.removeAll()   // the run is gone; don't send queued messages into the void
                if state == .yielded {
                    flashError(error ?? "Session opened in the editor — handed back to avoid a conflict.", ms: 9000)
                }
                addLine(.status, "run \(state.rawValue)\(error.map { ": \($0)" } ?? "")")
            }

        case let .rpcResponse(requestId, ok, result, error):
            if ok { pendingRpc.resolve(id: requestId, value: result ?? .null) }
            else { pendingRpc.reject(id: requestId, error: ClientError.rpc(error ?? "rpc failed")) }

        case let .termOpened(termId, _):
            if let handle = termOpens.context(for: termId) {
                termOpens.resolve(id: termId, value: handle)
            }
        case let .termData(termId, data):
            termSubs[termId]?.onData(data)
        case let .termExit(termId, code):
            let s = termSubs.removeValue(forKey: termId)
            s?.onExit(code)

        case let .mirrorOpened(mirrorId, _):
            if let handle = mirrorOpens.context(for: mirrorId) {
                mirrorOpens.resolve(id: mirrorId, value: handle)
            }
        case let .mirrorData(mirrorId, replace, messages):
            mirrorSubs[mirrorId]?.sink(replace, messages)
        case let .mirrorExit(mirrorId):
            let s = mirrorSubs.removeValue(forKey: mirrorId)
            s?.onExit?()

        case let .error(message):
            if isChangingModel { finishModelChange() }
            busy = false
            if message.range(of: "run not found", options: .caseInsensitive) != nil, let a = active {
                attachedRunId = nil
                active = ActiveRun(runId: nil, machineId: a.machineId, sessionId: a.sessionId)
            }
            // "Session already has an active run." — the hub holds a run we have no
            // runId for, so `close` is not an option. Record the address; the chat
            // offers `endSession` as the way out instead of a dead-end toast.
            if message.range(of: "already has an active run", options: .caseInsensitive) != nil,
               let a = active, !a.sessionId.isEmpty {
                blockedSession = SessionRef(machineId: a.machineId, sessionId: a.sessionId)
                // The optimistic user line belongs to a turn that never started.
                if let last = lines.last, last.kind == .user { lines.removeLast() }
            }
            flashError(message)

        case let .sessionReads(reads):
            if viewer == nil { earlyReads.append(contentsOf: reads) } else { applySessionReads(reads) }

        case let .sessionCompletions(list):
            if viewer == nil { earlyCompletions.append(contentsOf: list) } else { completionReads.applyCompletions(list) }

        case .unknown:
            break
        }
    }

    // MARK: Activity reconciliation (board + re-attach + notifications)

    private func ingestActivity(_ rawRuns: [ActiveRunInfo]) {
        let previousPhase = activeRuns.first { $0.runId == active?.runId }.map { $0.taskStartedAt ?? $0.since }
        let runs = rawRuns.map { run -> ActiveRunInfo in
            guard let title = run.title else { return run }
            var r = run
            r.title = cleanedTitle(title)
            return r
        }
        completionReads.ingest(runs, viewerId: viewer?.userId)
        // The fleet's runs arrive on every activity frame; an unchanged list
        // must not wake every reader of `activeRuns`.
        if activeRuns != runs { activeRuns = runs }
        // The chat on screen finished a turn, asks something or failed: the
        // person sees it, so every device's bell may drop it (throttled).
        // Only on a change of that run's phase: `activity` arrives for every run
        // of the fleet, and re-announcing an unchanged phase is just traffic.
        if let key = completionReads.visibleSession,
           let run = runs.first(where: { "\($0.machineId)::\($0.sessionId)" == key
                                         && [.idle, .needs_attention, .error].contains($0.state) }) {
            let phase = "\(run.state.rawValue)|\(run.since)"
            if readAnnouncedPhase[key] != phase {
                readAnnouncedPhase[key] = phase
                announceRead(key)
            }
        }
        // Attach the focused run to this socket after every reconnect.
        if let cur = active {
            // Prefer runId because a new session may learn its real sessionId
            // while iOS has the app suspended in the background.
            let match0 = cur.runId.flatMap { id in
                runs.first { $0.runId == id && Self.attachable($0.state) }
            } ?? runs.first {
                cur.runId == nil && $0.machineId == cur.machineId &&
                $0.sessionId == cur.sessionId && Self.attachable($0.state)
            }
            // The phone's own record says which machine this run is on; a hub run list that
            // puts it elsewhere cannot move it when a private machine is involved.
            let moved = match0.map { $0.machineId != cur.machineId && (isPrivateMachine($0.machineId) || isPrivateMachine(cur.machineId)) } ?? false
            let match = moved ? nil : match0
            if let match {
                activeState = match.state
                if attachedRunId != match.runId {
                    // The phone's record keeps a private run where it was opened; an ordinary
                    // run takes the hub's word, as it always did.
                    let privateRun = isPrivateMachine(cur.machineId) || isPrivateMachine(match.machineId)
                    active = ActiveRun(runId: match.runId, machineId: privateRun ? cur.machineId : match.machineId,
                                       sessionId: match.sessionId)
                    // Re-subscribe replays cumulative usage snapshots. Clear the
                    // reading until replay arrives, retaining this turn’s clock.
                    let start = previousPhase == (match.taskStartedAt ?? match.since) ? turnProgress?.startedAt : nil
                    if start == nil { turnProgress = nil }
                    reconcileProgress(match)
                    if let progress = turnProgress {
                        turnProgress = TurnProgress(startedAt: start ?? progress.startedAt)
                    }
                    if send(.subscribe(runId: match.runId), quiet: true) {
                        attachedRunId = match.runId
                        forgetBackground()
                    }
                    // A turn that ran (or ended) while this client was away left the
                    // last streamed line dangling mid-sentence; close it so the chat
                    // stops looking frozen, and let the view re-read the transcript.
                    closeDanglingLine()
                    flushOutbox()
                } else {
                    reconcileProgress(match)
                }
            } else if cur.runId != nil {
                // The run reached a terminal state while the app was suspended.
                active = ActiveRun(runId: nil, machineId: cur.machineId, sessionId: cur.sessionId)
                attachedRunId = nil
                activeState = nil
                busy = false
                toolReq = nil
                closeDanglingLine()
            }
        }
        notifs.ingest(runs, focusedRunId: active?.runId, nextId: { self.nextId() })
    }

    /// Runs whose hub-side record is still real. `error` is deliberately included:
    /// such a run keeps the single-writer lock until someone closes it, so the app
    /// must attach and offer that exit instead of pretending the run is gone (that
    /// left the session unopenable — the hub answers every `open` with
    /// "Session already has an active run.").
    private static func attachable(_ state: AttentionState) -> Bool {
        state == .working || state == .needs_attention || state == .idle || state == .error
    }

    private func reconcileProgress(_ run: ActiveRunInfo) {
        if run.state == .working || run.state == .needs_attention {
            if let stamp = run.taskStartedAt, stamp.isFinite, stamp > 0 {
                let start = min(Date(timeIntervalSince1970: stamp / 1000), Date())
                if turnProgress == nil { turnProgress = TurnProgress(startedAt: start) }
                else { turnProgress?.setStartedAt(start) }
            } else if turnProgress == nil {
                // `since` dates the current working phase, not session creation.
                // A permission resume must not reset a clock already observed.
                let now = Date()
                let since = run.since.isFinite && run.since > 0
                    ? min(Date(timeIntervalSince1970: run.since / 1000), now) : now
                turnProgress = TurnProgress(startedAt: since)
            }
            busy = true
        } else if run.state != .needs_attention {
            busy = false
        }
    }

    private func suspendProgress() {
        let saved = turnProgress
        busy = false
        turnProgress = saved
    }

    /// States whose `subscribe` is answered with the current turn's replay
    /// window — the hub clears it on `run_idle`.
    static func replaysTurn(_ state: AttentionState?) -> Bool {
        state == .working || state == .needs_attention
    }

    /// The unanswered tail survives even if the hub has not accepted it yet.
    /// Confirmed turns merge back into the replay at their wire position.
    static func keepUnansweredTail(_ lines: [TranscriptLine]) -> [TranscriptLine] {
        var start = lines.endIndex
        while start > lines.startIndex, lines[start - 1].kind == .user { start -= 1 }
        return Array(lines[start...])
    }

    /// Finalize a partially-streamed assistant line left over from a socket the OS
    /// killed mid-turn.
    private func closeDanglingLine() {
        commitReplay()
        guard let index = TranscriptUpdates.wireTail(lines), lines[index].kind == .assistant, lines[index].streaming else { return }
        var last = lines[index]
        last.streaming = false
        lines[index] = last
    }

    // MARK: Session lifecycle (public API — ports useCentral methods)

    @discardableResult
    public func open(machineId: String, sessionId: String, message: String? = nil, images: [ImageAttachment] = []) -> Bool {
        let imgs = images.isEmpty ? nil : images
        guard send(.open(machineId: machineId, sessionId: sessionId, message: message, images: imgs)) else { return false }
        lines = []
        attachedRunId = nil
        active = ActiveRun(runId: nil, machineId: machineId, sessionId: sessionId)
        let hasText = !(message?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        busy = hasText || !images.isEmpty
        if hasText || !images.isEmpty { addLine(.user, message ?? "", images: images) }
        return true
    }

    /// Start a brand-new session in `cwd` on a machine. The run binds via the
    /// empty-id `opened`; the real session id arrives later via `session_started`.
    ///
    /// `model` / `effort` / `permissionMode` are the start-screen picks. They are
    /// advisory — the hub drops what a machine cannot honour rather than
    /// refusing the start — so passing a stale pick can never cost a session.
    @discardableResult
    public func newSession(machineId: String, cwd: String, message: String?, images: [ImageAttachment] = [],
                    category: SessionCategory? = nil, source: String? = nil,
                    model: String? = nil, effort: EffortLevel? = nil,
                    permissionMode: PermissionMode? = nil) -> Bool {
        let imgs = images.isEmpty ? nil : images
        guard send(.newSession(machineId: machineId, cwd: cwd, message: message, images: imgs,
                               category: category, source: source,
                               model: model, effort: effort,
                               permissionMode: permissionMode)) else { return false }
        lines = []
        outbox.removeAll()
        attachedRunId = nil
        active = ActiveRun(runId: nil, machineId: machineId, sessionId: "")
        let hasText = !(message?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        busy = hasText || !images.isEmpty
        if hasText || !images.isEmpty { addLine(.user, message ?? "", images: images) }
        return true
    }

    public func takeover(machineId: String, sessionId: String, message: String? = nil) {
        guard send(.takeover(machineId: machineId, sessionId: sessionId, message: message)) else { return }
        lines = []
        attachedRunId = nil
        active = ActiveRun(runId: nil, machineId: machineId, sessionId: sessionId)
        busy = true
        if let message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { addLine(.user, message) }
    }

    /// Attach the chat view to a session: subscribe to its live run if one exists,
    /// otherwise leave it dormant (composer will `open` on first send).
    public func focusSession(machineId: String, sessionId: String) {
        notifs.dismiss(machineId: machineId, sessionId: sessionId)
        let prev = active?.runId
        // Re-focusing the SAME session happens after every reconnect; queued
        // follow-ups AND the streamed lines belong to it and must survive — the
        // lines are the only copy of text streamed before the gap until a fresh
        // history read supersedes them (the view clears them once caught up).
        // Only a real session switch starts from a clean slate.
        let sameSession = active?.machineId == machineId && active?.sessionId == sessionId
        // Already DRIVING this session: keep the attachment whole. A brand-new
        // session lands here the moment `session_started` names it — `activeRuns`
        // still carries that run under its empty session id, so the lookup below
        // misses, and the miss unsubscribes our own live run and drops the view
        // to the dormant "Resume" composer while the run is still going.
        if sameSession, active?.runId != nil { return }
        let run = activeRuns.first { $0.machineId == machineId && $0.sessionId == sessionId }
        if !sameSession {
            // Session to session (drawer, a push for another chat) never goes
            // through `unfocus`: the next screen focuses before the last one
            // disappears.
            if let cur = active, let runId = cur.runId, Self.replaysTurn(activeState) {
                parkLines(machineId: cur.machineId, sessionId: cur.sessionId, runId: runId)
            }
            lines = unparkLines(machineId: machineId, sessionId: sessionId, run: run) ?? []
            hasCurrentAssistantLines = false
            outbox.removeAll()
        }
        busy = false
        toolReq = nil
        blockedSession = nil
        if let prev, prev != run?.runId {
            // Auto-recovery plumbing, not a user action — never toast about it;
            // the next snapshot's `ingestActivity` re-attaches if this send loses.
            send(.unsubscribe(runId: prev), quiet: true)
            if attachedRunId == prev { attachedRunId = nil }
        }
        if let run, Self.attachable(run.state) {
            active = ActiveRun(runId: run.runId, machineId: machineId, sessionId: sessionId)
            rememberRunMachine(run.runId, machineId)
            activeState = run.state
            reconcileProgress(run)
            if send(.subscribe(runId: run.runId), quiet: true) {
                attachedRunId = run.runId
                forgetBackground()
            }
        } else {
            attachedRunId = nil
            activeState = nil
            active = ActiveRun(runId: nil, machineId: machineId, sessionId: sessionId)
        }
    }

    private func parkLines(machineId: String, sessionId: String, runId: String) {
        let key = "\(machineId)::\(sessionId)"
        // What is on screen; a replay still being assembled is only a prefix,
        // so it is taken only when nothing is shown yet.
        let shown = !lines.isEmpty ? lines : replayStage.map {
            TranscriptUpdates.finishReplay(lines: $0.lines, echoes: $0.echoes, pendingIDs: $0.pendingEchoIDs)
        } ?? []
        guard !shown.isEmpty else { return }
        let phase = activeRuns.first { $0.runId == runId }.map { $0.taskStartedAt ?? $0.since }
        parkedLines[key] = ParkedLines(runId: runId, phase: phase, lines: shown)
        parkedOrder.removeAll { $0 == key }
        parkedOrder.append(key)
        while parkedOrder.count > Self.parkedCapacity { parkedLines[parkedOrder.removeFirst()] = nil }
    }

    /// The parked lines of this session, if its run is the one they came from
    /// and that run still replays its turn. Taken either way: a stale copy is
    /// never offered twice.
    private func unparkLines(machineId: String, sessionId: String, run: ActiveRunInfo?) -> [TranscriptLine]? {
        let key = "\(machineId)::\(sessionId)"
        guard let parked = parkedLines.removeValue(forKey: key) else { return nil }
        parkedOrder.removeAll { $0 == key }
        guard let run, run.runId == parked.runId, Self.replaysTurn(run.state),
              let phase = parked.phase, phase == (run.taskStartedAt ?? run.since) else { return nil }
        return parked.lines
    }

    /// Leaving a session detail: unsubscribe (the run keeps running) but keep no focus.
    public func unfocus() {
        if let cur = active, let runId = cur.runId, Self.replaysTurn(activeState) {
            parkLines(machineId: cur.machineId, sessionId: cur.sessionId, runId: runId)
        }
        if let runId = active?.runId { send(.unsubscribe(runId: runId), quiet: true) }
        attachedRunId = nil
        active = nil
        lines = []
        busy = false
        toolReq = nil
        outbox.removeAll()
    }

    /// Returns whether the turn was accepted (delivered now, or queued to flush on
    /// idle). false means it could not be sent — callers should KEEP the draft +
    /// attachments so the user can retry rather than silently lose them.
    @discardableResult
    public func sendInput(_ text: String, images: [ImageAttachment] = []) -> Bool {
        guard !isChangingModel else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!trimmed.isEmpty || !images.isEmpty), active?.runId != nil else { return false }
        // A busy run takes input DIRECTLY — the runtime folds it into the
        // conversation (Claude Code queues it as the next user turn itself),
        // exactly as the web composer does. The client-side outbox queued
        // messages until idle, which read as "my message went to a waiting
        // room"; it remains only as the flush path for legacy queued items.
        return deliverInput(trimmed, images: images)
    }

    @discardableResult
    private func deliverInput(_ text: String, images: [ImageAttachment] = []) -> Bool {
        guard let runId = active?.runId else { return false }
        guard send(.input(runId: runId, text: text, images: images.isEmpty ? nil : images)) else { return false }
        addLine(.user, text, images: images)
        busy = true
        return true
    }

    /// Send the next queued message once the run is idle and still focused.
    private func flushOutbox() {
        guard canUseAI, !isChangingModel, !busy, active?.runId != nil, !outbox.isEmpty else { return }
        let next = outbox.removeFirst()
        deliverInput(next.text, images: next.images)
    }

    public func removeQueued(_ id: Int) { outbox.removeAll { $0.id == id } }
    public func clearOutbox() { outbox.removeAll() }

    // MARK: Offline outbox (persistent)

    public func legacyPendingCount() throws -> Int {
        try OfflineOutboxStore(directory: storage.root).load().count
    }

    /// Only after the person assigns the old unscoped queue to this account.
    public func recoverLegacyPending() throws {
        guard viewer != nil, storageScope.hasPrefix("account-"), let durableOutbox else {
            throw ClientError.connectionClosed
        }
        let file = storage.root.appendingPathComponent("PendingMessages.json")
        if FileManager.default.fileExists(atPath: file.path) {
            let backup = storage.root.appendingPathComponent("PendingMessages.pre-account-backup.json")
            if !FileManager.default.fileExists(atPath: backup.path) {
                try FileManager.default.copyItem(at: file, to: backup)
            }
        }
        try PersistentOutbox(directory: storage.root).transfer(to: durableOutbox)
        flushPending()
    }

    /// Keep a message the connection could not take. It goes to disk immediately —
    /// the whole point is surviving whatever killed the connection, including the
    /// app being killed with it.
    @discardableResult
    public func queuePending(machineId: String, sessionId: String, text: String,
                             images: [ImageAttachment] = []) -> Bool {
        guard canUseAI else { aiConsentRequested = true; return false }
        if isPrivateMachine(machineId) {
            flashError("Эта машина зашифрована: сообщение не ставится в очередь на телефоне — отправьте, когда она в сети.")
            return false
        }
        guard let durableOutbox else { return false }
        do {
            try durableOutbox.append(PendingMessage(machineId: machineId, sessionId: sessionId,
                                                    text: text, images: images.map(PendingImage.init)))
            return true
        } catch {
            flashError("Не удалось сохранить сообщение: \(error.localizedDescription)")
            return false
        }
    }

    public func removePending(_ id: UUID) {
        do { try durableOutbox?.remove(id) }
        catch { flashError("Не удалось изменить очередь: \(error.localizedDescription)") }
    }

    public func pendingFor(machineId: String, sessionId: String) -> [PendingMessage] {
        pending.filter { $0.machineId == machineId && $0.sessionId == sessionId }
    }

    /// Snapshot/activity makes destinations reachable. The durable owner keeps
    /// messages until transport completion (input) or the hub's opened reply.
    /// The wire has no input ack/idempotency key: a disconnect after acceptance
    /// can still cause a retry, which requires a protocol change to eliminate.
    private func flushPending() {
        guard canUseAI, role == .primary, status == .open, let queue = durableOutbox else { return }
        var visited = Set<String>()
        for msg in queue.messages {
            if let change = modelChange, change.machineId == msg.machineId,
               change.sessionId == msg.sessionId { continue }
            let key = "\(msg.machineId)::\(msg.sessionId)"
            guard visited.insert(key).inserted,
                  let snap = allMachines.first(where: { $0.machine.machineId == msg.machineId }),
                  snap.online else { continue }
            // An open may already have started this run. Wait for its ack before
            // treating the first message as fresh input from an activity frame.
            let run = activeRuns.first { $0.machineId == msg.machineId && $0.sessionId == msg.sessionId }
            if let run, Self.attachable(run.state) {
                guard run.state != .error, !queue.isOpening(machine: msg.machineId, session: msg.sessionId),
                      queue.beginInput(msg.id) else { continue }
                let images = msg.images.compactMap(\.attachment)
                let focused = active?.machineId == msg.machineId && active?.sessionId == msg.sessionId
                let message = ClientMessage.input(runId: run.runId, text: msg.text,
                                                  images: images.isEmpty ? nil : images)
                let accepted = send(message, completion: { [weak self, weak queue] error in
                    guard let self, let queue else { return }
                    do { try queue.finishInput(msg.id, delivered: error == nil) }
                    catch {
                        self.flashError("Не удалось сохранить очередь: \(error.localizedDescription)")
                        return
                    }
                    if error == nil { self.flushPending() }
                })
                if accepted && focused {
                    addLine(.user, msg.text, images: images)
                    busy = true
                }
                if !accepted { try? queue.finishInput(msg.id, delivered: false) }
                continue
            }
            guard snap.sessions.contains(where: { $0.sessionId == msg.sessionId }), queue.beginOpen(msg) else { continue }
            let images = msg.images.compactMap(\.attachment)
            let focused = active?.machineId == msg.machineId && active?.sessionId == msg.sessionId
            let accepted = focused
                ? open(machineId: msg.machineId, sessionId: msg.sessionId, message: msg.text, images: images)
                : send(.open(machineId: msg.machineId, sessionId: msg.sessionId, message: msg.text,
                             images: images.isEmpty ? nil : images), quiet: true)
            if !accepted { queue.failOpen(machine: msg.machineId, session: msg.sessionId) }
        }
    }

    /// Не чаще раза в 30 с, но без потерь: изменение внутри окна сохраняется
    /// догоняющей записью в его конце, а уход в фон пишет сразу (`force`) —
    /// иначе последние полминуты перед выгрузкой приложения пропадали из кэша.
    private func saveFleetSnapshot(force: Bool = false) {
        guard role == .primary, !fleetIsCached else { return }
        if !force, let last = lastFleetSaveAt {
            let wait = 30 - Date().timeIntervalSince(last)
            if wait > 0 {
                guard fleetSaveCatchUp == nil else { return }
                fleetSaveCatchUp = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(wait))
                    guard let self, !Task.isCancelled else { return }
                    self.fleetSaveCatchUp = nil
                    self.saveFleetSnapshot()
                }
                return
            }
        }
        fleetSaveCatchUp?.cancel(); fleetSaveCatchUp = nil
        lastFleetSaveAt = Date()
        // Decrypted titles and folders of a private machine are not parked on disk.
        fleetStore?.save(allMachines.map { snap in
            guard isPrivateMachine(snap.machine.machineId) else { return snap }
            // Kept (so a cold-launched push reply knows the machine is private) but empty.
            var kept = snap
            kept.machine.private = true
            kept.sessions = []
            kept.usage = nil; kept.codexUsage = nil; kept.profile = nil; kept.stats = nil
            return kept
        }, viewerId: viewer?.userId)
    }

    private func confirmPendingOpen(machineId: String, sessionId: String) {
        do { try durableOutbox?.confirmOpen(machine: machineId, session: sessionId) }
        catch { flashError("Не удалось сохранить очередь: \(error.localizedDescription)") }
    }

    /// Drop the live buffer once history demonstrably contains the same turn.
    public func clearLines() { lines = [] }

    public func interrupt() {
        if let runId = active?.runId { send(.interrupt(runId: runId)) }
    }

    /// No optimistic retry: a timeout cannot prove the runtime never received it.
    public func compact() {
        guard canUseAI else { aiConsentRequested = true; return }
        guard status == .open, let runId = active?.runId,
              !compactionState.pending else { return }
        compactionState = .requested
        watchCompaction(runId: runId)
        send(.compact(runId: runId)) { [weak self] error in
            guard let self, error != nil, self.active?.runId == runId,
                  self.compactionState == .requested else { return }
            self.compactionTimeout?.cancel()
            self.compactionState = .failed
        }
    }

    private func resetCompaction() {
        compactionTimeout?.cancel()
        compactionTimeout = nil
        compactionState = .idle
    }

    private func watchCompaction(runId: String) {
        compactionTimeout?.cancel()
        compactionTimeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(15 * 60)) } catch { return }
            guard let self, self.active?.runId == runId, self.compactionState.pending else { return }
            self.compactionState = .failed
            self.flashError("Не удалось подтвердить сжатие контекста. Проверьте сессию.")
        }
    }

    /// Stop the live run. Pass a `runId` to close a run the view can see in the
    /// activity feed but this client never attached to; without one the focused
    /// run is closed. Keeps the session address so the chat stays put and can
    /// resume, unlike `unfocus`.
    public func closeRun(runId: String? = nil) {
        let target = runId ?? active?.runId
        if let target { send(.close(runId: target)) }
        attachedRunId = nil
        activeState = nil
        busy = false
        toolReq = nil
        outbox.removeAll()
        if let a = active, !a.sessionId.isEmpty {
            active = ActiveRun(runId: nil, machineId: a.machineId, sessionId: a.sessionId)
        } else {
            active = nil
        }
    }

    /// Ask the hub to end a session outright: it closes an active cc-remote run,
    /// or tells the agent to terminate an external editor writer. This is the only
    /// exit from a session whose run still holds the single-writer lock but is not
    /// reachable as `active` — see `blockedSession`.
    public func endSession(machineId: String, sessionId: String) {
        guard send(.endSession(machineId: machineId, sessionId: sessionId)) else { return }
        blockedSession = nil
        if let a = active, a.machineId == machineId, a.sessionId == sessionId {
            attachedRunId = nil
            activeState = nil
            busy = false
            toolReq = nil
            outbox.removeAll()
            active = ActiveRun(runId: nil, machineId: machineId, sessionId: sessionId)
        }
        // The inventory still lists the old livePid/run until the agent re-reports.
        rescan(machineId: machineId)
    }

    public func clearBlockedSession() { blockedSession = nil }

    /// Kanban stage for the Flow board (hub-persisted, control-gated).
    public func setStage(machineId: String, sessionId: String, stage: String?) {
        send(.setStage(machineId: machineId, sessionId: sessionId, stage: stage))
    }

    public func decideTool(allow: Bool, updatedInput: JSONValue? = nil,
                    permissionMode: PermissionMode? = nil, message: String? = nil) {
        guard let req = toolReq else { return }
        let decision = ClientMessage.toolDecision(runId: req.runId, requestId: req.requestId, allow: allow,
                                                  updatedInput: updatedInput, permissionMode: permissionMode, message: message)
        guard send(decision, completion: { [weak self] error in
            guard let self else { return }
            if error != nil { self.flashError("Решение не отправлено. Попробуйте ещё раз.") }
            else if self.toolReq?.requestId == req.requestId { self.toolReq = nil }
        }) else {
            flashError("Нет связи. Решение ещё не отправлено.")
            return
        }
    }

    /// Answer a tool approval identified by a push notification (from the lock
    /// screen / Notification Center). If the live socket is up, ride it; otherwise
    /// the app was woken in the background — fire a one-shot connection just to
    /// deliver the decision. `route_to_agent` resolves the run by `runId`, so no
    /// subscription is needed and we never become a subscriber that could close it.
    public func decidePush(runId: String, requestId: String, allow: Bool, message: String? = nil,
                           endpoint: String, token: String) {
        guard canUseAI else { aiConsentRequested = true; return }
        // A one-shot connection cannot seal: a private machine's answer waits for the app.
        // Quick actions are off for a private machine: the decision must be sealed in the app.
        guard pushMayLeaveInClear(runId: runId) else {
            flashError("Эта машина зашифрована: ответьте на запрос в приложении."); return
        }
        if status == .open {
            send(.toolDecision(runId: runId, requestId: requestId, allow: allow,
                               updatedInput: nil, permissionMode: nil, message: message), quiet: true,
                 completion: { [weak self] error in
                guard let self else { return }
                if error != nil { self.flashError("Не удалось отправить решение из уведомления.") }
                else if self.toolReq?.requestId == requestId { self.toolReq = nil }
            })
            return
        }
        let decision = ClientMessage.toolDecision(runId: runId, requestId: requestId, allow: allow,
                                                  updatedInput: nil, permissionMode: nil, message: message)
        pushDecisions.send(decision, endpoint: endpoint, token: token, workspace: workspaceId) { [weak self] error in
            self?.log.error("push approval failed: \(String(describing: error))")
            self?.flashError("Не удалось отправить решение из уведомления.")
        }
    }

    /// A text reply typed into a notification action on a push that carries no
    /// action token (WATCH.md §6 fallback). Same routing as `decidePush`: the live
    /// socket when there is one, else a one-shot connection that only delivers it.
    public func replyPush(runId: String, text: String, endpoint: String, token: String) {
        guard canUseAI else { aiConsentRequested = true; return }
        guard pushMayLeaveInClear(runId: runId) else {
            flashError("Эта машина зашифрована: ответьте в приложении."); return
        }
        let message = ClientMessage.input(runId: runId, text: text, images: nil)
        if status == .open {
            send(message, quiet: true, completion: { [weak self] error in
                if error != nil { self?.flashError("Не удалось отправить ответ из уведомления.") }
            })
            return
        }
        pushDecisions.send(message, endpoint: endpoint, token: token, workspace: workspaceId) { [weak self] error in
            self?.log.error("push reply failed: \(String(describing: error))")
            self?.flashError("Не удалось отправить ответ из уведомления.")
        }
    }

    public func rescan(machineId: String) { send(.rescan(machineId: machineId), quiet: true) }
    public func setModel(runId: String, model: String?) { send(.setModel(runId: runId, model: model)) }

    /// An explicit picker action can resume a dormant session WITHOUT input.
    /// Wait for runtime settings before sending the control, and for its
    /// readback before allowing the first message. No new wire contract needed.
    @discardableResult
    public func changeSessionModel(machineId: String, sessionId: String, model: String?) -> Bool {
        guard status == .open, !isChangingModel,
              active?.machineId == machineId, active?.sessionId == sessionId,
              activeState != .error,
              !pending.contains(where: { $0.machineId == machineId && $0.sessionId == sessionId })
        else { return false }
        let change = ModelChange(machineId: machineId, sessionId: sessionId, model: ModelLabel.explicit(model))
        modelChange = change
        modelChangeTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(25))
            guard !Task.isCancelled, let self, self.modelChange?.id == change.id else { return }
            self.finishModelChange(error: "Модель не подтвердила переключение. Проверьте выбор и повторите.")
        }
        if active?.runId == nil {
            if !open(machineId: machineId, sessionId: sessionId) {
                finishModelChange(error: "Не удалось подключиться к сессии.")
                return false
            }
        } else if runSettings != nil {
            advanceModelChange()
        }
        return true
    }

    private func advanceModelChange() {
        guard var change = modelChange, let active, let runId = active.runId,
              active.machineId == change.machineId, active.sessionId == change.sessionId,
              let runSettings else { return }
        if change.runId != nil {
            guard change.runId == runId, ModelLabel.explicit(runSettings.model) == change.model else { return }
            finishModelChange()
            flushPending()
            flushOutbox()
            return
        }
        // The agent publishes only changed settings. Re-selecting the current
        // pin (including account default) has no new ack to wait for.
        if ModelLabel.explicit(runSettings.model) == change.model {
            finishModelChange()
            flushPending()
            flushOutbox()
            return
        }
        change.runId = runId
        modelChange = change
        let id = change.id
        let sent = send(.setModel(runId: runId, model: change.model)) { [weak self] error in
            guard let self, error != nil, self.modelChange?.id == id else { return }
            self.finishModelChange(error: "Не удалось отправить выбор модели.")
        }
        if !sent { finishModelChange(error: "Нет связи с сессией.") }
    }

    private func finishModelChange(error: String? = nil) {
        modelChangeTimeout?.cancel()
        modelChangeTimeout = nil
        modelChange = nil
        if let error { flashError(error) }
    }
    public func setPermissionMode(runId: String, mode: PermissionMode) { send(.setPermissionMode(runId: runId, mode: mode)) }
    public func setEffort(runId: String, effort: EffortLevel?, ultracode: Bool = false) {
        send(.setEffort(runId: runId, effort: effort, ultracode: ultracode))
    }

    /// Store + send the APNs device token so the hub can push to this device.
    /// `.primary` only — a pane registering would double every push.
    public func registerPush(deviceToken: String) {
        guard role == .primary else { return }
        pushToken = deviceToken
        send(.registerPush(deviceToken: deviceToken, platform: "ios"), quiet: true)
    }

    public func runFor(machineId: String, sessionId: String) -> ActiveRunInfo? {
        activeRuns.first { $0.machineId == machineId && $0.sessionId == sessionId }
    }

    // MARK: Memory (id-correlated, same shape as RPC but hub-answered)

    /// Every memory the viewer owns, across all scopes — metadata only.
    public func memoryList() async throws -> [MemoryEntry] {
        let requestId = UUID().uuidString.lowercased()
        return try await memoryLists.wait(
            id: requestId,
            context: (),
            timeoutError: ClientError.rpc("memory_list timeout"),
            startError: ClientError.connectionClosed
        ) {
            send(.memoryList(requestId: requestId))
        }
    }

    /// One memory's body. A tombstoned/absent note throws rather than
    /// returning an empty string, so the UI can say "gone".
    public func memoryRead(scope: MemoryScope, scopeKey: String, path: String) async throws -> String {
        let requestId = UUID().uuidString.lowercased()
        return try await memoryReads.wait(
            id: requestId,
            context: (),
            timeoutError: ClientError.rpc("memory_read timeout"),
            startError: ClientError.connectionClosed
        ) {
            send(.memoryRead(requestId: requestId, scope: scope, scopeKey: scopeKey, path: path))
        }
    }

    /// Tombstone a memory fleet-wide. Callers refetch the list on success.
    public func memoryDelete(scope: MemoryScope, scopeKey: String, path: String) async throws {
        let requestId = UUID().uuidString.lowercased()
        return try await memoryDeletes.wait(
            id: requestId,
            context: (),
            timeoutError: ClientError.rpc("memory_delete timeout"),
            startError: ClientError.connectionClosed
        ) {
            send(.memoryDelete(requestId: requestId, scope: scope, scopeKey: scopeKey, path: path))
        }
    }

    // MARK: Turn enrichment (hub-answered, id-correlated)

    /// Ask the hub's LLM pass about one assistant turn: decisions, a digest and
    /// conjugated quick replies. `nil` = nothing to add — including a hub with
    /// no gateway, which is remembered so the question is not asked twice. A
    /// thrown error is a busy hub, a dropped socket or a timeout. Callers that
    /// must tell those apart (the suggestion strip) use `enrichState` instead.
    public func enrich(machineId: String, sessionId: String, source: String?,
                       uuid: String, text: String, userText: String? = nil,
                       purpose: String? = nil, digest: String? = nil) async throws -> Enrichment? {
        guard canUseAI, !enrichUnavailable, !text.isEmpty, !isPrivateMachine(machineId) else { return nil }
        switch try await enrichReply(machineId: machineId, sessionId: sessionId, source: source, uuid: uuid,
                                     text: text, userText: userText, purpose: purpose, digest: digest) {
        case .result(let enrichment): return enrichment
        case .notConfigured: return nil
        }
    }

    /// The suggestion strip's question, answered with a STATE rather than an
    /// optional: `success` (possibly empty — the model chose to say nothing),
    /// `failed` (could not be asked or got no answer) or `unavailable` (no
    /// gateway on the hub, or no AI consent). Never `pending` — that is the
    /// caller's state while this call is in flight. `text` is client-truncated
    /// (keep the END — the question lives there); `digest` is `EnrichDigest`.
    public func enrichState(machineId: String, sessionId: String, source: String?,
                            uuid: String, text: String, userText: String? = nil,
                            digest: String? = nil) async -> EnrichState {
        guard canUseAI, !enrichUnavailable, !isPrivateMachine(machineId) else { return .unavailable }
        guard !text.isEmpty else { return .failed }
        do {
            switch try await enrichReply(machineId: machineId, sessionId: sessionId, source: source, uuid: uuid,
                                         text: text, userText: userText, purpose: nil, digest: digest) {
            case .result(let enrichment): return .success(enrichment ?? Enrichment())
            case .notConfigured: return .unavailable
            }
        } catch {
            return .failed
        }
    }

    private func enrichReply(machineId: String, sessionId: String, source: String?,
                             uuid: String, text: String, userText: String?,
                             purpose: String?, digest: String?) async throws -> EnrichReply {
        let requestId = UUID().uuidString.lowercased()
        return try await enrichRequests.wait(
            id: requestId,
            context: (),
            timeoutError: ClientError.rpc("enrich timeout"),
            startError: ClientError.connectionClosed
        ) {
            send(.enrichRequest(requestId: requestId, machineId: machineId, sessionId: sessionId,
                                source: source, uuid: uuid, text: text, userText: userText,
                                purpose: purpose, digest: digest))
        }
    }

    // MARK: RPC (id-correlated, 30s timeout)

    public func rpc(machineId: String, method: String, params: JSONValue) async throws -> JSONValue {
        let requestId = UUID().uuidString.lowercased()
        return try await pendingRpc.wait(
            id: requestId,
            context: (),
            timeoutError: ClientError.rpc("rpc timeout"),
            startError: ClientError.connectionClosed
        ) {
            send(.rpcRequest(requestId: requestId, machineId: machineId, method: method, params: params))
        }
    }

    // MARK: Terminal / Mirror (client-allocated ids)

    public func openTerminal(machineId: String, cwd: String?,
                      onData: @escaping (String) -> Void,
                      onExit: @escaping (Int?) -> Void) async throws -> TerminalHandle {
        let termId = UUID().uuidString.lowercased()
        termSubs[termId] = TermSub(onData: onData, onExit: onExit)
        let handle = TerminalHandle(
            send: { [weak self] d in self?.send(.termInput(termId: termId, data: d)) },
            resize: { [weak self] c, r in self?.send(.termResize(termId: termId, cols: c, rows: r)) },
            close: { [weak self] in
                self?.termSubs.removeValue(forKey: termId)
                self?.send(.termClose(termId: termId), quiet: true)
            }
        )
        return try await termOpens.wait(
            id: termId,
            context: handle,
            timeoutError: ClientError.rpc("terminal open timed out"),
            startError: ClientError.connectionClosed,
            onReject: { [weak self] in self?.termSubs.removeValue(forKey: termId) }
        ) {
            send(.termOpen(termId: termId, machineId: machineId, cwd: cwd))
        }
    }

    public func openMirror(machineId: String, sessionId: String, cwd: String,
                    onData: @escaping (Bool, [HistoryMessage]) -> Void,
                    onExit: (() -> Void)? = nil) async throws -> MirrorHandle {
        let mirrorId = UUID().uuidString.lowercased()
        mirrorSubs[mirrorId] = MirrorSub(sink: onData, onExit: onExit)
        let handle = MirrorHandle(close: { [weak self] in
            self?.mirrorSubs.removeValue(forKey: mirrorId)
            self?.send(.mirrorClose(mirrorId: mirrorId), quiet: true)
        })
        return try await mirrorOpens.wait(
            id: mirrorId,
            context: handle,
            timeoutError: ClientError.rpc("mirror open timed out"),
            startError: ClientError.connectionClosed,
            onReject: { [weak self] in self?.mirrorSubs.removeValue(forKey: mirrorId) }
        ) {
            send(.mirrorOpen(mirrorId: mirrorId, machineId: machineId, sessionId: sessionId, cwd: cwd))
        }
    }
}

public struct TerminalHandle {
    public let send: (String) -> Void
    public let resize: (Int, Int) -> Void
    public let close: () -> Void
}

public struct MirrorHandle {
    public let close: () -> Void
}

public enum ClientError: LocalizedError {
    case connectionClosed
    case rpc(String)
    public var errorDescription: String? {
        switch self {
        case .connectionClosed: return "connection closed"
        case .rpc(let m): return m
        }
    }
}

private extension MachineStats {
    /// Same readings, whatever the sample's timestamp says.
    func sameReading(as other: MachineStats) -> Bool {
        platform == other.platform && cpuCount == other.cpuCount && load1 == other.load1
            && cpuPercent == other.cpuPercent && memTotal == other.memTotal && memUsed == other.memUsed
            && swapTotal == other.swapTotal && swapUsed == other.swapUsed
            && diskTotal == other.diskTotal && diskUsed == other.diskUsed
            && uptimeSec == other.uptimeSec && agentRss == other.agentRss
            && agentCpuPercent == other.agentCpuPercent
    }
}

extension CentralClient {
    /// Queued/unsent messages or a running turn: reconnecting now would drop
    /// in-memory follow-ups and re-scope the durable outbox.
    public var hasPendingWork: Bool {
        !outbox.isEmpty || !pending.isEmpty || busy || turnProgress != nil
    }
}
