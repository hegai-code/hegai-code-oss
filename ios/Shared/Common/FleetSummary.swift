import Foundation

/// «ждут N» / «работают M» for the complication and the Live Activity.
enum FleetSummary {
    static func waiting(_ n: Int) -> String { n % 10 == 1 && n % 100 != 11 ? "ждёт \(n)" : "ждут \(n)" }
    static func working(_ n: Int) -> String { n % 10 == 1 && n % 100 != 11 ? "работает \(n)" : "работают \(n)" }

    /// One line: waiting wins over working; both empty reads as quiet.
    static func line(waiting: Int, working: Int) -> String {
        if waiting > 0 { return Self.waiting(waiting) }
        if working > 0 { return Self.working(working) }
        return "тихо"
    }

    /// A Live Activity past its `stale-date`: the hub has not reached it, so what
    /// it shows may be long over.
    static let staleLine = "нет обновлений"

    /// Russian label of an inbox / Live Activity state.
    static func stateLabel(_ state: String) -> String {
        switch state {
        case "needs_attention": return "ждёт ответа"
        case "working": return "работает"
        case "idle": return "готово"
        case "error": return "ошибка"
        default: return state
        }
    }

    /// «сейчас», «5 мин», «2 ч», «3 дн» from an epoch-ms timestamp.
    static func relative(ms: Int64?, now: Date = Date()) -> String? {
        guard let ms else { return nil }
        let secs = Int(now.timeIntervalSince1970 - Double(ms) / 1000)
        if secs < 60 { return "сейчас" }
        if secs < 3600 { return "\(secs / 60) мин" }
        if secs < 86400 { return "\(secs / 3600) ч" }
        return "\(secs / 86400) дн"
    }
}
