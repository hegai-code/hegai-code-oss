import XCTest
@testable import CCRemote
@testable import CCRemoteKit

/// Те же случаи, что в `web/test/turn-recaps.test.ts` (c80e7c7f): «Что сделано»
/// — по одному после каждого законченного хода с действиями.
final class TurnRecapsTests: XCTestCase {
    private func message(_ uuid: String, _ role: MessageRole, _ blocks: [RenderBlock], _ ts: Double) -> HistoryMessage {
        HistoryMessage(role: role, uuid: uuid, blocks: blocks, ts: ts)
    }

    private func tool(_ id: String, _ name: String, _ input: [String: JSONValue]) -> RenderBlock {
        .toolUse(id: id, name: name, input: .object(input))
    }

    private func recaps(_ rows: [TranscriptRow]) -> [TurnRecapData] {
        rows.compactMap { row in
            if case let .recap(data) = row.content { return data }
            return nil
        }
    }

    private func rows(_ history: [HistoryMessage], live: [TranscriptLine] = [], busy: Bool) -> [TranscriptRow] {
        transcriptRows(history: groupHistory(history), live: groupLive(live), busy: busy, recaps: true)
    }

    func testOneBlockAfterEachFinishedTurnNoneForTheRunningOne() {
        let history: [HistoryMessage] = [
            message("u1", .user, [.text("посмотри")], 1000),
            message("a1", .assistant, [tool("t1", "Read", ["file_path": .string("/a/b.ts")])], 2000),
            message("r1", .user, [.toolResult(toolUseId: "t1", text: "ok", isError: false)], 2500),
            message("a2", .assistant, [.text("готово")], 61000),
            message("u2", .user, [.text("ещё")], 70000),
            message("a3", .assistant, [tool("t2", "Bash", ["command": .string("ls"), "description": .string("List")])], 71000),
        ]
        let busy = recaps(rows(history, busy: true))
        XCTAssertEqual(busy.count, 1)
        XCTAssertEqual(busy[0].steps.map(\.text), ["Читаю b.ts"])
        XCTAssertEqual(busy[0].ms, 60000)
        let idle = rows(history, busy: false)
        XCTAssertEqual(recaps(idle).count, 2)
        // Ход кончился механикой: итог встаёт после её строки.
        guard case .recap? = idle.last?.content else { return XCTFail("recap must close the last turn") }
    }

