import XCTest
@testable import CCRemoteKit
@testable import CCRemote

/// The transcript as one document: who continues whom, what breaks a merge,
/// and where the day marks fall. Mirrors the web's `groupHistory` /
/// `groupLive` (Blocks.tsx) plus the day-mark pass folded into it.
final class TranscriptGroupingTests: XCTestCase {
    private static let moscow: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Moscow")!
        c.locale = Locale(identifier: "ru_RU")
        return c
    }()

    /// ms since epoch for a Moscow wall-clock moment.
    private func ms(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int) -> Double {
        Self.moscow.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
            .timeIntervalSince1970 * 1000
    }

    private func user(_ id: String, _ text: String, ts: Double? = nil) -> HistoryMessage {
        HistoryMessage(role: .user, uuid: id, blocks: [.text(text)], ts: ts)
    }
    private func assistant(_ id: String, _ blocks: [RenderBlock], ts: Double? = nil) -> HistoryMessage {
        HistoryMessage(role: .assistant, uuid: id, blocks: blocks, ts: ts)
    }
    private func toolResults(_ id: String, ts: Double? = nil) -> HistoryMessage {
        HistoryMessage(role: .user, uuid: id,
                       blocks: [.toolResult(toolUseId: "t", text: "ok", isError: false)], ts: ts)
    }

    private func group(_ history: [HistoryMessage], now: Date = Date()) -> [TranscriptItem] {
        groupHistory(history, now: now, calendar: Self.moscow)
    }

    /// A compact shape of the output for assertions: "m" / "m+" (cont) / "run" / "day".
    private func shape(_ items: [TranscriptItem]) -> [String] {
        items.map {
            switch $0 {
            case let .message(_, cont): return cont ? "m+" : "m"
            case .toolRun: return "run"
            case .dayDivider: return "day"
            }
        }
    }

    // MARK: history

    func testSameSpeakerContinues() {
        let items = group([assistant("a", [.text("one")]), assistant("b", [.text("two")])])
        XCTAssertEqual(shape(items), ["m", "m+"])
    }

    func testUserBreaksTheChain() {
        let items = group([assistant("a", [.text("one")]), user("u", "hi"), assistant("b", [.text("two")])])
        XCTAssertEqual(shape(items), ["m", "m", "m"])
    }

    func testTwoUserTurnsInARowAlsoContinue() {
        let items = group([user("u1", "first"), user("u2", "second")])
        XCTAssertEqual(shape(items), ["m", "m+"])
    }

    func testToolResultOnlyUserMessageBetweenParagraphsDoesNotBreak() {
        let items = group([
            assistant("a", [.text("look"), .toolUse(id: "t", name: "Read", input: .null)]),
            toolResults("r"),
            assistant("b", [.text("found it")]),
        ])
        XCTAssertEqual(shape(items), ["m", "run", "m+"])
        if case let .toolRun(_, blocks) = items[1] { XCTAssertEqual(blocks.count, 2) } else { XCTFail() }
    }

    func testTextToolsTextInsideOneMessageSplitsAndContinues() {
        let ts = ms(2026, 8, 14, 10, 0)
        let items = group([assistant("a", [
            .text("first"),
            .toolUse(id: "t", name: "Bash", input: .null),
            .text("second"),
        ], ts: ts)])
        XCTAssertEqual(shape(items), ["day", "m", "run", "m+"])
        guard case let .message(p0, _) = items[1], case let .message(p1, cont) = items[3] else { return XCTFail() }
        XCTAssertEqual(p0.uuid, "a-p0")
        XCTAssertEqual(p1.uuid, "a-p1")
        XCTAssertTrue(cont)
        // The split pieces keep the message's own timestamp.
        XCTAssertEqual(p0.ts, ts)
        XCTAssertEqual(p1.ts, ts)
    }

    func testMidnightBreaksTheChainAndDrawsADivider() {
        let items = group([
            assistant("a", [.text("late")], ts: ms(2026, 8, 13, 23, 50)),
            assistant("b", [.text("early")], ts: ms(2026, 8, 14, 0, 10)),
        ], now: Date(timeIntervalSince1970: ms(2026, 8, 14, 12, 0) / 1000))
        XCTAssertEqual(shape(items), ["day", "m", "day", "m"])
        if case let .dayDivider(_, label) = items[0] { XCTAssertEqual(label, "вчера") } else { XCTFail() }
        if case let .dayDivider(_, label) = items[2] { XCTAssertEqual(label, "сегодня") } else { XCTFail() }
        if case let .message(_, cont) = items[3] { XCTAssertFalse(cont) } else { XCTFail() }
    }

    func testNinetyMinutesWithinOneDayStillContinues() {
        let items = group([
            assistant("a", [.text("one")], ts: ms(2026, 8, 14, 10, 0)),
            assistant("b", [.text("two")], ts: ms(2026, 8, 14, 11, 30)),
        ])
        XCTAssertEqual(shape(items), ["day", "m", "m+"])
    }

    func testMissingTimestampsMeanNoDividersAndStillMerge() {
        let items = group([assistant("a", [.text("one")]), assistant("b", [.text("two")])])
        XCTAssertEqual(shape(items), ["m", "m+"])
        XCTAssertFalse(items.contains { if case .dayDivider = $0 { return true }; return false })
    }

    func testAnUntimedTurnDoesNotForgetTheDay() {
        let day = ms(2026, 8, 14, 10, 0)
        let items = group([
            assistant("a", [.text("one")], ts: day),
            user("u", "hey"),                                   // agent too old to send ts
            assistant("b", [.text("two")], ts: day + 60_000),   // same day — no second divider
        ])
        XCTAssertEqual(shape(items), ["day", "m", "m", "m"])
    }

    func testDividerIdsAreDistinctFromMessageIds() {
        let items = group([assistant("a", [.text("one")], ts: ms(2026, 8, 14, 10, 0))])
        XCTAssertEqual(items.map(\.id), ["d-a-p0", "m-a-p0"])
    }

    func testAllNoiseUserTurnIsSkippedAndDoesNotBreak() {
        let noise = "<system-reminder>\nremember\n</system-reminder>"
        let items = group([assistant("a", [.text("one")]), user("n", noise), assistant("b", [.text("two")])])
        XCTAssertEqual(shape(items), ["m", "m+"])
    }

    func testSystemTurnsAreDropped() {
        let items = group([
            HistoryMessage(role: .system, uuid: "s", blocks: [.text("hook output")]),
            assistant("a", [.text("one")]),
        ])
        XCTAssertEqual(shape(items), ["m"])
    }

    func testHumanTurnKeepsItsCleanedBlocksAndTimestamp() {
        let ts = ms(2026, 8, 14, 10, 0)
        let items = group([user("u", "do it\n<task-notification>x</task-notification>", ts: ts)])
        guard case let .message(m, _) = items[1] else { return XCTFail() }
        XCTAssertEqual(m.blocks, [.text("do it")])
        XCTAssertEqual(m.ts, ts)
        XCTAssertEqual(m.uuid, "u")
    }

    // MARK: live

    private func line(_ id: Int, _ kind: TranscriptLine.Kind, _ text: String) -> TranscriptLine {
        TranscriptLine(id: id, kind: kind, text: text)
    }

    private func liveShape(_ items: [LiveTranscriptItem]) -> [String] {
        items.map {
            switch $0 {
            case let .line(l, cont): return cont ? "\(l.kind.rawValue)+" : l.kind.rawValue
            case .toolRun: return "run"
            }
        }
    }

    func testLiveAssistantAfterAssistantContinues() {
        let items = groupLive([line(1, .assistant, "one"), line(2, .assistant, "two")])
        XCTAssertEqual(liveShape(items), ["assistant", "assistant+"])
    }

    func testLiveUserNeverContinues() {
        let items = groupLive([
            line(1, .user, "a"), line(2, .user, "b"),
            line(3, .assistant, "one"), line(4, .user, "c"), line(5, .assistant, "two"),
        ])
        XCTAssertEqual(liveShape(items), ["user", "user", "assistant", "user", "assistant"])
    }

    func testLiveToolLinesBetweenParagraphsDoNotBreak() {
        let items = groupLive([
            line(1, .assistant, "one"),
            line(2, .tool_use, "Read {\"file_path\":\"a\"}"),
            line(3, .tool_use, "Bash {\"command\":\"ls\"}"),
            line(4, .assistant, "two"),
        ])
        XCTAssertEqual(liveShape(items), ["assistant", "run", "assistant+"])
        if case let .toolRun(id, lines, isTail) = items[1] {
            XCTAssertEqual(id, 2)
            XCTAssertEqual(lines.count, 2)
            XCTAssertFalse(isTail)
        } else { XCTFail() }
    }

    func testLiveLoneToolLineUsesCompactActivityAndDoesNotBreak() {
        let items = groupLive([
            line(1, .assistant, "one"),
            line(2, .tool_use, "Read {}"),
            line(3, .assistant, "two"),
        ])
        XCTAssertEqual(liveShape(items), ["assistant", "run", "assistant+"])
    }

    func testLiveSystemLinesDropAndTailRunIsMarked() {
        let items = groupLive([
            line(1, .system, "init model=x"),
            line(2, .assistant, "go"),
            line(3, .tool_use, "Bash {}"),
            line(4, .tool_use, "Bash {}"),
        ])
        XCTAssertEqual(liveShape(items), ["assistant", "run"])
        if case let .toolRun(_, _, isTail) = items[1] { XCTAssertTrue(isTail) } else { XCTFail() }
    }

    func testWhitespaceOnlyHistoryDoesNotSplitActivity() {
        let items = group([
            assistant("a", [.text("Начинаю.")]),
            assistant("b", [.toolUse(id: "t1", name: "Read", input: .object([:]))]),
            assistant("blank", [.text("  \n\n")]),
            assistant("c", [.toolUse(id: "t2", name: "Bash", input: .object([:]))]),
            assistant("d", [.text("Готово.")]),
        ])
        XCTAssertEqual(shape(items), ["m", "run", "m+"])
    }

    func testEmptyStreamBoundariesDoNotFragmentTools() {
        let input = [
            line(1, .assistant, "Проверяю проект."),
            line(2, .tool_use, "Read {}"),
            line(3, .assistant, "  \n\n"),
            line(4, .status, ""),
            line(5, .result, "\n"),
            line(6, .assistant, "<system-reminder>noise</system-reminder>"),
            line(7, .tool_use, "Bash {}"),
            line(8, .assistant, "Готово."),
        ]
        let items = groupLive(input)
        XCTAssertEqual(liveShape(items), ["assistant", "run", "assistant+"])
        guard case let .toolRun(_, lines, _) = items[1] else { return XCTFail() }
        XCTAssertEqual(lines.map(\.id), [2, 7])
    }

    func testNonemptyErrorsAndShortStatusesRemainVisibleBetweenTools() {
        let items = groupLive([
            line(1, .tool_use, "Read {}"),
            line(2, .status, "API 401 (authentication_failed) — retry 1/10 in 1s"),
            line(3, .tool_use, "Bash {}"),
            line(4, .error, "Authentication failed"),
        ])
        XCTAssertEqual(liveShape(items), ["run", "status", "run", "error"])
    }

    func testResumeNoticesDoNotSplitConversationOrToolActivity() {
        let items = groupLive([
            line(1, .assistant, "Проверяю."),
            line(2, .tool_use, "Read {}"),
            line(3, .status, "session resumed"),
            line(4, .tool_use, "Bash {}"),
            line(5, .status, " session resumed\n"),
            line(6, .assistant, "Готово."),
        ])
        XCTAssertEqual(liveShape(items), ["assistant", "run", "assistant+"])
        guard case let .toolRun(_, lines, _) = items[1] else { return XCTFail() }
        XCTAssertEqual(lines.map(\.id), [2, 4])
    }

    func testResumeTextInActualMessagesAndErrorsIsPreserved() {
        let items = groupLive([
            line(1, .user, "session resumed"),
            line(2, .assistant, "session resumed"),
            line(3, .error, "session resumed"),
            line(4, .status, "session resumed failed"),
        ])
        XCTAssertEqual(liveShape(items), ["user", "assistant", "error", "status"])
    }

    // MARK: helpers

    func testAgentName() {
        XCTAssertEqual(agentName("codex"), "Codex")
        XCTAssertEqual(agentName("claude"), "Claude")
        XCTAssertEqual(agentName(nil), "Claude")
    }

    func testMemoReturnsSameResultForSameInputAndRecomputesAfterInvalidate() {
        let memo = TranscriptMemo()
        let history = [assistant("a", [.text("one")], ts: ms(2026, 8, 14, 10, 0))]
        let first = memo.items(for: history)
        XCTAssertEqual(memo.items(for: history), first)
        memo.invalidate()
        XCTAssertEqual(memo.items(for: history), first)
        XCTAssertEqual(memo.items(for: []).count, 0)
    }
}
