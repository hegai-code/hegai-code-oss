import XCTest
@testable import CCRemoteKit

/// The plan the session shows over the composer — `shared/src/plan.ts` in Swift.
/// Rows mirror its semantics: malformed rows dropped, unknown status pending,
/// blank activeForm absent, the active step clipped to 160 with «…».
final class PlanProgressTests: XCTestCase {
    private func json(_ text: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private func planInput(_ rows: [(String, String)]) -> JSONValue {
        let todos = rows.map { #"{"content":"\#($0.0)","status":"\#($0.1)","activeForm":"\#($0.0)…"}"# }
        return json(#"{"todos":[\#(todos.joined(separator: ","))]}"#)
    }

    private func liveLine(id: Int, _ name: String, _ input: String) -> TranscriptLine {
        TranscriptLine(id: id, kind: .tool_use, text: "\(name) \(input)")
    }

    private func user(_ id: Int, _ text: String = "сделай") -> TranscriptLine {
        TranscriptLine(id: id, kind: .user, text: text)
    }

    private func plan(_ rows: [(String, String)], name: String = "mcp__hegai__plan") -> RenderBlock {
        .toolUse(id: "t", name: name, input: planInput(rows))
    }

    private func human(_ text: String) -> HistoryMessage {
        HistoryMessage(role: .user, uuid: UUID().uuidString, blocks: [.text(text)])
    }

    private func assistant(_ blocks: [RenderBlock]) -> HistoryMessage {
        HistoryMessage(role: .assistant, uuid: UUID().uuidString, blocks: blocks)
    }

    // MARK: - Names and rows

    func testWhichToolsArePlans() {
        XCTAssertTrue(isPlanTool("mcp__hegai__plan"))
        XCTAssertTrue(isPlanTool("TodoWrite"))
        XCTAssertFalse(isPlanTool("Task"))
        XCTAssertFalse(isPlanTool("mcp__other__plan"))
        XCTAssertFalse(isPlanTool(nil))
    }

    func testMalformedRowsAreDroppedAndStatusDefaultsToPending() throws {
        let items = try XCTUnwrap(Plan.items(json(#"""
        {"todos":[
          {"content":"Один","status":"completed","activeForm":"Делаю один"},
          {"content":"   ","status":"pending"},
          {"content":7,"status":"pending"},
          {"status":"pending"},
          "строка",
          null,
          {"content":"Два","status":"exploded","activeForm":"  "},
          {"content":"Три"}
        ]}
        """#)))
        XCTAssertEqual(items, [
            PlanItem(content: "Один", status: .completed, activeForm: "Делаю один"),
            PlanItem(content: "Два", status: .pending, activeForm: nil),
            PlanItem(content: "Три", status: .pending, activeForm: nil),
        ])
    }

    func testNotAPlanAtAll() {
        XCTAssertNil(Plan.items(json(#"{"x":1}"#)))
        XCTAssertNil(Plan.items(json(#"{"todos":"nope"}"#)))
        XCTAssertNil(Plan.items(.null))
    }

    // MARK: - Progress

    func testProgressCountsAndNamesTheActiveStep() {
        let items = [
            PlanItem(content: "A", status: .completed),
            PlanItem(content: "B", status: .in_progress, activeForm: "  Делаю B  "),
            PlanItem(content: "C", status: .pending),
        ]
        XCTAssertEqual(Plan.progress(items), PlanProgress(done: 1, total: 3, active: "Делаю B"))
    }

    func testActiveFallsBackToContentAndIsAbsentWithoutAStepInProgress() {
        XCTAssertEqual(Plan.progress([PlanItem(content: " Шаг ", status: .in_progress)]).active, "Шаг")
        XCTAssertNil(Plan.progress([PlanItem(content: "Шаг", status: .pending)]).active)
        XCTAssertEqual(Plan.progress([]), PlanProgress(done: 0, total: 0))
    }

    func testActiveIsClippedTo160WithAnEllipsis() throws {
        let long = String(repeating: "я", count: 300)
        let active = try XCTUnwrap(Plan.progress([PlanItem(content: long, status: .in_progress)]).active)
        XCTAssertEqual(active.count, 160)
        XCTAssertTrue(active.hasSuffix("…"))
        XCTAssertEqual(active, String(repeating: "я", count: 159) + "…")
        let exact = String(repeating: "x", count: 160)
        XCTAssertEqual(Plan.progress([PlanItem(content: exact, status: .in_progress)]).active, exact)
    }

    func testFractionAndCount() {
        XCTAssertEqual(PlanProgress(done: 3, total: 5).fraction, 0.6, accuracy: 0.0001)
        XCTAssertEqual(PlanProgress(done: 0, total: 0).fraction, 0)
        XCTAssertEqual(PlanProgress(done: 9, total: 5).fraction, 1)
        XCTAssertEqual(PlanProgress(done: 3, total: 5).count, "3/5")
    }

    func testStripLineIsActiveElseFirstPending() throws {
        let running = CurrentPlan(items: [PlanItem(content: "A", status: .completed),
                                          PlanItem(content: "B", status: .in_progress, activeForm: "Делаю B")])
        XCTAssertEqual(running.activeLine, "Делаю B")
        let between = CurrentPlan(items: [PlanItem(content: "A", status: .completed),
                                          PlanItem(content: "Следующий", status: .pending)])
        XCTAssertEqual(between.activeLine, "Следующий")
        let finished = CurrentPlan(items: [PlanItem(content: "A", status: .completed)])
        XCTAssertNil(finished.activeLine)
    }

    // MARK: - Which plan is current

    func testNoneIsNil() {
        XCTAssertNil(CurrentPlan.current(history: [], lines: []))
        XCTAssertNil(CurrentPlan.current(history: [human("привет"), assistant([.text("ок")])],
                                         lines: [TranscriptLine(id: 1, kind: .assistant, text: "ответ")]))
    }

    func testLatestLiveCallWins() throws {
        let lines = [
            user(1),
            liveLine(id: 2, "mcp__hegai__plan", #"{"todos":[{"content":"A","status":"in_progress"},{"content":"B","status":"pending"}]}"#),
            liveLine(id: 3, "Bash", #"{"command":"ls"}"#),
            liveLine(id: 4, "mcp__hegai__plan", #"{"todos":[{"content":"A","status":"completed"},{"content":"B","status":"in_progress","activeForm":"Делаю B"}]}"#),
        ]
        let current = try XCTUnwrap(CurrentPlan.current(history: [], lines: lines))
        XCTAssertEqual(current.progress, PlanProgress(done: 1, total: 2, active: "Делаю B"))
    }

    func testLiveTailBeatsHistory() throws {
        let history = [human("сделай"), assistant([plan([("Старый", "in_progress")])])]
        let lines = [liveLine(id: 5, "TodoWrite", #"{"todos":[{"content":"Новый","status":"in_progress"},{"content":"Ещё","status":"pending"}]}"#)]
        let current = try XCTUnwrap(CurrentPlan.current(history: history, lines: lines))
        XCTAssertEqual(current.items.map(\.content), ["Новый", "Ещё"])
    }

    func testHistoryIsReadWhenTheLiveTailHasNoPlan() throws {
        let history = [
            human("сделай"),
            assistant([plan([("A", "completed"), ("B", "in_progress")])]),
            assistant([plan([("A", "completed"), ("B", "completed"), ("C", "in_progress")])]),
        ]
        let lines = [liveLine(id: 1, "Bash", #"{"command":"ls"}"#)]
        let current = try XCTUnwrap(CurrentPlan.current(history: history, lines: lines))
        XCTAssertEqual(current.progress.done, 2)
        XCTAssertEqual(current.progress.total, 3)
    }

    func testAPlanBeforeTheLastHumanMessageIsIgnored() {
        let history = [
            human("первое"),
            assistant([plan([("A", "in_progress")])]),
            human("второе"),
            assistant([.text("думаю")]),
        ]
        XCTAssertNil(CurrentPlan.current(history: history, lines: []))
        // The same in the live tail: the person's line closes the search.
        let lines = [
            liveLine(id: 1, "mcp__hegai__plan", #"{"todos":[{"content":"A","status":"in_progress"}]}"#),
            user(2, "новая задача"),
            liveLine(id: 3, "Bash", #"{"command":"ls"}"#),
        ]
        XCTAssertNil(CurrentPlan.current(history: [assistant([plan([("A", "in_progress")])])], lines: lines))
    }

    func testALiveHumanLineEndsTheSearchBeforeTheFile() {
        // Even when the file's last human message reads the same: a repeated
        // «продолжай» must not inherit the previous task's plan.
        let history = [human("продолжай"), assistant([plan([("A", "completed"), ("B", "completed")])])]
        XCTAssertNil(CurrentPlan.current(history: history, lines: [user(9, "продолжай")]))
    }

    func testACallWithoutTodosIsSkippedButAnEmptyListClears() throws {
        let earlier = liveLine(id: 1, "mcp__hegai__plan", #"{"todos":[{"content":"A","status":"in_progress"}]}"#)
        let skipped = try XCTUnwrap(CurrentPlan.current(history: [], lines: [earlier, liveLine(id: 2, "mcp__hegai__plan", "{}")]))
        XCTAssertEqual(skipped.items.map(\.content), ["A"])
        XCTAssertNil(CurrentPlan.current(history: [], lines: [earlier, liveLine(id: 2, "mcp__hegai__plan", #"{"todos":[]}"#)]))
    }

    func testToolResultsAndHarnessNoiseAreNotHumanMessages() throws {
        let result = HistoryMessage(role: .user, uuid: "r", blocks: [.toolResult(toolUseId: "t", text: "ok", isError: false)])
        let noise = human("<system-reminder>не читать</system-reminder>")
        let history = [human("сделай"), assistant([plan([("A", "in_progress")])]), result, noise]
        XCTAssertNotNil(CurrentPlan.current(history: history, lines: []))
    }

    func testTodoWriteCountsInHistoryToo() throws {
        let history = [human("сделай"), assistant([plan([("A", "completed"), ("B", "pending")], name: "TodoWrite")])]
        let current = try XCTUnwrap(CurrentPlan.current(history: history, lines: []))
        XCTAssertEqual(current.progress, PlanProgress(done: 1, total: 2))
        XCTAssertEqual(current.activeLine, "B")
    }

    func testEmptyOrClippedPlansAreSkipped() throws {
        // An empty list clears the plan (nothing to show); a clipped
        // (unparseable) live line is passed over for an earlier call.
        let lines = [
            liveLine(id: 1, "mcp__hegai__plan", #"{"todos":[{"content":"A","status":"in_progress"}]}"#),
            liveLine(id: 2, "mcp__hegai__plan", #"{"todos":[{"content":"A","stat"#),
        ]
        XCTAssertEqual(CurrentPlan.current(history: [], lines: lines)?.items.map(\.content), ["A"])
        XCTAssertNil(CurrentPlan.current(history: [], lines: [liveLine(id: 1, "mcp__hegai__plan", #"{"todos":[]}"#)]))
    }
}
