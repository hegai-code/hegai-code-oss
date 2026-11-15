import XCTest
@testable import CCRemoteKit
@testable import CCRemote

/// Sub-agents in the chat (web f09d5ba / 8bf9c74 / f47a2c9): the `subagents`
/// level, the parent transcript's own record of how a call ended, and where
/// the card is anchored. Frames are the shapes the agent and hub send.
@MainActor
final class SubagentTests: XCTestCase {
    private func decode(_ json: String) throws -> HubMessage {
        try JSONDecoder().decode(HubMessage.self, from: Data(json.utf8))
    }

    private static let level = #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"subagents","data":{"agents":[{"id":"a1","toolUseId":"toolu_1","kind":"Explore","description":"Найти разбор","status":"running","background":true,"startedAt":1000,"toolUses":3,"tokens":41800,"lastAction":"Grep · background_tasks"},{"id":"a2","kind":"general-purpose","description":"Без статуса","startedAt":1},{"id":"a3","kind":"x","description":"Плохой статус","status":"exploded","startedAt":1},{"id":"","kind":"x","description":"Пустой id","status":"running","startedAt":1},{"id":"a4","kind":"general-purpose","description":"Готов","status":"completed","startedAt":1000,"endedAt":84000,"toolUses":"много","summary":"Отчёт"},{"id":"a5","kind":"general-purpose","description":"Готов","status":"completed","startedAt":1000,"endedAt":84000,"toolUses":4,"summary":"Отчёт"}]}}}"#

    // MARK: - Decoding

    func testLevelDecodesAndDropsMalformedRowsOneByOne() throws {
        guard case let .stream(_, _, event) = try decode(Self.level) else { return XCTFail("wrong case") }
        let agents = try XCTUnwrap(event.data?.agents)
        XCTAssertEqual(agents.map(\.id), ["a1", "a5"],
                       "rows missing a required field, with an unknown status or a mistyped optional drop — as zod drops them on web")
        XCTAssertEqual(agents[0].toolUseId, "toolu_1")
        XCTAssertEqual(agents[0].status, .running)
        XCTAssertEqual(agents[0].background, true)
        XCTAssertEqual(agents[0].lastAction, "Grep · background_tasks")
        XCTAssertEqual(agents[1].toolUses, 4)
        XCTAssertEqual(agents[1].summary, "Отчёт")
        XCTAssertNil(event.data?.tasks)
    }

    func testEmptyAndMissingLevel() throws {
        guard case let .stream(_, _, empty) = try decode(
            #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"subagents","data":{"agents":[]}}}"#
        ) else { return XCTFail("wrong case") }
        XCTAssertEqual(empty.data?.agents, [])
        guard case let .stream(_, _, broken) = try decode(
            #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"subagents","data":{"agents":"nope"}}}"#
        ) else { return XCTFail("wrong case") }
        XCTAssertNil(broken.data?.agents, "a broken level must not fail the frame")
    }

