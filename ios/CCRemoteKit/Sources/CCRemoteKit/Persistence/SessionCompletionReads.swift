import Foundation
import Observation

/// Unread finished turns and unseen decisions, independent of the notification inbox and socket lifetime.
/// Completed previews remain in the same account-scoped cache as read receipts.
@MainActor @Observable
public final class SessionCompletionReads {
    public struct Completion: Codable, Equatable, Sendable {
        public let at: Double
        public let preview: String?
        public init(at: Double, preview: String? = nil) { self.at = at; self.preview = preview }
    }
    public private(set) var completed: [String: Completion] = [:]
    public private(set) var unread: [String: Double] = [:]
    public private(set) var unreadDecisions: Set<String> = []
    /// The foreground chat counted as being read right now (nil: none).
    public private(set) var visibleSession: String?
    @ObservationIgnored private var snapshot = Snapshot()
    @ObservationIgnored private let file: URL?
    private static let writer = DispatchQueue(label: "net.hegai.ccremote.completion-reads", qos: .utility)

    private struct Phase: Codable, Equatable {
        let runId: String
        let state: AttentionState
        let since: Double
        var pendingKind: String?
        var pendingTool: String?
        var pendingRequestId: String?

        func isSameDecision(as seen: Phase?) -> Bool {
            guard let seen, runId == seen.runId else { return false }
            if let id = pendingRequestId, !id.isEmpty, let seenId = seen.pendingRequestId, !seenId.isEmpty {
                return id == seenId
            }
            return self == seen // Older hubs lack stable request IDs.
        }
    }
    private struct Snapshot: Codable, Equatable {
        var phases: [String: Phase] = [:]
        var unread: [String: Double] = [:]
        var completed: [String: Completion]?
        // Optional for compatibility with completion-only snapshots from 0.7.55.
        var seenDecisions: [String: Phase]?
        var unreadDecisions: Set<String>?
        /// Hub time (ms) of the latest «read» mark per session from ANY of the
        /// person's devices. Optional for snapshots written before it existed.
        var remoteReads: [String: Double]?
    }

