import XCTest
@testable import CCRemoteKit

@MainActor final class NavigationTitlesTests: XCTestCase {
    func testContextUsesOpeningAndRecentConversationAndPreservesManualTitles() {
        let history = [
            HistoryMessage(role: .user, uuid: "u", blocks: [.text("А глянь айос моб приложение код. Как он тебе?")]),
            HistoryMessage(role: .assistant, uuid: "a", blocks: [.text("Посмотрю приложение.")]),
            HistoryMessage(role: .user, uuid: "u2", blocks: [.text("Исправить форматирование и генерацию заголовков")])
        ]
        let context = NavigationTitles.context(rawTitle: "А глянь айос моб приложение код. Как он тебе?", history: history)
        XCTAssertTrue(context?.contains("Исправить форматирование") == true)
        XCTAssertTrue(context?.contains("А глянь айос") == true)
        XCTAssertNil(NavigationTitles.context(rawTitle: "Мой ручной заголовок", history: history))
    }

    func testMalformedGenerationIsRejectedRatherThanChopped() {
        XCTAssertEqual(NavigationTitles.validated("Доработка iOS-приложения"), "Доработка iOS-приложения")
        for bad in ["Создать веб-сервис для", "Ответ…", String(repeating: "я", count: 41)] {
            XCTAssertNil(NavigationTitles.validated(bad))
        }
    }

    func testWaitsForFirstAnswerBeforeNaming() {
        XCTAssertNil(NavigationTitles.context(rawTitle: "Поправь приложение", history: [
            HistoryMessage(role: .user, uuid: "u", blocks: [.text("Поправь приложение")])
        ]))
    }

    func testGeneratedNameSurvivesNewTurnsAndRelaunchWithoutExpiring() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let id = ClientStorage.digest(["m", "claude", "s"])
        let saved = [id: NavigationTitles.Entry(raw: "Поправь приложение", title: "Доработка приложения",
                                               fingerprint: "old", checked: .distantPast, manual: false)]
        try JSONEncoder().encode(saved).write(to: dir.appendingPathComponent("NavigationTitles.v1.json"))
        var session = SessionSummary(sessionId: "s", title: "Поправь приложение", project: nil,
                                     lastModified: Date().timeIntervalSince1970 * 1000)
        let titles = NavigationTitles(directory: dir)
        XCTAssertEqual(titles.label(machineId: "m", session: session), "Доработка приложения")
        let harness = ClientHarness()
        defer { harness.clean() }
        await harness.connect()
        session.cwd = "/projects/demo"
        let before = Date()
        await titles.prepare(client: harness.client, machineId: "m", session: session)
        XCTAssertLessThan(Date().timeIntervalSince(before), 0.5)
        XCTAssertTrue(harness.sockets.last!.frames(of: "rpc_request").isEmpty)
        XCTAssertTrue(harness.sockets.last!.frames(of: "enrich_request").isEmpty)
        // An explicit user rename must still replace the frozen generated title.
        titles.renamed(machineId: "m", sessionId: "s", source: nil, title: "Моё название")
        session.title = "Моё название"
        XCTAssertEqual(NavigationTitles(directory: dir).label(machineId: "m", session: session), "Моё название")
    }

    func testManualNamePersistsAndIsIsolatedByMachineAndSource() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let titles = NavigationTitles(directory: dir)
        titles.renamed(machineId: "m", sessionId: "s", source: "codex", title: "Моё имя")
        var session = SessionSummary(sessionId: "s", title: "Моё имя", project: nil, lastModified: 0)
        session.source = "codex"
        XCTAssertEqual(NavigationTitles(directory: dir).label(machineId: "m", session: session), "Моё имя")
        session.title = "Другая сессия"
        XCTAssertEqual(titles.label(machineId: "other", session: session), "Другая сессия")
    }
    /// 24.10.2026 (iOS audit 9): a session that has no title to generate was asked
    /// about again every minute for every visible drawer row. The «no» is kept per
    /// session version and across launches.
    func testNoTitleVerdictIsRememberedPerSessionVersionAndPersisted() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let titles = NavigationTitles(directory: dir)
        let harness = ClientHarness()
        defer { harness.clean() }
        await harness.connect()
        // A custom title: no generated title is ever proposed for it.
        var session = SessionSummary(sessionId: "s", title: "Мой ручной заголовок", project: nil, lastModified: 1000)
        session.cwd = "/projects/demo"
        let cached = try JSONDecoder().decode(JSONValue.self, from: Data(
            #"{"messages":[{"type":"user","uuid":"u","blocks":[{"kind":"text","text":"Привет"}]},{"type":"assistant","uuid":"a","blocks":[{"kind":"text","text":"Здравствуйте"}]}]}"#.utf8))
        await harness.client.transcripts.write(TranscriptCache.key(machineId: "m", sessionId: "s"),
                                               payload: cached, lastModified: 1000)
        let socket = harness.sockets.last!
        let run = Task { await titles.prepare(client: harness.client, machineId: "m", session: session) }
        // The opening-of-session probe is the only request it makes; answer it.
        for _ in 0..<200 where socket.frames(of: "rpc_request").isEmpty { try await Task.sleep(for: .milliseconds(25)) }
        let request = try XCTUnwrap(socket.frames(of: "rpc_request").first)
        socket.feed(#"{"type":"rpc_response","requestId":"\#(request["requestId"] as? String ?? "")","ok":true,"result":{"messages":[]}}"#)
        await run.value
        XCTAssertTrue(titles.hasDeclined(machineId: "m", session: session))
        XCTAssertEqual(socket.frames(of: "enrich_request").count, 0)

        let before = Date()
        await titles.prepare(client: harness.client, machineId: "m", session: session)
        XCTAssertLessThan(Date().timeIntervalSince(before), 0.5, "a known «no» returns without the debounce or any request")
        XCTAssertEqual(socket.frames(of: "rpc_request").count, 1)

        XCTAssertTrue(NavigationTitles(directory: dir).hasDeclined(machineId: "m", session: session), "survives a relaunch")
        var moved = SessionSummary(sessionId: "s", title: "Мой ручной заголовок", project: nil, lastModified: 2000)
        moved.cwd = "/projects/demo"
        XCTAssertFalse(titles.hasDeclined(machineId: "m", session: moved), "a session that moved is asked again")
    }
}