    func testPlanIsOptionalAndLossy() throws {
        let row = { (plan: String) in
            #"{"id":"a1","kind":"Explore","description":"d","status":"running","startedAt":1000"# + plan + "}"
        }
        func agent(_ plan: String) throws -> Subagent {
            try JSONDecoder().decode(Subagent.self, from: Data(row(plan).utf8))
        }
        XCTAssertNil(try agent("").plan, "an old agent sends no plan")
        XCTAssertEqual(try agent(#","plan":{"done":3,"total":5,"active":"Гоняю тесты"}"#).plan,
                       PlanProgress(done: 3, total: 5, active: "Гоняю тесты"))
        XCTAssertEqual(try agent(#","plan":{"done":0,"total":2}"#).plan, PlanProgress(done: 0, total: 2))
        for bad in [#","plan":"nope""#, #","plan":{"done":"3","total":5}"#, #","plan":{"done":-1,"total":5}"#,
                    #","plan":{"done":1}"#, #","plan":null"#, #","plan":{"done":1,"total":2,"active":null}"#] {
            let decoded = try agent(bad)
            XCTAssertEqual(decoded.id, "a1", "a malformed plan must not drop the row: \(bad)")
            XCTAssertNil(decoded.plan, bad)
        }
    }

    func testPlanSurvivesInsideALevelFrame() throws {
        guard case let .stream(_, _, event) = try decode(
            #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"subagents","data":{"agents":[{"id":"a1","kind":"x","description":"d","status":"running","startedAt":1,"plan":{"done":1,"total":4,"active":"Пишу"}},{"id":"a2","kind":"x","description":"d","status":"running","startedAt":1,"plan":[1]}]}}}"#
        ) else { return XCTFail("wrong case") }
        let agents = try XCTUnwrap(event.data?.agents)
        XCTAssertEqual(agents.map(\.id), ["a1", "a2"])
        XCTAssertEqual(agents[0].plan?.total, 4)
        XCTAssertNil(agents[1].plan)
    }

    func testToolUseFrameCarriesCallId() throws {
        guard case let .stream(_, _, event) = try decode(
            #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Agent {\"description\":\"x\"}","data":{"id":"toolu_9"}}}"#
        ) else { return XCTFail("wrong case") }
        XCTAssertEqual(event.data?.id, "toolu_9")
    }

    // MARK: - The client keeps a level per run

    private func attached() async -> (ClientHarness, TestSocket) {
        let h = ClientHarness()
        await h.connect()
        let socket = h.sockets.last!
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":2}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        for _ in 0..<100 where h.client.active?.runId == nil { await h.settle() }
        return (h, socket)
    }

    func testLevelReplacesTheLastAndIgnoresOtherRuns() async {
        let (h, socket) = await attached(); defer { h.clean() }
        socket.feed(Self.level)
        for _ in 0..<100 where h.client.subagents.isEmpty { await h.settle() }
        XCTAssertEqual(h.client.subagents.map(\.id), ["a1", "a5"])
        XCTAssertTrue(h.client.lines.isEmpty, "a level is state, never a transcript line")

        socket.feed(#"{"type":"stream","runId":"other","sessionId":"x","event":{"kind":"status","text":"","code":"subagents","data":{"agents":[]}}}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"subagents","data":{"agents":[{"id":"a1","toolUseId":"toolu_1","kind":"Explore","description":"Найти разбор","status":"completed","startedAt":1000,"endedAt":5000}]}}}"#)
        for _ in 0..<100 where h.client.subagents.count != 1 { await h.settle() }
        XCTAssertEqual(h.client.subagents.map(\.status), [.completed], "each frame replaces the last; another run's is ignored")
    }

    func testResubscribeForgetsTheLevelUntilTheHubRestatesIt() async {
        let (h, socket) = await attached(); defer { h.clean() }
        socket.feed(Self.level)
        for _ in 0..<100 where h.client.subagents.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "elsewhere")
        XCTAssertTrue(h.client.subagents.isEmpty, "another session's chat never shows this run's helpers")
        h.client.focusSession(machineId: "m", sessionId: "s")
        await h.settle()
        XCTAssertEqual(h.client.active?.runId, "r")
        XCTAssertTrue(h.client.subagents.isEmpty, "a set that emptied while away must not survive the re-attach")
    }

    func testLiveToolUseLineKeepsItsCallIdAndAnchorsTheCard() async {
        let (h, socket) = await attached(); defer { h.clean() }
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"assistant","text":"Запускаю помощника."}}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Agent {\"subagent_type\":\"Explore\",\"description\":\"Найти разбор\"}","data":{"id":"toolu_1"}}}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Bash {\"command\":\"ls\"}","data":{"id":"toolu_2"}}}"#)
        for _ in 0..<100 where h.client.lines.count < 3 { await h.settle() }
        XCTAssertEqual(h.client.lines.filter { $0.kind == .tool_use }.map(\.toolUseId), ["toolu_1", "toolu_2"])

