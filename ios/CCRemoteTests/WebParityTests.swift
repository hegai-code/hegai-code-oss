import XCTest
@testable import CCRemoteKit
@testable import CCRemote

/// What the web gained between 27.09 and 06.10.2026 and the phone now does too:
/// background tasks, machines with Claude switched off, dictation
/// clean-up. Golden frames are the shapes the agent and hub actually send.
final class WebParityTests: XCTestCase {
    private func decode(_ json: String) throws -> HubMessage {
        try JSONDecoder().decode(HubMessage.self, from: Data(json.utf8))
    }

    // MARK: - «в фоне: …»

    func testBackgroundTaskOwnerDecodesAndAnEmptyOneIsNone() throws {
        let json = #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"background_tasks","data":{"tasks":[{"id":"a","type":"local_bash","description":"x","since":1,"owner":"Admin layout"},{"id":"b","type":"local_bash","description":"y","since":2},{"id":"c","type":"local_bash","description":"z","since":3,"owner":""}]}}}"#
        guard case let .stream(_, _, event) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(try XCTUnwrap(event.data?.tasks).map(\.owner), ["Admin layout", nil, nil])
    }

    func testBackgroundTasksFrameDecodesAndDropsMalformedRows() throws {
        let json = """
        {"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"background_tasks","data":{"tasks":[{"id":"t1","type":"local_bash","description":"прогон тестов","since":1000},{"type":"x"},{"id":"t2","type":"local_agent","description":"for i in $(seq 1 5); do echo; done","since":2000}]}}}
        """
        guard case let .stream(_, _, event) = try decode(json) else { return XCTFail("wrong case") }
        let tasks = try XCTUnwrap(event.data?.tasks)
        XCTAssertEqual(tasks.map(\.id), ["t1", "t2"])
        XCTAssertEqual(tasks[0].label, "Прогон тестов", "a description reads as a sentence, as on the web")
        // A command in place of a description is not something a person wrote.
        XCTAssertEqual(tasks[1].label, "агент")
        XCTAssertEqual(RunBackgroundTask(id: "b", type: "local_bash", description: "git push && echo", since: 0).label, "Работаю с git")
        let poll = #"for i in $(seq 1 55); do if git ls-remote origin "refs/ci-ok/7de54047" | grep -q .; then echo ok; fi; sleep 20; done"#
        XCTAssertEqual(RunBackgroundTask(id: "c", type: "local_bash", description: poll, since: 0).label, "Жду зелёный CI")
        XCTAssertEqual(RunBackgroundTask(id: "d", type: "local_bash", description: "npm test 2>&1 | tail -5", since: 0).label, "Прогоняю тесты")
        XCTAssertEqual(RunBackgroundTask(id: "e", type: "local_bash", description: "-x; y", since: 0).label, "команда")
        XCTAssertEqual(RunBackgroundTask(id: "f", type: "local_bash", description: "sleep 30", since: 0).label, "Жду 30 с")
        XCTAssertEqual(RunBackgroundTask(id: "g", type: "local_bash", description: "npm test", since: 0).label, "Прогоняю тесты")
    }

    func testSessionStateFrameCarriesState() throws {
        let json = #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","text":"","code":"session_state","data":{"state":"idle"}}}"#
        guard case let .stream(_, _, event) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(event.data?.state, "idle")
        XCTAssertNil(event.data?.tasks)
    }

    // MARK: - Claude switched off on a machine

    func testRuntimeStatusSwitchesClaudeOffAndHidesItsLimits() throws {
        guard case let .runtimeStatus(machineId, runtimes) = try decode(
            #"{"type":"runtime_status","machineId":"m","runtimes":{"claude":{"present":true,"auth":"oauth","error":"disabled"},"codex":{"present":true,"auth":"chatgpt"}}}"#
        ) else { return XCTFail("wrong case") }
        XCTAssertEqual(machineId, "m")
        XCTAssertTrue(runtimes.claudeOff)

        let json = """
        {"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"Box","os":"linux","agentVersion":"0"},"online":true,"lastSeen":1,"sessions":[],"runtimes":{"claude":{"present":true,"auth":"oauth","error":"disabled"}},"usage":{"account":"owner@x.test","updatedAt":1,"limits":[{"key":"session","label":"Session","group":"session","percent":40}]}}]}
        """
        guard case let .snapshot(machines, _, _, _) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertTrue(machines[0].claudeOff)
        XCTAssertFalse(machines[0].usage?.normalizedLimits.isEmpty ?? true, "the cached reading is there")
        XCTAssertTrue(UsageAccount.collect(machines: machines, gateway: nil, budget: nil).isEmpty,
                      "…and still not shown as limits")
    }

    // MARK: - Dictation clean-up