    func testTurnStraddlingHistoryAndLiveTailCountsOnce() {
        let history: [HistoryMessage] = [
            message("u1", .user, [.text("go")], 1000),
            message("a1", .assistant, [tool("t1", "Read", ["file_path": .string("/a.ts")])], 2000),
        ]
        let live: [TranscriptLine] = [
            TranscriptLine(id: 1, kind: .tool_use, text: "$ npm test"),
            TranscriptLine(id: 2, kind: .assistant, text: "done", ts: 9000),
        ]
        let all = rows(history, live: live, busy: false)
        let found = recaps(all)
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found[0].steps.map(\.text), ["Читаю a.ts", "Прогоняю тесты"])
        XCTAssertEqual(all.last?.id, "recap-l-2")
    }

    func testCallInHistoryAndReplayCountsOnce() {
        let history: [HistoryMessage] = [
            message("u1", .user, [.text("go")], 1000),
            message("a1", .assistant, [tool("t1", "Read", ["file_path": .string("/a.ts")])], 2000),
        ]
        var replay = TranscriptLine(id: 1, kind: .tool_use, text: "Read {\"file_path\":\"/a.ts\"}")
        replay.toolUseId = "t1"
        let live: [TranscriptLine] = [replay, TranscriptLine(id: 2, kind: .assistant, text: "done", ts: 9000)]
        let found = recaps(rows(history, live: live, busy: false))
        XCTAssertEqual(found.first?.steps.map(\.text), ["Читаю a.ts"])
    }

    func testTurnEndingInMachineryClaimsNoDuration() {
        let history: [HistoryMessage] = [
            message("u1", .user, [.text("go")], 1000),
            message("a1", .assistant, [.text("смотрю"), tool("t1", "Read", ["file_path": .string("/a.ts")])], 2000),
        ]
        let found = recaps(rows(history, busy: false))
        XCTAssertEqual(found.count, 1)
        XCTAssertNil(found[0].ms)
    }

    func testHistoryPageBeginningMidTurnDoesNotCountTheTailAsAWholeTurn() {
        let history: [HistoryMessage] = [
            message("a0", .assistant, [tool("t0", "Read", ["file_path": .string("/x.ts")])], 500),
            message("a1", .assistant, [.text("готово")], 900),
            message("u1", .user, [.text("дальше")], 1000),
            message("a2", .assistant, [tool("t1", "Read", ["file_path": .string("/a.ts")])], 2000),
            message("a3", .assistant, [.text("всё")], 3000),
        ]
        let found = recaps(rows(history, busy: false))
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found[0].steps.map(\.text), ["Читаю a.ts"])
    }

    func testRowsWithoutRecapsFlagStayAsBefore() {
        let history: [HistoryMessage] = [
            message("u1", .user, [.text("go")], 1000),
            message("a1", .assistant, [tool("t1", "Read", ["file_path": .string("/a.ts")]), .text("ok")], 2000),
        ]
        XCTAssertTrue(recaps(transcriptRows(history: groupHistory(history))).isEmpty)
    }

    func testTurnWorkTakesTheLiveTailAfterTheLastHumanLine() {
        let lines: [TranscriptLine] = [
            TranscriptLine(id: 1, kind: .user, text: "прошлый"),
            TranscriptLine(id: 2, kind: .tool_use, text: "Read {\"file_path\":\"/old.ts\"}"),
            TranscriptLine(id: 3, kind: .user, text: "этот"),
            TranscriptLine(id: 4, kind: .tool_use, text: "Read {\"file_path\":\"/a/b.ts\"}"),
            TranscriptLine(id: 5, kind: .tool_use, text: "$ npm test"),
        ]
        let work = TurnWork.of(lines: lines, history: [], activity: WorkActivity.of(lines))
        XCTAssertEqual(work.steps.map(\.text), ["Читаю b.ts", "Прогоняю тесты"])
        XCTAssertTrue(work.current)
    }

    func testTurnWorkLeavesHelpersToTheirCards() {
        let lines: [TranscriptLine] = [
            TranscriptLine(id: 1, kind: .user, text: "разбери"),
            TranscriptLine(id: 2, kind: .tool_use, text: "Read {\"file_path\":\"/a/b.ts\"}"),
            TranscriptLine(id: 3, kind: .tool_use, text: "Agent {\"description\":\"Инвентарь\",\"prompt\":\"p\"}"),
        ]
        let work = TurnWork.of(lines: lines, history: [], activity: WorkActivity.of(lines))
        XCTAssertEqual(work.steps.map(\.text), ["Читаю b.ts"], "a helper call is its own card, not a step")
        XCTAssertTrue(work.waitsOnHelper)
        XCTAssertFalse(work.current)
        let after = lines + [TranscriptLine(id: 4, kind: .tool_use, text: "$ npm test")]
        let next = TurnWork.of(lines: after, history: [], activity: WorkActivity.of(after))
        XCTAssertFalse(next.waitsOnHelper, "the session works again past its helpers")
        XCTAssertEqual(next.steps.count, 2)
    }

    func testTurnWorkDescribesOnlyTheShownTailButCountsEverything() {
        var lines: [TranscriptLine] = [TranscriptLine(id: 1, kind: .user, text: "работай")]
        for i in 0..<5 {
            lines.append(TranscriptLine(id: i + 2, kind: .tool_use, text: "Read {\"file_path\":\"/a/f\(i).ts\"}"))
        }
        lines.append(TranscriptLine(id: 20, kind: .tool_use, text: "Agent {\"description\":\"d\"}"))
        let work = TurnWork.of(lines: lines, history: [], activity: WorkActivity.of(lines))
        XCTAssertEqual(work.stepCount, 5, "helpers are not steps, everything else is counted")
        XCTAssertEqual(work.steps.map(\.text), ["Читаю f2.ts", "Читаю f3.ts", "Читаю f4.ts"])
        let history: [HistoryMessage] = [
            message("u1", .user, [.text("go")], 1000),
            message("a1", .assistant, (0..<4).map { tool("t\($0)", "Read", ["file_path": .string("/h\($0).ts")]) }, 2000),
        ]
        let fromHistory = TurnWork.of(lines: [], history: history, activity: WorkActivity.thinking)
        XCTAssertEqual(fromHistory.stepCount, 4)
        XCTAssertEqual(fromHistory.steps.map(\.text), ["Читаю h1.ts", "Читаю h2.ts", "Читаю h3.ts"])
    }

    func testTurnWorkFallsBackToHistoryOnlyWhenTheTailHasNoWork() {
        let history: [HistoryMessage] = [
            message("u1", .user, [.text("go")], 1000),
            message("a1", .assistant, [tool("t1", "Read", ["file_path": .string("/a.ts")])], 2000),
        ]
        let work = TurnWork.of(lines: [], history: history, activity: WorkActivity.thinking)
        XCTAssertEqual(work.steps.map(\.text), ["Читаю a.ts"])
        XCTAssertFalse(work.current)
        let withTail = TurnWork.of(lines: [TranscriptLine(id: 1, kind: .assistant, text: "пишу")], history: history,
                                   activity: "Пишу ответ")
        XCTAssertTrue(withTail.steps.isEmpty)
    }

    /// The replay began mid-turn (the hub restarted): the tail alone would count
    /// two steps where the turn has five, and the number dropped on open.
    func testTurnWorkJoinsTheFileWhenTheLiveTailBeginsMidTurn() {
        let history: [HistoryMessage] = [
            message("u1", .user, [.text("go")], 1000),
            message("a1", .assistant, (0..<4).map { tool("t\($0)", "Read", ["file_path": .string("/h\($0).ts")]) }, 2000),
        ]
        let lines = [
            TranscriptLine(id: 1, kind: .tool_use, text: #"Read {"file_path":"/h3.ts"}"#, toolUseId: "t3"),
            TranscriptLine(id: 2, kind: .tool_use, text: #"Read {"file_path":"/n.ts"}"#, toolUseId: "t4"),
        ]
        let work = TurnWork.of(lines: lines, history: history, activity: WorkActivity.of(lines))
        XCTAssertEqual(work.stepCount, 5, "t0–t3 from the file, t4 live; t3 is in both and counts once")
        XCTAssertEqual(work.steps.map(\.text), ["Читаю h3.ts", "Читаю n.ts"])
        // A history from before this turn shares no call with it: not joined.
        let foreign = [TranscriptLine(id: 3, kind: .tool_use, text: #"Read {"file_path":"/x.ts"}"#, toolUseId: "x9")]
        XCTAssertEqual(TurnWork.of(lines: foreign, history: history, activity: WorkActivity.of(foreign)).stepCount, 1)
        // With the person's line in the tail the tail is the whole turn.
        let whole = [TranscriptLine(id: 0, kind: .user, text: "go")] + lines
        XCTAssertEqual(TurnWork.of(lines: whole, history: history, activity: WorkActivity.of(whole)).stepCount, 2)
    }
}
