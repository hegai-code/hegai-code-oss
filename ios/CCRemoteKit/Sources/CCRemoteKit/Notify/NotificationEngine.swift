import Foundation
import Observation

/// Attention-transition diffing + the in-app notification list. Port of the
/// notification half of `useCentral.ts` (`ingestActivity`, lines 211-278):
/// emit a notification only on a genuine transition into needs_attention/idle/
/// error, for a run that is NOT the currently-focused one, and never on the
/// first activity frame after a (re)connect (`seeded`).
@MainActor
@Observable
public final class NotificationEngine {
    public private(set) var items: [NotifItem] = []
    /// Entries the viewer has not seen yet — counted from the entries
    /// themselves, so one that leaves the bell takes its unread mark with it.
    public var unread: Int { unreadIds.count }
    private var unreadIds: Set<Int> = []

    /// Whether local notifications may fire (mirrors the Settings toggle).
    public var enabled = true

    /// The viewer's own user id, set by the host from the snapshot. `activity`
    /// carries every run this viewer may VIEW — for an admin or anyone holding a
    /// team share that is most of the fleet — so the Inbox is scoped to the runs
    /// they OWN, matching how the hub already scopes APNs pushes (`emit_push`).
    /// Nil means nothing notifies; the snapshot that sets it arrives before the
    /// first activity frame, which `seeded` swallows anyway.
    public var viewerId: String?

    /// A banner the host should raise. The engine decides *whether* and *what*;
    /// the host owns the OS API, which differs per platform.
    public struct Banner: Sendable {
        public let id: String
        public let title: String
        public let body: String
        public let machineId: String
        public let sessionId: String
    }

    /// Set by the host. Nil means no OS-level banners — the in-app Inbox still fills.
    @ObservationIgnored public var postBanner: ((Banner) -> Void)?
    /// Set by the host: is the app frontmost? A banner is pointless if it is.
    @ObservationIgnored public var appIsActive: () -> Bool = { false }

    private var prevRunState: [String: AttentionState] = [:]
    private var seeded = false

    /// States worth a notification when a run transitions into them.
    private static let notify: Set<AttentionState> = [.needs_attention, .idle, .error]

    public func resetSeed() {
        seeded = false
        prevRunState = [:]
    }

    public func ingest(_ runs: [ActiveRunInfo], focusedRunId: String?, nextId: () -> Int) {
        var next: [String: AttentionState] = [:]
        var fresh: [NotifItem] = []
        for r in runs {
            next[r.runId] = r.state
            let prev = prevRunState[r.runId]
            if seeded, prev != r.state, Self.notify.contains(r.state), r.runId != focusedRunId,
               let viewerId, r.ownerUserId == viewerId {
                fresh.append(NotifItem(
                    id: nextId(),
                    runId: r.runId,
                    machineId: r.machineId,
                    sessionId: r.sessionId,
                    title: r.title ?? String(r.sessionId.prefix(8)),
                    machineName: r.machineName,
                    state: r.state,
                    ts: Date(),
                    pendingKind: r.pendingKind,
                    pendingTool: r.pendingTool,
                    pendingRequestId: r.pendingRequestId,
                    since: r.since
                ))
            }
        }
        prevRunState = next
        seeded = true
        prune(runs, focusedRunId: focusedRunId)
        guard !fresh.isEmpty else { return }
        items = (fresh.reversed() + items).prefix(60).map { $0 }
        unreadIds.formUnion(fresh.map(\.id))
        unreadIds.formIntersection(items.map(\.id))
        // Emit local notifications only when backgrounded — foregrounded, the
        // in-app Inbox already surfaces them (and the delegate suppresses banners).
        if enabled, !appIsActive() {
            for n in fresh {
                postBanner?(Banner(
                    id: "run-\(n.runId)-\(n.id)",
                    title: "Hegai Code — \(n.title)",
                    body: "\(n.machineName.map { $0 + " · " } ?? "")сессия \(Self.verb(n.state, pendingKind: n.pendingKind))",
                    machineId: n.machineId,
                    sessionId: n.sessionId
                ))
            }
        }
    }

    /// The bell is a to-do list, not a log (web `pruneInbox`, 78155a2): an
    /// entry goes by itself once its reason does.
    /// - «ждёт ответа / подтверждения» — while that very prompt is pending.
    ///   Answered, timed out, or the run is gone: nothing left to do.
    /// - «готова» / «ошибка» — until the run moves on (someone already acted
    ///   on it). A run that disappears keeps its entry: a result is still news.
    /// - any entry — once its run is the one on screen.
    func prune(_ runs: [ActiveRunInfo], focusedRunId: String?) {
        let byRun = Dictionary(runs.map { ($0.runId, $0) }, uniquingKeysWith: { a, _ in a })
        let kept = items.filter { n in
            if n.runId == focusedRunId { return false }
            let run = byRun[n.runId]
            if n.state == .needs_attention {
                guard let run, run.state == .needs_attention else { return false }
                guard let was = n.pendingRequestId, let now = run.pendingRequestId else { return true }
                return was == now
            }
            return run == nil || run?.state == n.state
        }
        guard kept.count != items.count else { return }
        items = kept
        unreadIds.formIntersection(kept.map(\.id))
    }

    /// A session opened on screen is read — whatever the bell held for it goes,
    /// including a finished run that has already left the activity list.
    public func dismiss(machineId: String, sessionId: String) {
        let kept = items.filter { $0.machineId != machineId || $0.sessionId != sessionId }
        guard kept.count != items.count else { return }
        items = kept
        unreadIds.formIntersection(kept.map(\.id))
    }

    /// A read mark from another device: drop this session's entries produced by
    /// a run state at or before `at` (hub ms). Entries without a hub time are
    /// dropped too — nothing says they are newer than the mark. Unlike the
    /// unread dot this covers error and decision entries as well.
    public func dismiss(machineId: String, sessionId: String, upTo at: Double) {
        let kept = items.filter { n in
            guard n.machineId == machineId, n.sessionId == sessionId else { return true }
            guard let since = n.since else { return false }
            return since > at
        }
        guard kept.count != items.count else { return }
        items = kept
        unreadIds.formIntersection(kept.map(\.id))
    }

    public func markRead() { unreadIds = [] }
    public func clear() { items = []; unreadIds = [] }

    public static func verb(_ state: AttentionState) -> String {
        verb(state, pendingKind: nil)
    }

    /// The same verb, told apart by WHAT is pending.
    ///
    /// `needs_attention` covers two different things: the agent asked a
    /// question (AskUserQuestion / ExitPlanMode) and a tool waiting to be
    /// allowed to run. This used to print "ждёт подтверждения" for both, which
    /// is wrong for a question the same way the web's "ждёт ответа" was wrong
    /// for a permission prompt. `pendingKind` comes from the hub; nil means a
    /// hub too old to say, and then we claim only what we know.
    public static func verb(_ state: AttentionState, pendingKind: String?) -> String {
        switch state {
        case .needs_attention:
            switch pendingKind {
            case "question": return "ждёт ответа"
            case "permission": return "ждёт подтверждения"
            default: return "ждёт решения"
            }
        case .error: return "завершилась ошибкой"
        case .idle: return "готова"
        default: return "обновилась"
        }
    }
}
