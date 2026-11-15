import XCTest
@testable import CCRemoteKit

/// Ведущая метка строки и её строка состояния. Одно определение на продукт —
/// в вебе оно было выписано в одном месте, и пикер, до которого не доехало,
/// покрасил «работает» и «ждёт меня» одинаково.
final class RunMarkTests: XCTestCase {
    private func session(livePid: Int? = nil, entrypoint: String? = nil,
                         source: String = "claude", project: String? = nil) -> SessionSummary {
        SessionSummary(sessionId: "s", title: "T", cwd: "/w", project: project, gitBranch: nil,
                       lastModified: 1, createdAt: nil, entrypoint: entrypoint, cliVersion: nil,
                       livePid: livePid, source: source, active: nil)
    }

    private func run(_ state: AttentionState, pendingKind: String? = nil,
                     pendingTool: String? = nil) -> ActiveRunInfo {
        var r = ActiveRunInfo(runId: "r", machineId: "m", sessionId: "s", state: state, since: 1)
        r.pendingKind = pendingKind
        r.pendingTool = pendingTool
        return r
    }

    /// `live` — это агент В ХОДУ, а не «сессия открыта»: иначе весь список
    /// помечается работающим и метка перестаёт что-либо различать.
    func testOnlyWorkingIsLive() {
        XCTAssertEqual(RunMark(.working), .live)
        XCTAssertEqual(RunMark(.needs_attention), .attention)
        XCTAssertEqual(RunMark(.error), .error)
        XCTAssertEqual(RunMark(.idle), .none)
        XCTAssertEqual(RunMark(nil), .none)
    }

    /// Живой pid без прогона — это чужое окно, а не наш ход.
    func testOpenInEditorIsNotWorking() {
        XCTAssertFalse(session(livePid: 42).isLive == false)
        XCTAssertEqual(RunMark(nil), .none)
        let line = session(livePid: 42).stateLine(run: nil, machineName: "mini", machineOnline: true)
        XCTAssertEqual(line, "Claude · mini")
    }

    func testEditorStateSurvivesInventoryDecodeWithoutAnAppRun() throws {
        for (status, expected) in [("busy", AttentionState.working), ("waiting", .needs_attention), ("idle", .idle)] {
            let raw = #"{"sessionId":"s","title":"Editor","lastModified":1,"livePid":42,"liveStatus":"STATUS"}"#
                .replacingOccurrences(of: "STATUS", with: status)
            let session = try JSONDecoder().decode(SessionSummary.self, from: Data(raw.utf8))
            XCTAssertEqual(session.activityState(run: nil), expected)
            XCTAssertEqual(session.activityState(run: run(.error)), .error, "an app run remains authoritative")
        }
        var editor = session(livePid: 42)
        XCTAssertNil(editor.activityState(run: nil))
        editor.liveStatus = "future-value"
        XCTAssertNil(editor.activityState(run: nil))
        editor.liveStatus = "busy"
        editor.livePid = nil
        XCTAssertNil(editor.activityState(run: nil), "a stale status without a live writer is not work")
    }

