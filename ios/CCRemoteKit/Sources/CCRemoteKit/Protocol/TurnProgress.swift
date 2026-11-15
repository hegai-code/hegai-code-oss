import Foundation

/// Elapsed time and the runtime's cumulative usage for the current turn.
public struct TurnProgress: Equatable, Sendable {
    public private(set) var startedAt: Date
    public private(set) var totalTokens: Int?

    public init(startedAt: Date = Date()) { self.startedAt = startedAt }

    public mutating func setStartedAt(_ date: Date) { startedAt = date }

    public mutating func receive(_ event: StreamEvent) {
        guard event.code == "turn_usage", let total = event.data?.totalTokens, total >= 0 else { return }
        totalTokens = total
    }

    public func elapsed(at now: Date) -> String {
        let seconds = Int(max(0, now.timeIntervalSince(startedAt)))
        if seconds >= 3600 {
            return String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
        }
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