        let rows = transcriptRows(history: [], live: groupLive(h.client.lines), busy: true)
        let carrying = rows.filter { !$0.agentCalls.isEmpty }
        XCTAssertEqual(carrying.count, 1)
        XCTAssertEqual(carrying.first?.id, rows.first { if case .live = $0.content { return true }; return false }?.id,
                       "the card sits under the paragraph that announced the call")
        XCTAssertEqual(carrying.first?.agentCalls,
                       [SubagentCall(toolUseId: "toolu_1", kind: "Explore", description: "Найти разбор")])
    }

    // MARK: - Anchoring in history

    func testHistoryCardRidesTheParagraphThatStartedIt() {
        let history = [
            HistoryMessage(role: .user, uuid: "u", blocks: [.text("Почини")]),
            HistoryMessage(role: .assistant, uuid: "a1", blocks: [
                .text("Запускаю двух помощников."),
                .toolUse(id: "toolu_A", name: "Agent", input: .object(["subagent_type": .string("Explore"),
                                                                      "description": .string("Поиск")])),
                .toolUse(id: "toolu_B", name: "Task", input: .object(["prompt": .string("Прогнать тесты целиком")])),
            ]),
            HistoryMessage(role: .user, uuid: "r", blocks: [
                .toolResult(toolUseId: "toolu_A", text: "Нашёл.", isError: false),
                .toolResult(toolUseId: "toolu_B", text: "Async agent launched successfully.", isError: false),
            ]),
            HistoryMessage(role: .assistant, uuid: "a2", blocks: [.text("Итог.")]),
        ]
        let rows = transcriptRows(history: groupHistory(history))
        let carrying = rows.filter { !$0.agentCalls.isEmpty }
        XCTAssertEqual(carrying.count, 1)
        XCTAssertEqual(carrying[0].agentCalls.map(\.toolUseId), ["toolu_A", "toolu_B"])
        XCTAssertEqual(carrying[0].agentCalls[1].kind, "агент", "no subagent_type → a plain «агент»")
        XCTAssertEqual(carrying[0].agentCalls[1].description, "Прогнать тесты целиком", "the prompt stands in for a missing description")
        XCTAssertTrue(rows.last?.agentCalls.isEmpty ?? false, "the summary started nothing")
    }

    // MARK: - Notices

    func testForegroundResultCompletesAndAnErrorFails() {
        let notices = SubagentNotices.from(history: [
            HistoryMessage(role: .assistant, uuid: "a", blocks: [
                .toolUse(id: "ok", name: "Agent", input: .null),
                .toolUse(id: "bad", name: "Agent", input: .null),
                .toolUse(id: "bash", name: "Bash", input: .null),
            ]),
            HistoryMessage(role: .user, uuid: "r", blocks: [
                .toolResult(toolUseId: "ok", text: "  Отчёт помощника.  ", isError: false),
                .toolResult(toolUseId: "bad", text: "Упал.", isError: true),
                .toolResult(toolUseId: "bash", text: "ls", isError: false),
            ]),
        ])
        XCTAssertEqual(notices["ok"], AgentNotice(status: .completed, summary: "Отчёт помощника."))
        XCTAssertEqual(notices["bad"]?.status, .failed)
        XCTAssertNil(notices["bash"], "only Agent/Task calls are cards")
    }

    func testAsyncThenTaskNotificationCarriesStatusAndReport() {
        let notices = SubagentNotices.from(history: [
            HistoryMessage(role: .assistant, uuid: "a", blocks: [.toolUse(id: "bg", name: "Agent", input: .null)]),
            HistoryMessage(role: .user, uuid: "r", blocks: [
                .toolResult(toolUseId: "bg", text: "Async agent launched successfully.\nagentId: x", isError: false),
            ]),
        ])
        XCTAssertEqual(notices["bg"], AgentNotice(async: true), "launched is not an ending")

        let ended = SubagentNotices.from(history: [
            HistoryMessage(role: .assistant, uuid: "a", blocks: [.toolUse(id: "bg", name: "Agent", input: .null)]),
            HistoryMessage(role: .user, uuid: "r", blocks: [
                .toolResult(toolUseId: "bg", text: "Async agent launched successfully.", isError: false),
                .text("<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>bg</tool-use-id>\n<status>failed</status>\n<result>Нет доступа к симулятору.</result>\n</task-notification>"),
            ]),
        ])
        XCTAssertEqual(ended["bg"], AgentNotice(status: .failed, summary: "Нет доступа к симулятору.", async: true))
    }

    func testFirstEndingWins() {
        let note = { (status: String, result: String) in
            "<task-notification><tool-use-id>bg</tool-use-id><status>\(status)</status><result>\(result)</result></task-notification>"
        }
        let notices = SubagentNotices.from(history: [
            HistoryMessage(role: .assistant, uuid: "a", blocks: [.toolUse(id: "bg", name: "Agent", input: .null)]),
            HistoryMessage(role: .user, uuid: "r", blocks: [
                .toolResult(toolUseId: "bg", text: "Async agent launched successfully.", isError: false),
                .text(note("killed", "Остановлен на середине.")),
                .text(note("completed", "Готово.")),
            ]),
        ])
        XCTAssertEqual(notices["bg"]?.status, .stopped, "a Stop and then the CLI's trailing «completed» reads stopped")
        XCTAssertEqual(notices["bg"]?.summary, "Остановлен на середине.")
    }

    func testTaskNoticeParsing() {
        XCTAssertNil(TaskNotice(text: "просто текст"))
        let n = TaskNotice(text: "<task-notification><task-id>t</task-id><tool-use-id> toolu_1 </tool-use-id><status>weird</status><summary>Кратко</summary></task-notification>")
        XCTAssertEqual(n?.toolUseId, "toolu_1")
        XCTAssertEqual(n?.taskId, "t")
        XCTAssertNil(n?.status, "an unknown status is no status")
        XCTAssertEqual(n?.summary, "Кратко", "<summary> stands in for a missing <result>")
    }

    // MARK: - Panel and format

    func testPanelJoinsBackgroundTasksWithAgentsAndSkipsAnchored() {
        let fg = Subagent(id: "fg", toolUseId: "toolu_fg", kind: "Explore", description: "Передний план",
                          status: .running, startedAt: 10)
        let codex = Subagent(id: "child", kind: "worker", description: "Codex-ребёнок", status: .running, startedAt: 20)
        let bg = Subagent(id: "bg", toolUseId: "toolu_bg", kind: "general-purpose", description: "Фон",
                          status: .running, background: true, startedAt: 5, tokens: 1200, lastAction: "Bash · ls")
        let done = Subagent(id: "done", kind: "x", description: "Готов", status: .completed, startedAt: 1)
        let rows = SubagentPanelRow.rows(
            background: [RunBackgroundTask(id: "bg", type: "local_agent", description: "что-то", since: 99),
                         RunBackgroundTask(id: "sh", type: "local_bash", description: "npm run dev", since: 50)],
            agents: [fg, codex, bg, done], anchored: ["toolu_fg"])
        XCTAssertEqual(rows.map(\.id), ["bg", "sh", "child"])
        let carded = SubagentPanelRow.rows(
            background: [RunBackgroundTask(id: "bg", type: "local_agent", description: "что-то", since: 99)],
            agents: [bg], anchored: ["toolu_bg"])
        XCTAssertTrue(carded.isEmpty, "a background helper with a card in this turn is not a second row")
        let older = SubagentPanelRow.rows(
            background: [RunBackgroundTask(id: "bg", type: "local_agent", description: "что-то", since: 99)],
            agents: [bg], anchored: ["toolu_bg"], near: [])
        XCTAssertEqual(older.map(\.id), ["bg"], "one launched turns ago may be above the window: it keeps its row")
        XCTAssertEqual(rows[0].label, "Фон", "the agent's own description beats the task's")
        XCTAssertEqual(rows[0].since, 5)
        XCTAssertEqual(rows[0].toolUseId, "toolu_bg")
        XCTAssertNil(rows[1].agent)
        XCTAssertEqual(rows[1].label, "Npm run dev")
    }

    func testPanelFoldsRepeatsPerOwnerAndNamesThem() {
        let helper = Subagent(id: "bg", toolUseId: "toolu_bg", kind: "implementer", description: "Фон",
                              status: .running, background: true, startedAt: 5)
        let rows = SubagentPanelRow.rows(
            background: [RunBackgroundTask(id: "m1", type: "local_bash", description: "my shots done", since: 300, owner: "Admin layout", ownerId: "h1"),
                         RunBackgroundTask(id: "o1", type: "local_bash", description: "npm test", since: 100),
                         RunBackgroundTask(id: "m2", type: "local_bash", description: " my shots done ", since: 200, owner: "Admin layout", ownerId: "h1"),
                         RunBackgroundTask(id: "r1", type: "local_bash", description: "my shots done", since: 50, owner: "Admin layout", ownerId: "h2"),
                         RunBackgroundTask(id: "e1", type: "local_bash", description: "", since: 10),
                         RunBackgroundTask(id: "e2", type: "local_bash", description: "", since: 20),
                         RunBackgroundTask(id: "bg", type: "local_agent", description: "Фон", since: 99)],
            agents: [helper], anchored: [], near: [])
        XCTAssertEqual(rows.map(\.id), ["m1", "o1", "r1", "e1", "e2", "bg"])
        XCTAssertEqual(rows[0].ids, ["m1", "m2"], "Stop must reach every repeat")
        XCTAssertEqual(rows[0].since, 200, "the row's clock is the oldest repeat's")
        XCTAssertEqual(rows[0].owner, "Admin layout")
        XCTAssertEqual(rows[1].ids, ["o1"])
        XCTAssertNil(rows[1].owner)
        XCTAssertEqual(rows[5].ids, ["bg"], "a sub-agent row stops itself")
    }

    func testNoRepeatKeyForASubAgentOrACutDescription() {
        XCTAssertNil(RunBackgroundTask(id: "a", type: "local_agent", description: "Fix layout", since: 0).repeatKey)
        XCTAssertNil(RunBackgroundTask(id: "b", type: "local_bash", description: String(repeating: "x", count: 200), since: 0).repeatKey)
        XCTAssertNotNil(RunBackgroundTask(id: "c", type: "local_bash", description: String(repeating: "x", count: 199), since: 0).repeatKey)
    }

    func testRecentAndQuiet() throws {
        guard case let .stream(_, _, event) = try decode(
            #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"subagents","data":{"agents":[{"id":"a","kind":"x","description":"y","status":"running","startedAt":0,"lastAction":"Bash · d","recent":["Grep · b","Edit · c","Bash · z"],"activeAt":10000},{"id":"long","kind":"x","description":"y","status":"running","startedAt":0,"recent":["1","2","3","4"]},{"id":"typed","kind":"x","description":"y","status":"running","startedAt":0,"recent":["1",7]}]}}}"#
        ) else { return XCTFail("wrong case") }
        let a = try XCTUnwrap(event.data?.agents?.first)
        XCTAssertEqual(event.data?.agents?.map(\.id), ["a"], "more than three steps or a non-string step fails the row, as on web")
        XCTAssertEqual(a.recent, ["Grep · b", "Edit · c", "Bash · z"])
        XCTAssertEqual(a.activeAt, 10_000)
        XCTAssertNil(SubagentFormat.quiet(a, nowMs: 39_999), "under 30 s is not quiet")
        XCTAssertEqual(SubagentFormat.quiet(a, nowMs: 75_000), 65_000)
        XCTAssertEqual(SubagentFormat.clock(ms: 65_000), "1:05")
        var done = a
        done.status = .completed
        XCTAssertNil(SubagentFormat.quiet(done, nowMs: 999_000), "only a running agent can be quiet")
        done.status = .running
        done.activeAt = nil
        XCTAssertNil(SubagentFormat.quiet(done, nowMs: 999_000), "no activeAt — no claim")
    }

    func testNullOptionalAndUTF16LengthFailTheRow() throws {
        let flags = String(repeating: "🇷🇺", count: 41)   // 41 graphemes, 164 UTF-16 units
        let json = """
        {"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"subagents","data":{"agents":[\
        {"id":"ok","kind":"x","description":"y","status":"running","startedAt":0},\
        {"id":"nul","kind":"x","description":"y","status":"running","startedAt":0,"background":null},\
        {"id":"wide","kind":"\(flags)","description":"y","status":"running","startedAt":0}]}}}
        """
        guard case let .stream(_, _, event) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(event.data?.agents?.map(\.id), ["ok"])
    }

    func testBlankResultLeavesRoomForALaterReport() {
        let notices = SubagentNotices.from(history: [
            HistoryMessage(role: .assistant, uuid: "a", blocks: [.toolUse(id: "c", name: "Agent", input: .null)]),
            HistoryMessage(role: .user, uuid: "r", blocks: [
                .toolResult(toolUseId: "c", text: "   ", isError: false),
                .text("<task-notification><tool-use-id>c</tool-use-id><status>failed</status><result>Отчёт.</result></task-notification>"),
            ]),
        ])
        XCTAssertEqual(notices["c"]?.status, .completed, "the first ending stays")
        XCTAssertEqual(notices["c"]?.summary, "Отчёт.")
    }

    func testClockSurvivesExtremeTimestamps() {
        XCTAssertEqual(SubagentFormat.clock(ms: -1e308), "0с")
        XCTAssertFalse(SubagentFormat.clock(ms: 1e308).isEmpty)
        XCTAssertEqual(SubagentFormat.clock(ms: .infinity), "0с")
    }

    func testMetaLine() {
        let running = Subagent(id: "a", kind: "x", description: "y", status: .running, startedAt: 0,
                               toolUses: 12, tokens: 41_800)
        XCTAssertEqual(SubagentFormat.meta(running, nowMs: 83_000), "12 вызовов · 42k токенов · 1:23")
        let ended = Subagent(id: "a", kind: "x", description: "y", status: .completed, startedAt: 0,
                             endedAt: 42_000, toolUses: 1)
        XCTAssertEqual(SubagentFormat.meta(ended, nowMs: 999_000), "1 вызов · 42с")
        XCTAssertEqual(SubagentFormat.tokens(812), "812")
    }
}