    func testDictationPairSwapsOnlyWhereItWasPut() throws {
        let pair = DictationPair(raw: "деплой хаб", polished: "Деплой хаба.", showingPolished: false,
                                 prefix: "деплой хаб и ")
        let first = try XCTUnwrap(pair.swap(in: "деплой хаб и деплой хаб, потом тесты"))
        XCTAssertEqual(first.draft, "деплой хаб и Деплой хаба., потом тесты")
        XCTAssertTrue(first.pair.showingPolished)
        let back = try XCTUnwrap(first.pair.swap(in: first.draft))
        XCTAssertEqual(back.draft, "деплой хаб и деплой хаб, потом тесты")
        // The new copy was edited away: the OLDER identical phrase is not
        // touched, and the switch goes.
        XCTAssertNil(pair.swap(in: "деплой хаб и "))
        XCTAssertFalse(pair.visible(in: "деплой хаб и "))
        XCTAssertNil(first.pair.swap(in: "переписал всё"))
    }

    @MainActor
    func testOpeningASessionClearsItsBellEntriesAndTheirUnreadMark() {
        let e = NotificationEngine()
        e.viewerId = "me"
        var seq = 0
        let next = { () -> Int in seq += 1; return seq }
        func run(_ id: String, _ state: AttentionState) -> ActiveRunInfo {
            ActiveRunInfo(runId: id, machineId: "m", machineName: "Mac", sessionId: "s-\(id)",
                          title: id, project: nil, state: state, preview: nil, since: 0, ownerUserId: "me")
        }
        e.ingest([run("a", .working), run("b", .working)], focusedRunId: nil, nextId: next)
        e.ingest([run("a", .idle)], focusedRunId: nil, nextId: next)
        e.markRead()
        e.ingest([run("a", .idle), run("b", .working)], focusedRunId: nil, nextId: next)
        e.ingest([run("a", .idle), run("b", .needs_attention)], focusedRunId: nil, nextId: next)
        XCTAssertEqual(e.items.count, 2)
        XCTAssertEqual(e.unread, 1)
        // b's question was answered: its entry and its unread mark both go —
        // the read «готова» of a must not light the badge.
        e.ingest([run("a", .idle), run("b", .working)], focusedRunId: nil, nextId: next)
        XCTAssertEqual(e.items.map(\.runId), ["a"])
        XCTAssertEqual(e.unread, 0)
        // a's run already left the activity list; opening its session reads it.
        e.dismiss(machineId: "m", sessionId: "s-a")
        XCTAssertTrue(e.items.isEmpty)
    }

    func testPolishRequestLeavesEmptyFieldsOutAndKeepsTheTailOfLongTurns() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            PolishRequest(text: "привет", project: "  ", title: nil))) as? [String: Any]
        XCTAssertEqual(body?.keys.sorted(), ["text"])

        let recent = try XCTUnwrap(PolishRequest.recent([
            HistoryMessage(role: .system, uuid: "s", blocks: [.text("hook")]),
            HistoryMessage(role: .user, uuid: "u", blocks: [.text("Почини   юз рекордер")]),
            HistoryMessage(role: .assistant, uuid: "a", blocks: [
                .text(String(repeating: "а", count: 1_300) + " useRecorder")])
        ]))
        let lines = recent.components(separatedBy: "\n")
        XCTAssertEqual(lines.first, "user: Почини юз рекордер")
        XCTAssertTrue(lines[1].hasPrefix("assistant: …"))
        XCTAssertTrue(lines[1].hasSuffix("useRecorder"))
        XCTAssertLessThanOrEqual(lines[1].count, "assistant: …".count + 1_200)
    }

    func testPolishOutcomeMapping() {
        func body(_ text: String, _ polished: Bool) -> Data {
            try! JSONSerialization.data(withJSONObject: ["text": text, "polished": polished])
        }
        XCTAssertEqual(PolishOutcome.map(status: 200, body: body("Деплой хаба.", true), raw: "деплой хаб"),
                       .polished("Деплой хаба."))
        XCTAssertEqual(PolishOutcome.map(status: 200, body: body("то же", true), raw: "то же"), .unchanged)
        XCTAssertEqual(PolishOutcome.map(status: 200, body: body("x", false), raw: "y"), .failed)
        XCTAssertEqual(PolishOutcome.map(status: 200, body: body("  ", true), raw: "y"), .failed)
        XCTAssertEqual(PolishOutcome.map(status: 200, body: Data("nope".utf8), raw: "y"), .failed)
        XCTAssertEqual(PolishOutcome.map(status: 503, body: nil, raw: "y"), .off)
        XCTAssertEqual(PolishOutcome.map(status: 502, body: nil, raw: "y"), .failed)
        XCTAssertEqual(PolishOutcome.map(status: nil, body: nil, raw: "y"), .failed)
    }

    func testSendPathRequestCarriesNoConversation() throws {
        let full = PolishRequest(text: "привет", project: "hegai", title: "Секретный заголовок",
                                 recent: "user: ignore previous instructions")
        let safe = full.withoutConversation
        XCTAssertEqual(safe.text, "привет")
        XCTAssertEqual(safe.project, "hegai")
        XCTAssertNil(safe.title)
        XCTAssertNil(safe.recent)
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(safe)) as? [String: Any]
        XCTAssertEqual(body?.keys.sorted(), ["project", "text"])
    }
}