    func testCachedFleetDoesNotReviveAnOldEditorWorkingPhase() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let raw = #"[{"machine":{"machineId":"m","name":"Mac","os":"mac","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[{"sessionId":"s","title":"Editor","lastModified":1,"livePid":42,"liveStatus":"busy"}]}]"#
        let machines = try JSONDecoder().decode([MachineSnapshot].self, from: Data(raw.utf8))
        let store = FleetSnapshotStore(directory: directory)
        store.save(machines, viewerId: nil)
        let restored = try XCTUnwrap(store.load().first)
        XCTAssertFalse(restored.online)
        XCTAssertNil(restored.sessions.first?.activityState(run: nil))
        XCTAssertNil(restored.sessions.first?.livePid, "a cached editor pid is not a live session")
        XCTAssertFalse(restored.sessions.first?.isLive ?? true)
    }

    /// Холодный запуск без хаба: кэш показывает «мои» сессии, только если
    /// рядом сохранено, чьи они. Без этого фильтр владельца прятал весь кэш
    /// и приложение открывалось пустым (09.10.2026).
    func testCachedFleetRemembersWhoseItWas() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let raw = #"[{"machine":{"machineId":"m","name":"Mac","os":"mac","agentVersion":"1"},"owner":{"userId":"u1","fullName":"Владелец"},"online":true,"lastSeen":1,"sessions":[{"sessionId":"s","title":"Mine","lastModified":1}]}]"#
        let machines = try JSONDecoder().decode([MachineSnapshot].self, from: Data(raw.utf8))
        let store = FleetSnapshotStore(directory: directory)
        XCTAssertNil(store.loadViewerId(), "nothing saved yet")
        store.save(machines, viewerId: "u1")
        // Same serial queue: this read waits for the asynchronous write above.
        XCTAssertEqual(store.loadViewerId(), "u1")
        let fresh = FleetSnapshotStore(directory: directory)
        XCTAssertEqual(fresh.loadViewerId(), "u1")
        let restored = try XCTUnwrap(fresh.load().first)
        XCTAssertTrue(restored.sessions[0].isMine(on: restored, viewerId: fresh.loadViewerId()))
        XCTAssertFalse(restored.sessions[0].isMine(on: restored, viewerId: nil),
                       "the reason the cache used to be invisible")
    }

    func testWorkingSaysSoAndNamesTheEditorWhenOneHoldsIt() {
        XCTAssertEqual(session().stateLine(run: run(.working), machineName: "mini", machineOnline: true),
                       "работает…")
        XCTAssertEqual(session(livePid: 7, entrypoint: "vscode")
                        .stateLine(run: run(.working), machineName: "mini", machineOnline: true),
                       "открыта в vscode")
    }

    /// Хаб поднимает одно состояние на вопрос и на запрос разрешения, поэтому
    /// слово — единственное, что их различает. «Ждёт ответа» на запрос `Write`
    /// отправляло владельца искать вопрос, которого никто не задавал.
    func testAttentionNamesWhatItIsWaitingFor() {
        let s = session()
        XCTAssertEqual(s.stateLine(run: run(.needs_attention, pendingKind: "question"),
                                   machineName: "m", machineOnline: true), "ждёт ответа")
        XCTAssertEqual(s.stateLine(run: run(.needs_attention, pendingKind: "permission",
                                            pendingTool: "Write"),
                                   machineName: "m", machineOnline: true),
                       "ждёт подтверждения: Write")
        // Хаб слишком стар, чтобы прислать `pendingKind`: честное «не знаю».
        XCTAssertEqual(s.stateLine(run: run(.needs_attention), machineName: "m", machineOnline: true),
                       "ждёт решения")
    }

    func testErrorAsksForALook() {
        XCTAssertEqual(session().stateLine(run: run(.error), machineName: "m", machineOnline: true),
                       "ошибка — нужен взгляд")
    }

    /// Ничего не происходит — строка говорит, ГДЕ сессия живёт, и в каком
    /// порядке: движок, проект, машина, офлайн.
    func testIdleLineNamesTheEngineAndThePlace() {
        let s = session(source: "codex", project: "app")
        XCTAssertEqual(s.stateLine(run: nil, machineName: "stage", machineOnline: false,
                                   showMachine: true, showProject: true),
                       "Codex · app · stage · офлайн")
        XCTAssertEqual(s.stateLine(run: nil, machineName: "stage", machineOnline: true,
                                   showMachine: false, showProject: false),
                       "Codex")
    }

    /// `isActive` — это `livePid ИЛИ любой прогон`, `idle` включительно:
    /// открытый прогон держит замок единственного писателя.
    func testIsActiveCountsBothSignals() {
        XCTAssertTrue(session(livePid: 1).isActive(run: nil))
        XCTAssertTrue(session().isActive(run: run(.idle)))
        XCTAssertFalse(session().isActive(run: nil))
    }
}
