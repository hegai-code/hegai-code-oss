import XCTest
@testable import CCRemote
@testable import CCRemoteKit

final class TranscriptRowsTests: XCTestCase {
    private func line(_ id: Int, _ kind: TranscriptLine.Kind, _ text: String) -> TranscriptLine {
        TranscriptLine(id: id, kind: kind, text: text)
    }

    func testCompletedProgressFoldsWithoutLosingMessagesAndBusyTailStaysOpen() {
        let live = groupLive([line(1, .user, "Task"), line(2, .assistant, "Checking"),
            line(3, .tool_use, "Read {}"), line(4, .assistant, "Building"),
            line(5, .assistant, "Waiting"), line(6, .assistant, "Final answer")])
        let done = transcriptRows(history: [], live: live)
        XCTAssertEqual(done.map(\.id), ["l-1", "progress-l-2", "l-6"])
        XCTAssertEqual(done[1].earlier.map(\.id), ["l-2", "l-4", "l-5"])
        // The read rode «Checking», which announced it; it folds with it.
        XCTAssertEqual(done[1].earlier[0].lines.map(\.id), [3])
        XCTAssertFalse(done.last?.hasActivity ?? true)
        XCTAssertEqual(transcriptRows(history: [], live: live, busy: true).count, 5)
        let prose = groupLive([line(1, .assistant, "Part one"), line(2, .assistant, "Part two"), line(3, .assistant, "Part three")])
        XCTAssertEqual(transcriptRows(history: [], live: prose).count, 3)
    }

    /// The web rule (009732c): a run rides the agent paragraph BEFORE it, the
    /// one that announced it; only a run with nothing of the agent's behind it
    /// goes forward. The summary at the end ran nothing and carries no gear.
    func testEachRunRidesTheProseThatFramesIt() {
        let rows = transcriptRows(history: [], live: groupLive([
            line(1, .user, "Do it"), line(2, .tool_use, "Read {}"),
            line(3, .status, "→ completed"), line(4, .status, "0 0\n→ completed"),
            line(5, .assistant, "Checking"), line(6, .tool_use, "Bash {}"),
            line(7, .assistant, "Done"), line(8, .result, "completed")
        ]))
        XCTAssertEqual(rows.map(\.id), ["l-1", "l-5", "l-7"])
        XCTAssertEqual(rows.filter(\.hasActivity).count, 1)
        XCTAssertEqual(rows[1].lines.map(\.id), [2, 4, 6])
        XCTAssertEqual(rows[1].lines[1].text, "0 0")
        XCTAssertFalse(rows[2].hasActivity)
    }

    func testRunAfterAHumanTurnWithNoAnswerIsItsOwnRow() {
        let rows = transcriptRows(history: [], live: groupLive([
            line(1, .user, "First"), line(2, .tool_use, "Read {}"),
            line(3, .assistant, "First answer"), line(4, .user, "Second"),
            line(5, .tool_use, "Bash {}"), line(6, .error, "Authentication failed")
        ]))
        XCTAssertEqual(rows.map(\.id), ["l-1", "l-3", "l-4", "lr-5", "l-6"])
        XCTAssertEqual(rows[1].lines.map(\.id), [2])
        XCTAssertFalse(rows[2].hasActivity, "The human bubble carries no gear")
        XCTAssertEqual(rows[3].lines.map(\.id), [5])
    }

