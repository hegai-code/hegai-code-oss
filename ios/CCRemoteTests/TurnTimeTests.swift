import XCTest
@testable import CCRemote

/// Day labels and turn times are calendar arithmetic in the reader's zone —
/// pinned to Europe/Moscow here so the assertions do not depend on the CI box.
final class TurnTimeTests: XCTestCase {
    private static let moscow: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Moscow")!
        return c
    }()

    private func ms(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int) -> Double {
        Self.moscow.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
            .timeIntervalSince1970 * 1000
    }

    /// Fixed "now": 2026-08-14 12:00 Moscow.
    private var now: Date { Date(timeIntervalSince1970: ms(2026, 8, 14, 12, 0) / 1000) }

    func testDayLabelToday() {
        XCTAssertEqual(TurnTime.dayLabel(ms(2026, 8, 14, 0, 5), now: now, calendar: Self.moscow), "сегодня")
        XCTAssertEqual(TurnTime.dayLabel(ms(2026, 8, 14, 23, 59), now: now, calendar: Self.moscow), "сегодня")
    }

    func testDayLabelYesterday() {
        XCTAssertEqual(TurnTime.dayLabel(ms(2026, 8, 13, 23, 30), now: now, calendar: Self.moscow), "вчера")
        // 13 hours earlier than "now" but across midnight — still yesterday: it
        // is calendar-based, not elapsed-based.
        XCTAssertEqual(TurnTime.dayLabel(ms(2026, 8, 13, 23, 0), now: now, calendar: Self.moscow), "вчера")
    }

    func testDayLabelThisYearOmitsTheYear() {
        XCTAssertEqual(TurnTime.dayLabel(ms(2026, 8, 1, 9, 0), now: now, calendar: Self.moscow), "1 авг")
        XCTAssertEqual(TurnTime.dayLabel(ms(2026, 5, 9, 9, 0), now: now, calendar: Self.moscow), "9 мая")
    }

    func testDayLabelOtherYearCarriesTheYear() {
        XCTAssertEqual(TurnTime.dayLabel(ms(2025, 12, 31, 23, 0), now: now, calendar: Self.moscow), "31 дек 2025")
    }

    func testHhmmIsZeroPadded24h() {
        XCTAssertEqual(TurnTime.hhmm(ms(2026, 8, 14, 9, 5), calendar: Self.moscow), "09:05")
        XCTAssertEqual(TurnTime.hhmm(ms(2026, 8, 14, 17, 45), calendar: Self.moscow), "17:45")
        XCTAssertEqual(TurnTime.hhmm(ms(2026, 8, 14, 0, 0), calendar: Self.moscow), "00:00")
    }

    func testDayKeyDiffersAcrossLocalMidnight() {
        let before = TurnTime.dayKey(ms(2026, 8, 13, 23, 59), calendar: Self.moscow)
        let after = TurnTime.dayKey(ms(2026, 8, 14, 0, 1), calendar: Self.moscow)
        XCTAssertNotEqual(before, after)
        XCTAssertEqual(before, 20260813)
        XCTAssertEqual(after, 20260814)
        // Two minutes apart in the same day share a key.
        XCTAssertEqual(TurnTime.dayKey(ms(2026, 8, 14, 0, 1), calendar: Self.moscow),
                       TurnTime.dayKey(ms(2026, 8, 14, 0, 3), calendar: Self.moscow))
    }

    func testDayKeyFollowsTheCalendarZoneNotUTC() {
        // 23:30 Moscow on the 13th is 20:30 UTC on the 13th; 02:30 Moscow on the
        // 14th is 23:30 UTC on the 13th — UTC would put both on one day.
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let a = ms(2026, 8, 13, 23, 30), b = ms(2026, 8, 14, 2, 30)
        XCTAssertNotEqual(TurnTime.dayKey(a, calendar: Self.moscow), TurnTime.dayKey(b, calendar: Self.moscow))
        XCTAssertEqual(TurnTime.dayKey(a, calendar: utc), TurnTime.dayKey(b, calendar: utc))
    }
}
