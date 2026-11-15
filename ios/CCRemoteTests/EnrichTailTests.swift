import XCTest
@testable import CCRemoteKit
@testable import CCRemote

final class EnrichTailTests: XCTestCase {
    private func msg(_ role: MessageRole, _ uuid: String, _ blocks: [RenderBlock]) -> HistoryMessage {
        HistoryMessage(role: role, uuid: uuid, blocks: blocks)
    }
    private func line(_ id: Int, _ kind: TranscriptLine.Kind, _ text: String) -> TranscriptLine {
        TranscriptLine(id: id, kind: kind, text: text)
    }
    private let machinery: RenderBlock = .toolResult(toolUseId: "t", text: "ok", isError: false)

    func testLiveAssistantLineBeatsHistory() {
        let history = [msg(.assistant, "h1", [.text("Старый вопрос?")])]
        let lines = [line(7, .assistant, "Раскатывать?")]
        let tail = EnrichTailFinder.tail(history: history, lines: lines, busy: false)
        XCTAssertEqual(tail?.uuid, "live-7")
        XCTAssertEqual(tail?.text, "Раскатывать?")
    }

    func testLiveUserLineAtTheTailMeansNothingPending() {
        let lines = [line(1, .assistant, "Раскатывать?"), line(2, .user, "Да")]
        XCTAssertNil(EnrichTailFinder.tail(history: [], lines: lines, busy: false))
    }

    func testBusyRunHasNoTail() {
        let lines = [line(1, .assistant, "Раскатывать?")]
        XCTAssertNil(EnrichTailFinder.tail(history: [], lines: lines, busy: true))
    }

    func testTrailingMachineryIsSkippedToReachTheProse() {
        let history = [
            msg(.assistant, "a1", [.text("Готово. Раскатывать?")]),
            msg(.user, "u1", [machinery]),
            msg(.assistant, "a2", [machinery]),
        ]
        XCTAssertEqual(EnrichTailFinder.tail(history: history, lines: [], busy: false)?.uuid, "a1")
    }

    func testHumanTurnAtTheTailMeansNothingPending() {
        let history = [
            msg(.assistant, "a1", [.text("Раскатывать?")]),
            msg(.user, "u1", [.text("Да")]),
        ]
        XCTAssertNil(EnrichTailFinder.tail(history: history, lines: [], busy: false))
    }

    func testHarnessNoiseAndCitationsAreStripped() {
        let raw = "Готово <system-reminder>шум</system-reminder> :codex-file-citation{path=\"/a/b.ts\"} Раскатывать?"
        let tail = EnrichTailFinder.tail(history: [msg(.assistant, "a1", [.text(raw)])], lines: [], busy: false)
        XCTAssertEqual(tail?.text, "Готово  `b.ts` Раскатывать?")
    }

    func testKeyIsTheSameForTheLiveAndHistoryFormOfOneTurn() {
        let live = EnrichTailFinder.tail(history: [], lines: [line(3, .assistant, "Раскатывать?")], busy: false)
        let hist = EnrichTailFinder.tail(history: [msg(.assistant, "a1", [.text("Раскатывать?")])], lines: [], busy: false)
        XCTAssertNotEqual(live?.uuid, hist?.uuid)
        XCTAssertEqual(live?.key, hist?.key)
    }

    func testMirrorVariantReadsHistoryOnly() {
        let history = [msg(.assistant, "a1", [.text("Раскатывать?")])]
        XCTAssertEqual(EnrichTailFinder.tail(mirror: history)?.uuid, "a1")
    }

    func testEchoedUserTextPrefersTheLiveLine() {
        let history = [msg(.user, "u1", [.text("из истории")])]
        XCTAssertEqual(EnrichTailFinder.echoedUserText(history: history, lines: [line(1, .user, "живая")]), "живая")
        XCTAssertEqual(EnrichTailFinder.echoedUserText(history: history, lines: []), "из истории")
    }

    func testMemoAnswersLikeTheFinderAndDoesNotReadLinesWhileBusy() {
        let memo = EnrichTailMemo()
        let history = [msg(.assistant, "h1", [.text("Старый вопрос?")])]
        var reads = 0
        XCTAssertNil(memo.tail(history: history, busy: true) { reads += 1; return [] })
        XCTAssertEqual(reads, 0, "a busy run has no tail, and the live lines stay unobserved")
        let lines = [line(7, .assistant, "Раскатывать?")]
        XCTAssertEqual(memo.tail(history: history, busy: false) { lines }?.uuid, "live-7")
        // Same input, same answer; a changed line is picked up.
        XCTAssertEqual(memo.tail(history: history, busy: false) { lines }?.uuid, "live-7")
        let next = [line(7, .assistant, "Раскатывать?"), line(8, .user, "Да")]
        XCTAssertNil(memo.tail(history: history, busy: false) { next })
        XCTAssertEqual(EnrichTail(uuid: "a", text: "Раскатывать?").key, EnrichTail.digest("Раскатывать?"))
    }
}
