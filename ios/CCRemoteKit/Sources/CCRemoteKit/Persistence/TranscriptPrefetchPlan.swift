import Foundation

/// Automatic warming has a fixed working set. A fresh item still occupies its
/// slot, so recurring snapshots cannot turn a small warm-up into a fleet sweep.
enum TranscriptPrefetchPlan {
    static let automaticLimit = 24
    /// A session whose cache was refreshed less than this long ago is left alone
    /// by the automatic sweep, whatever its mtime says.
    static let automaticMinAge: TimeInterval = 10 * 60
    /// Automatic re-sweeps are at least this far apart (`force` ignores it).
    static let automaticSweepInterval: TimeInterval = 5 * 60

    struct Item {
        let machineId: String
        let cwd: String
        let sessionId: String
        let source: String?
        let mtime: Double
    }

    /// Did a prefetch reply put a current copy in the cache? A failed read (`nil`)
    /// or a `stale` page (the hub answered from an out-of-date replica and
    /// `sessionMessagesPage` refuses to cache it) did not, so it must not start the
    /// `automaticMinAge` quiet period for the session.
    static func fetchedForReal(_ page: HistoryPage?) -> Bool {
        guard let page else { return false }
        return !page.stale
    }

    /// Sessions whose run is mid-turn: the transcript grows (and its mtime moves)
    /// every few seconds, so a copy fetched now is stale on arrival — and the
    /// open chat reads it live anyway. Idle / errored runs do not move.
    static func inFlightKeys(_ runs: [ActiveRunInfo]) -> Set<String> {
        Set(runs.filter { $0.state == .working || $0.state == .needs_attention }
            .map { "\($0.machineId)::\($0.sessionId)" })
    }

    /// `all` (the manual full download) keeps every session, in-flight ones included;
    /// the automatic set skips them BEFORE the 24-slot limit so it stays 24 settled
    /// sessions rather than shrinking while a run is going.
    static func candidates(_ machines: [MachineSnapshot], all: Bool,
                           viewerId: String? = nil, runs: [ActiveRunInfo] = []) -> [Item] {
        let inFlight = all ? [] : inFlightKeys(runs)
        let items = ProjectGrouping.myItems(from: machines.filter(\.online), viewerId: viewerId, runs: runs)
            .compactMap { item -> Item? in
                let session = item.session
                guard let cwd = session.cwd, !cwd.isEmpty, !inFlight.contains(item.id) else { return nil }
                return Item(machineId: item.machineId, cwd: cwd,
                            sessionId: session.sessionId, source: session.source,
                            mtime: session.lastModified)
        }.sorted { $0.mtime > $1.mtime }
        return all ? items : Array(items.prefix(automaticLimit))
    }
}
