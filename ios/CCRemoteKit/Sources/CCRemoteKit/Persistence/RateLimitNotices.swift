import Foundation
import Observation

/// One presentation per machine/window/decade, across chats and relaunches.
/// Owned by the client and recreated when its account storage scope changes.
@MainActor @Observable
public final class RateLimitNotices {
    public private(set) var latest: [String: RateLimitNotice] = [:]
    private let file: URL?
    private var shown: [String]
    static let capacity = 30

    public init(directory: URL? = nil) {
        file = directory?.appendingPathComponent("RateLimitNotices.json")
        shown = Array((file.flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []).suffix(Self.capacity))
    }

    public func receive(_ data: StreamUsageData?, machineId: String) {
        if data?.status == "allowed" { latest[machineId] = nil; return }
        guard let notice = RateLimitNotice(data: data) else { return }
        latest[machineId] = notice
    }

    public func clearPending() { latest = [:] }

    /// Called by a visible chat, never by socket receipt: a warning that arrived
    /// while the app was backgrounded has not yet been seen.
    public func claim(machineId: String, now: Date = Date()) -> RateLimitNotice? {
        guard let notice = latest[machineId], notice.isCurrent(now: now) else { return nil }
        let key = notice.key(machineId: machineId)
        guard !shown.contains(key) else { return nil }
        shown.append(key)
        shown = Array(shown.suffix(Self.capacity))
        if let file {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let data = try? JSONEncoder().encode(shown) { try? data.write(to: file, options: .atomic) }
        }
        return notice
    }
}