    func testHistoryLiveSeamAndToolResultsKeepOneBadge() {
        let history = groupHistory([
            HistoryMessage(role: .user, uuid: "u", blocks: [.text("Task")]),
            HistoryMessage(role: .assistant, uuid: "a", blocks: [
                .text("Checking"), .toolUse(id: "t", name: "Read", input: .null)]),
            HistoryMessage(role: .user, uuid: "r", blocks: [.toolResult(toolUseId: "t", text: "0", isError: false)])
        ])
        let rows = transcriptRows(history: history, live: groupLive([
            line(1, .tool_use, "Bash {}"), line(2, .assistant, "Finished")
        ]))
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows.filter(\.hasActivity).count, 1, "History run and live run are one gear")
        XCTAssertEqual(rows[1].blocks.count, 2)
        XCTAssertEqual(rows[1].lines.map(\.id), [1])
        XCTAssertFalse(rows[2].hasActivity)
    }

    func testHistoryOnlyAndToolOnlyRemainReachable() {
        let tools: [RenderBlock] = [.toolUse(id: "t", name: "Read", input: .null)]
        let orphan = transcriptRows(history: [.toolRun(id: "r", blocks: tools)])
        XCTAssertEqual(orphan.count, 1)
        XCTAssertEqual(orphan[0].blocks, tools)
        let rows = transcriptRows(history: groupHistory([
            HistoryMessage(role: .user, uuid: "u", blocks: [.text("Task")]),
            HistoryMessage(role: .assistant, uuid: "a", blocks: tools),
            HistoryMessage(role: .assistant, uuid: "b", blocks: [.text("Answer")])
        ]))
        XCTAssertEqual(rows.count, 2)
        XCTAssertFalse(rows[0].hasActivity)
        XCTAssertEqual(rows[1].blocks, tools)
    }

    func testCompletedInHumanOrAssistantProseIsNotHiddenAndErrorsStay() {
        let rows = transcriptRows(history: [], live: groupLive([
            line(1, .user, "completed"), line(2, .assistant, "completed"),
            line(3, .status, "API 401 — retrying"), line(4, .error, "failed"),
            line(5, .status, "→ failed")
        ]))
        XCTAssertEqual(rows.map(\.id), ["l-1", "l-2", "l-3", "l-4", "lr-5"])
        XCTAssertEqual(rows[4].lines.map(\.id), [5])
    }

    /// 06.10.2026, Владелец's screenshot: four paragraphs, a batch of commands
    /// after each of the first three, and the summary ending in «⚙ 23» on iOS
    /// while the web showed nothing there.
    func testFinishedAnswerSummaryCarriesNoGear() {
        func tools(_ from: Int, _ n: Int) -> [TranscriptLine] {
            (from..<from + n).map { line($0, .tool_use, "Bash {}") }
        }
        var lines: [TranscriptLine] = [line(1, .user, "Проверь")]
        lines += tools(10, 5)
        lines.append(line(2, .assistant, "Таблица не нарисовалась."))
        lines += tools(20, 6)
        lines.append(line(3, .assistant, "Проверка пройдена."))
        lines += tools(30, 6)
        lines.append(line(4, .assistant, "Запушено. Проверяю дерево."))
        lines += tools(40, 5)
        lines.append(line(5, .assistant, "Правка запушена в main."))
        let live = groupLive(lines)
        let rows = transcriptRows(history: [], live: live)
        XCTAssertEqual(rows.map(\.id), ["l-1", "progress-l-2", "l-5"])
        XCTAssertFalse(rows[2].hasActivity)
        XCTAssertEqual(rows[1].earlier.map(\.activityCount), [11, 6, 5])
        let running = transcriptRows(history: [], live: live, busy: true)
        XCTAssertEqual(running.map(\.activityCount), [0, 11, 6, 5, 0])
    }

    /// Backstage (web BACKSTAGE_CODES): a refused tool, a CLI notice and a
    /// Codex thought fold into the gear instead of standing in the reading;
    /// a rate-limit wait still stands on its own.
    func testBackstageStatusesFoldIntoTheRun() {
        func status(_ id: Int, _ text: String, _ code: String?) -> TranscriptLine {
            TranscriptLine(id: id, kind: .status, text: text, code: code)
        }
        let rows = transcriptRows(history: [], live: groupLive([
            line(1, .assistant, "Смотрю."), line(2, .tool_use, "Read {}"),
            status(3, "Bash не выполнен — запрещено правилом в настройках", "permission_denied"),
            status(4, "Claude Code needs your attention", "notification"),
            status(5, "💭 думаю", nil),
            line(6, .assistant, "Нули на месте."),
            status(7, "Лимит — жду 5 мин", "rate_limit")
        ]))
        XCTAssertEqual(rows.map(\.id), ["l-1", "l-6", "l-7"])
        XCTAssertEqual(rows[0].lines.map(\.id), [2, 3, 4, 5])
        XCTAssertEqual(rows[0].activityCount, 1)
    }
}
