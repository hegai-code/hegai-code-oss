import Foundation

/// Same account-window thresholds as web/src/rateLimit.ts. These are quota
/// warnings from the runtime, not transport throttling or context usage.
public struct RateLimitNotice: Equatable, Sendable {
    public let rejected: Bool
    public let type: String?
    public let percent: Int?
    /// Unix milliseconds (the SDK normally sends seconds).
    public let resetsAt: Double?

    public init?(data: StreamUsageData?) {
        guard let data, data.status == "allowed_warning" || data.status == "rejected" else { return nil }
        rejected = data.status == "rejected"
        type = data.rateLimitType
        if let value = data.utilization, value.isFinite, value > 0 {
            percent = Int(min(100, floor(value > 1 ? value : value * 100)))
        } else { percent = nil }
        if let value = data.resetsAt, value.isFinite, value > 0 {
            resetsAt = value < 1e12 ? value * 1000 : value
        } else { resetsAt = nil }
    }

    public func isCurrent(now: Date = Date()) -> Bool {
        resetsAt.map { $0 > now.timeIntervalSince1970 * 1000 } ?? true
    }

    public func key(machineId: String) -> String {
        // Length-prefix the parts: machine/type may contain any delimiter.
        [machineId, type ?? "", resetsAt.map { String($0) } ?? "",
         rejected ? "x" : String((percent ?? 0) / 10)]
            .map { "\($0.utf8.count):\($0)" }.joined()
    }

    public var message: String {
        let window: (of: String, name: String)
        switch type {
        case "five_hour": window = ("лимита сессии (5 ч)", "Лимит сессии (5 ч)")
        case "seven_day": window = ("недельного лимита", "Недельный лимит")
        case "seven_day_opus": window = ("недельного лимита Opus", "Недельный лимит Opus")
        case "seven_day_sonnet": window = ("недельного лимита Sonnet", "Недельный лимит Sonnet")
        case "seven_day_overage_included": window = ("недельного лимита модели", "Недельный лимит модели")
        case "overage": window = ("кредитов", "Лимит кредитов")
        default: window = ("лимита подписки", "Лимит подписки")
        }
        if rejected { return "\(window.name) исчерпан" }
        return percent.map { "Использовано \($0)% \(window.of)" } ?? "Близко к исчерпанию \(window.of)"
    }

    public func resetText(now: Date = Date()) -> String? {
        guard let resetsAt, isCurrent(now: now) else { return nil }
        let minutes = max(1, ceil((resetsAt - now.timeIntervalSince1970 * 1000) / 60_000))
        if minutes < 60 { return "Сброс через \(Int(minutes)) мин" }
        if minutes < 1440 { return "Сброс через \(Int(minutes / 60)) ч" }
        // Clamp before converting untrusted telemetry to an integer.
        return "Сброс через \(Int(min(365_000, minutes / 1440))) дн."
    }
}
