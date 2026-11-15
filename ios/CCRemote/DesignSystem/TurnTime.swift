import Foundation

/// Relative-time formatting shared across rows (e.g. "3m", "2h", "Jul 5").
enum RelTime {
    static func short(_ msEpoch: Double) -> String {
        let date = Date(timeIntervalSince1970: msEpoch / 1000)
        let secs = Date().timeIntervalSince(date)
        if secs < 60 { return "now" }
        if secs < 3600 { return "\(Int(secs / 60))m" }
        if secs < 86_400 { return "\(Int(secs / 3600))h" }
        if secs < 604_800 { return "\(Int(secs / 86_400))d" }
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }

    /// "через 3 ч" / "через 12 мин" — used by quota resets.
    static func until(_ msEpoch: Double) -> String {
        let secs = Date(timeIntervalSince1970: msEpoch / 1000).timeIntervalSinceNow
        if secs <= 0 { return "сбрасывается" }
        let mins = Int(secs / 60)
        if mins >= 1440 { return "через \(mins / 1440) д" }
        if mins >= 60 { return "через \(mins / 60) ч" }
        return "через \(max(1, mins)) мин"
    }
}

/// Wall-clock time and calendar days for the transcript (port of `hhmm` /
/// `dayKey` / `dayLabel` in web/src/lib.ts). Everything is calendar-based in
/// the READER's zone: two turns 90 minutes apart are on different days when one
/// is at 23:30, and two turns 20 hours apart can share one — elapsed
/// milliseconds get both wrong. `calendar` is injectable so tests pin a zone.
///
/// Month names are a hard-coded genitive table, not `DateFormatter(ru_RU)`:
/// ICU yields «авг.» with a period and its abbreviations drift between OS
/// releases, and «14 мая» is the only correct form of that month anyway.
enum TurnTime {
    private static let months = ["янв", "фев", "мар", "апр", "мая", "июн",
                                 "июл", "авг", "сен", "окт", "ноя", "дек"]

    private static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    /// «09:05» — 24h regardless of locale, zero-padded: the header time is mono
    /// and column-aligned, and 'AM'/'PM' costs three characters there.
    static func hhmm(_ ms: Double, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date(ms))
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// Calendar-day identity, `y*10000 + m*100 + d`.
    static func dayKey(_ ms: Double, calendar: Calendar = .current) -> Int {
        let c = calendar.dateComponents([.year, .month, .day], from: date(ms))
        return (c.year ?? 0) * 10000 + (c.month ?? 0) * 100 + (c.day ?? 0)
    }

    /// The label on a day boundary: «сегодня», «вчера», «14 авг», «14 авг 2025».
    /// The year only earns its space once it stops being the obvious one.
    static func dayLabel(_ ms: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
        let then = date(ms)
        let days = calendar.dateComponents([.day],
                                           from: calendar.startOfDay(for: then),
                                           to: calendar.startOfDay(for: now)).day ?? 0
        if days == 0 { return "сегодня" }
        if days == 1 { return "вчера" }
        let c = calendar.dateComponents([.year, .month, .day], from: then)
        let month = months[max(0, min(11, (c.month ?? 1) - 1))]
        let day = "\(c.day ?? 0) \(month)"
        return c.year == calendar.component(.year, from: now) ? day : "\(day) \(c.year ?? 0)"
    }
}