    public init(directory: URL? = nil) {
        file = directory?.appendingPathComponent("SessionCompletionReads.json")
        if let file, let saved = Self.writer.sync(execute: {
            (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) }
        }) {
            snapshot = saved
            unread = saved.unread
            completed = saved.completed ?? saved.unread.mapValues { Completion(at: $0) }
            snapshot.completed = completed
            unreadDecisions = saved.unreadDecisions ?? Set(saved.phases.compactMap { key, phase in
                phase.state == .needs_attention && !phase.isSameDecision(as: saved.seenDecisions?[key]) ? key : nil
            })
        }
    }

    /// Read marks from the hub (`session_reads`). A mark at or after the finish
    /// time of an unread completion clears it; the mark is kept so a completion
    /// replayed later (reconnect, snapshot) is not marked unread again.
    /// Returns the keys whose unread dot was just cleared, so the caller can
    /// drop the bell entries of the same sessions.
    @discardableResult
    public func applyRemoteReads(_ reads: [SessionRead]) -> [String] {
        guard !reads.isEmpty else { return [] }
        let before = snapshot
        var remote = snapshot.remoteReads ?? [:]
        var cleared: [String] = []
        for read in reads where read.at.isFinite && !read.machineId.isEmpty && !read.sessionId.isEmpty {
            let key = "\(read.machineId)::\(read.sessionId)"
            remote[key] = max(remote[key] ?? 0, read.at)
            if let since = snapshot.unread[key], read.at >= since {
                snapshot.unread.removeValue(forKey: key)
                cleared.append(key)
            }
            // A decision that was on someone's screen at or after it appeared
            // has been seen too — same as `setVisibleSession` does locally.
            if let phase = snapshot.phases[key], phase.state == .needs_attention, read.at >= phase.since {
                if snapshot.seenDecisions == nil { snapshot.seenDecisions = [:] }
                snapshot.seenDecisions?[key] = phase
                unreadDecisions.remove(key)
            }
        }
        snapshot.unreadDecisions = unreadDecisions
        if remote.count > 1000 {
            remote = Dictionary(uniqueKeysWithValues: remote.sorted { $0.value > $1.value }.prefix(1000).map { ($0.key, $0.value) })
        }
        snapshot.remoteReads = remote
        guard snapshot != before else { return [] }
        if unread != snapshot.unread { unread = snapshot.unread }
        save()
        return cleared
    }

    /// Finished turns the hub stored (`session_completions`). The live path
    /// (`ingest`) sees a finish only while the run exists; a run does not
    /// survive an agent restart or the hub's six-hour idle reaper, and a phone
    /// asleep through both woke on 31.10.2026 to four answers and no dots.
    /// A finish this device already knows — the phase it saved is as new or
    /// newer — changes nothing, so the replay on every reconnect is harmless.
    /// The phase it leaves has no run id: `ingest` treats a live idle run of
    /// the same moment as this very finish, not a new one.
    public func applyCompletions(_ list: [SessionCompletion]) {
        guard !list.isEmpty else { return }
        let before = snapshot
        for done in list where done.at.isFinite && !done.machineId.isEmpty && !done.sessionId.isEmpty {
            let key = "\(done.machineId)::\(done.sessionId)"
            if let phase = snapshot.phases[key], phase.since >= done.at { continue }
            if snapshot.completed == nil { snapshot.completed = [:] }
            // The hub sends no text; the row shows the session as it is.
            snapshot.completed?[key] = Completion(at: done.at)
            snapshot.phases[key] = Phase(runId: "", state: .idle, since: done.at)
            let readElsewhere = (snapshot.remoteReads?[key]).map { $0 >= done.at } ?? false
            if key == visibleSession || readElsewhere {
                snapshot.unread.removeValue(forKey: key)
            } else {
                snapshot.unread[key] = done.at
            }
        }
        guard snapshot != before else { return }
        if unread != snapshot.unread { unread = snapshot.unread }
        if completed != snapshot.completed ?? [:] { completed = snapshot.completed ?? [:] }
        save()
    }

    /// Only the foreground chat with the drawer closed counts as being read.
    /// Looking at the inbox or drawer must not acknowledge a finished answer.
    public func setVisibleSession(_ key: String?) {
        visibleSession = key
        guard let key else { return }
        let before = snapshot
        unread.removeValue(forKey: key)
        snapshot.unread = unread
        if let phase = snapshot.phases[key], phase.state == .needs_attention {
            if snapshot.seenDecisions == nil { snapshot.seenDecisions = [:] }
            snapshot.seenDecisions?[key] = phase
            unreadDecisions.remove(key)
        }
        snapshot.unreadDecisions = unreadDecisions
        if snapshot != before { save() }
    }

    public func ingest(_ runs: [ActiveRunInfo], viewerId: String?) {
        guard let viewerId else { return }
        let before = snapshot
        var decisions = Set<String>()
        for run in runs {
            let key = "\(run.machineId)::\(run.sessionId)"
            guard !run.sessionId.isEmpty else { continue }
            guard run.ownerUserId == viewerId else {
                snapshot.phases.removeValue(forKey: key)
                snapshot.unread.removeValue(forKey: key)
                snapshot.completed?.removeValue(forKey: key)
                continue
            }
            let previous = snapshot.phases[key]
            if let previous, previous.runId == run.runId, previous.since > run.since {
                if previous.state == .needs_attention, !previous.isSameDecision(as: snapshot.seenDecisions?[key]) {
                    decisions.insert(key)
                }
                continue
            }
            let phase = Phase(runId: run.runId, state: run.state, since: run.since,
                              pendingKind: run.pendingKind, pendingTool: run.pendingTool,
                              pendingRequestId: run.pendingRequestId)
            if run.state == .needs_attention {
                if key == visibleSession {
                    if snapshot.seenDecisions == nil { snapshot.seenDecisions = [:] }
                    snapshot.seenDecisions?[key] = phase
                } else if !phase.isSameDecision(as: snapshot.seenDecisions?[key]) {
                    decisions.insert(key)
                }
            }
            if run.state == .idle {
                // The very finish `applyCompletions` already recorded, now seen
                // on its live run: adopt the run id, change nothing else.
                let sameFinish = previous.map { $0.runId.isEmpty && $0.state == .idle && $0.since >= run.since } ?? false
                // Idle replay is not another result. A task started after the
                // saved idle phase does prove new work even if it ran offline.
                let newTask = !sameFinish && (previous.map { old in
                    old.runId != run.runId || (run.taskStartedAt.map { $0.isFinite && $0 > old.since } ?? false)
                } ?? false)
                let changed = !sameFinish && (previous?.state == .working || previous?.state == .needs_attention || newTask)
                let preview = run.preview.flatMap { text -> String? in
                    let line = String(text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").prefix(240))
                    return line.isEmpty ? nil : line
                }
                let existing = snapshot.completed?[key]
                if changed || (preview != nil && (existing == nil || existing?.preview == nil)) {
                    if snapshot.completed == nil { snapshot.completed = [:] }
                    // Late metadata/migration fills the preview without moving
                    // the result or making an already read answer unread again.
                    let at = changed ? run.since : existing?.at ?? previous?.since ?? run.since
                    snapshot.completed?[key] = Completion(at: at, preview: preview)
                }
                // A read mark from another device at or after this finish means it was already seen.
                let readElsewhere = (snapshot.remoteReads?[key]).map { $0 >= run.since } ?? false
                if changed, key != visibleSession, !readElsewhere { snapshot.unread[key] = run.since }
                if key == visibleSession { snapshot.unread.removeValue(forKey: key) }
            } else {
                // A new turn, pending decision or error supersedes the old result.
                snapshot.unread.removeValue(forKey: key)
                snapshot.completed?.removeValue(forKey: key)
            }
            snapshot.phases[key] = phase
        }
        // Keep unread answers until opened; bound only the already-read phase history.
        if snapshot.phases.count > 2000 {
            let retained = Set(snapshot.phases.sorted { $0.value.since > $1.value.since }
                .prefix(2000).map(\.key)).union(snapshot.unread.keys).union(decisions)
            snapshot.phases = snapshot.phases.filter { retained.contains($0.key) }
        }
        let recent = Set((snapshot.completed ?? [:]).filter { snapshot.unread[$0.key] == nil }
            .sorted { $0.value.at > $1.value.at }
            .prefix(100).map(\.key)).union(snapshot.unread.keys)
        snapshot.completed = snapshot.completed?.filter { recent.contains($0.key) }
        if completed != snapshot.completed ?? [:] { completed = snapshot.completed ?? [:] }
        snapshot.seenDecisions = snapshot.seenDecisions?.filter { snapshot.phases[$0.key] != nil }
        snapshot.unreadDecisions = decisions
        if unreadDecisions != decisions { unreadDecisions = decisions }
        guard snapshot != before else { return }
        if unread != snapshot.unread { unread = snapshot.unread }
        save()
    }

    private func save() {
        guard let file else { return }
        let value = snapshot
        Self.writer.async {
            guard let data = try? JSONEncoder().encode(value) else { return }
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
        }
    }
}
