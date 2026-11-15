import XCTest
@testable import CCRemote
@testable import CCRemoteKit

final class TurnCompletionTests: XCTestCase {
    private let answer = HistoryMessage(role: .assistant, uuid: "a", blocks: [.text("Нашёл звонок. Учтём в отчёте.")], ts: 100)

    func testOnlyConfirmedIdleIsComplete() {
        for state in [AttentionState.working, .needs_attention, .error, .unknown] {
            XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: [], busy: false,
                connected: true, state: state, completedAt: 200, lastModified: 100))
        }
        XCTAssertTrue(TurnCompletion.isComplete(history: [answer], lines: [], busy: false,
            connected: true, state: .idle))
        XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: [], busy: false,
            connected: true, state: nil))
    }

    func testDisconnectAndOptimisticSendHideCompletionEvenWithOldIdle() {
        XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: [], busy: false,
            connected: false, state: .idle))
        XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: [], busy: true,
            connected: true, state: .idle))
        let prompt = TranscriptLine(id: 1, kind: .user, text: "Продолжай")
        XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: [prompt], busy: false,
            connected: true, state: .idle))
        let historyPrompt = HistoryMessage(role: .user, uuid: "u", blocks: [.text("Продолжай")], ts: 201)
        XCTAssertFalse(TurnCompletion.isComplete(history: [answer, historyPrompt], lines: [], busy: false,
            connected: true, state: .idle))
    }

    func testGearAloneAndErrorAreNotACompletedAnswer() {
        let gear = HistoryMessage(role: .assistant, uuid: "t", blocks: [.toolUse(id: "t", name: "exec", input: .object([:]))])
        XCTAssertFalse(TurnCompletion.isComplete(history: [gear], lines: [], busy: false,
            connected: true, state: .idle))
        XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: [TranscriptLine(id: 1, kind: .error, text: "failed")],
            busy: false, connected: true, state: .idle))
    }

    func testIdleDoesNotLabelAnUnconfirmedCacheEvenWithLiveServiceLines() {
        for lines in [[], [TranscriptLine(id: 1, kind: .status, text: "session resumed")]] {
            XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: lines, busy: false,
                connected: true, state: .idle, historyConfirmed: false))
        }
        XCTAssertTrue(TurnCompletion.isComplete(history: [answer],
            lines: [TranscriptLine(id: 2, kind: .assistant, text: "Новый ответ")], busy: false,
            connected: true, state: .idle, historyConfirmed: false))
    }

    func testPreGapAssistantCannotConfirmTheNewlyIdleTurn() {
        let retained = [TranscriptLine(id: 1, kind: .assistant, text: "Старый ответ до разрыва")]
        for historyConfirmed in [false, true] {
            XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: retained, busy: false,
                connected: true, state: .idle, historyConfirmed: historyConfirmed, linesConfirmed: false))
        }
        XCTAssertTrue(TurnCompletion.isComplete(history: [answer], lines: [], busy: false,
            connected: true, state: .idle, historyConfirmed: true, linesConfirmed: false))
    }

    func testRemovedRunNeedsDatedHistoryNoNewerThanItsSavedCompletion() {
        XCTAssertTrue(TurnCompletion.isComplete(history: [answer], lines: [], busy: false,
            connected: true, state: nil, completedAt: 200, lastModified: 100))
        XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: [], busy: false,
            connected: true, state: nil, completedAt: 200, lastModified: 201))
        let newer = HistoryMessage(role: .assistant, uuid: "b", blocks: [.text("Продолжаю искать…")], ts: 300)
        XCTAssertFalse(TurnCompletion.isComplete(history: [answer, newer], lines: [], busy: false,
            connected: true, state: nil, completedAt: 200, lastModified: 100))
        let undated = HistoryMessage(role: .assistant, uuid: "c", blocks: [.text("Ответ")])
        XCTAssertFalse(TurnCompletion.isComplete(history: [undated], lines: [], busy: false,
            connected: true, state: nil, completedAt: 200, lastModified: 100))
        XCTAssertFalse(TurnCompletion.isComplete(history: [answer], lines: [TranscriptLine(id: 1, kind: .assistant, text: "Продолжаю")],
            busy: false, connected: true, state: nil, completedAt: 200, lastModified: 100))
    }
}
