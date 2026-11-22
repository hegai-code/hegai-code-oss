import XCTest
@testable import CCRemoteKit

/// Удаление сессии и проекта, создание проекта, выбор рантайма по умолчанию —
/// правила и запросы те же, что в вебе.
final class ProjectAdminTests: XCTestCase {
    private func runtimes(_ json: String) throws -> MachineRuntimes {
        try JSONDecoder().decode(MachineRuntimes.self, from: Data(json.utf8))
    }

    private func machine(canControl: Bool?, owner: String? = nil) throws -> MachineSnapshot {
        let ctl = canControl.map { ",\"canControl\":\($0)" } ?? ""
        let json = """
        {"machine":{"machineId":"m","name":"Box","os":"linux","agentVersion":"0"},"online":true,"lastSeen":1,"sessions":[]\(ctl)}
        """
        return try JSONDecoder().decode(MachineSnapshot.self, from: Data(json.utf8))
    }

    private func session(owner: String?) throws -> SessionSummary {
        let o = owner.map { ",\"owner\":{\"userId\":\"\($0)\"}" } ?? ""
        let json = """
        {"sessionId":"s","title":"t","cwd":"/w/a","lastModified":1,"messageCount":1\(o)}
        """
        return try JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
    }

    // MARK: рантайм по умолчанию

    func testClaudeUnusableCodexUsablePicksCodex() throws {
        let r = try runtimes(#"{"claude":{"present":false,"auth":"none","error":"not_found"},"codex":{"present":true,"auth":"chatgpt"}}"#)
        XCTAssertFalse(MachineRuntimes.usable(r, "claude"))
        XCTAssertTrue(MachineRuntimes.usable(r, "codex"))
        XCTAssertEqual(MachineRuntimes.pick(r, preferred: "claude"), "codex")
    }

    func testClaudeLoggedOutPicksCodex() throws {
        let r = try runtimes(#"{"claude":{"present":true,"auth":"oauth","error":"logged_out"},"codex":{"present":true,"auth":"apikey"}}"#)
        XCTAssertEqual(MachineRuntimes.pick(r, preferred: "claude"), "codex")
    }

    func testUnknownRuntimesAreUsable() throws {
        XCTAssertTrue(MachineRuntimes.usable(nil, "claude"))
        XCTAssertEqual(MachineRuntimes.pick(nil, preferred: "claude"), "claude")
        let onlyCodex = try runtimes(#"{"codex":{"present":true,"auth":"chatgpt"}}"#)
        XCTAssertEqual(MachineRuntimes.pick(onlyCodex, preferred: "claude"), "claude")
    }

    func testBothUnusableKeepsPreference() throws {
        let r = try runtimes(#"{"claude":{"present":false,"auth":"none"},"codex":{"present":false,"auth":"none","error":"not_found"}}"#)
        XCTAssertEqual(MachineRuntimes.pick(r, preferred: "claude"), "claude")
    }

    func testCodexGatewayNeedsNoLoginAndCodexLoggedOutFallsToClaude() throws {
        let gw = try runtimes(#"{"codex":{"present":true,"auth":"none","provider":"gateway"}}"#)
        XCTAssertTrue(MachineRuntimes.usable(gw, "codex"))
        let out = try runtimes(#"{"claude":{"present":true,"auth":"oauth"},"codex":{"present":true,"auth":"none","error":"not_logged_in"}}"#)
        XCTAssertEqual(MachineRuntimes.pick(out, preferred: "codex"), "claude")
    }

    func testClaudeDisabledIsUnusable() throws {
        let r = try runtimes(#"{"claude":{"present":true,"auth":"oauth","error":"disabled"},"codex":{"present":true,"auth":"chatgpt"}}"#)
        XCTAssertEqual(MachineRuntimes.pick(r, preferred: "claude"), "codex")
    }

    // MARK: запросы

    func testCreateParamsMatchWeb() {
        XCTAssertEqual(ProjectAdmin.createParams(name: "my-app"),
                       ["name": .string("my-app"), "template": .string("empty")])
        XCTAssertEqual(ProjectAdmin.createParams(name: "x", gitUrl: " https://h/x.git "),
                       ["name": .string("x"), "gitUrl": .string("https://h/x.git")])
    }

    func testRemoveAndDeleteSessionParams() {
        XCTAssertEqual(ProjectAdmin.removeParams(cwd: "/w/a"), ["cwd": .string("/w/a")])
        XCTAssertEqual(ProjectAdmin.deleteSessionParams(cwd: "/w/a", sessionId: "s", source: nil),
                       ["cwd": .string("/w/a"), "sessionId": .string("s")])
        XCTAssertEqual(ProjectAdmin.deleteSessionParams(cwd: "/w/a", sessionId: "s", source: "codex"),
                       ["cwd": .string("/w/a"), "sessionId": .string("s"), "source": .string("codex")])
    }

    func testNameRulesMirrorAgentRegex() {
        for ok in ["a", "my-app", "a.b_c-1", "0abc", String(repeating: "a", count: 64)] {
            XCTAssertTrue(ProjectAdmin.nameIsValid(ok), ok)
        }
        for bad in ["", "-a", ".a", "_a", "A", "a b", "a/b", "я", String(repeating: "a", count: 65)] {
            XCTAssertFalse(ProjectAdmin.nameIsValid(bad), bad)
        }
        XCTAssertEqual(ProjectAdmin.normalizeName("My  New App"), "my-new-app")
    }

    func testErrorsAndConfirmationWording() {
        XCTAssertEqual(ProjectAdmin.describeCreateError("project already exists"), "Проект с таким именем уже есть.")
        XCTAssertEqual(ProjectAdmin.describeCreateError("weird"), "weird")
        XCTAssertEqual(ProjectAdmin.describeRemoveError("a session is live in /w — close it first"),
                       "В проекте идёт сессия — закрой её, потом убирай.")
        XCTAssertEqual(ProjectAdmin.describeRemoveError("outside the projects root"),
                       "Убрать можно только проект из папки проектов на машине.")
        XCTAssertEqual(ProjectAdmin.removeConfirmation(label: "a", machineName: "Box"),
                       "Убрать «a» с машины Box?\n\nПапка переедет в корзину агента (~/.cc-remote/trash) — ничего не удаляется насовсем.")
        XCTAssertEqual(ProjectAdmin.deleteSessionConfirmation, "Удалить запись этой сессии?")
    }

    // MARK: права

    func testRemoveProjectOnlyOnControlledRootIdleProject() throws {
        let m = try machine(canControl: true)
        XCTAssertTrue(ProjectAdmin.canRemoveProject(machine: m, origin: .root, busy: false))
        XCTAssertFalse(ProjectAdmin.canRemoveProject(machine: m, origin: .root, busy: true))
        XCTAssertFalse(ProjectAdmin.canRemoveProject(machine: m, origin: .adopted, busy: false))
        XCTAssertFalse(ProjectAdmin.canRemoveProject(machine: m, origin: nil, busy: false))
        XCTAssertFalse(ProjectAdmin.canRemoveProject(machine: try machine(canControl: false), origin: .root, busy: false))
        XCTAssertFalse(ProjectAdmin.canRemoveProject(machine: nil, origin: .root, busy: false))
    }

    func testOverrideIsMemoryOnlyAndNilWhenNotNeeded() throws {
        let noClaude = try runtimes(#"{"claude":{"present":false,"auth":"none"},"codex":{"present":true,"auth":"apikey"}}"#)
        XCTAssertEqual(MachineRuntimes.override(noClaude, remembered: "claude"), "codex")
        XCTAssertNil(MachineRuntimes.override(noClaude, remembered: "codex"))
        XCTAssertNil(MachineRuntimes.override(noClaude, remembered: "opencode"))
        XCTAssertNil(MachineRuntimes.override(nil, remembered: "claude"))
        let both = try runtimes(#"{"claude":{"present":true,"auth":"oauth"},"codex":{"present":true,"auth":"apikey"}}"#)
        XCTAssertNil(MachineRuntimes.override(both, remembered: "claude"))
    }

    func testCwdIsBusyByLivePidOrRunNotYetInInventory() throws {
        let json = """
        {"machine":{"machineId":"m","name":"Box","os":"linux","agentVersion":"0"},"online":true,"lastSeen":1,
         "sessions":[{"sessionId":"a","title":"t","cwd":"/w/a","lastModified":1,"messageCount":1,"livePid":7},
                     {"sessionId":"b","title":"t","cwd":"/w/b","lastModified":1,"messageCount":1}]}
        """
        let m = try JSONDecoder().decode(MachineSnapshot.self, from: Data(json.utf8))
        func run(_ sid: String, project: String? = nil, machine: String = "m") -> ActiveRunInfo {
            ActiveRunInfo(runId: "r", machineId: machine, sessionId: sid, project: project, state: .idle, since: 1)
        }
        XCTAssertTrue(ProjectAdmin.cwdIsBusy(machine: m, cwd: "/w/a", label: "a", runs: []))
        XCTAssertFalse(ProjectAdmin.cwdIsBusy(machine: m, cwd: "/w/b", label: "b", runs: []))
        // Ран сопоставлен с описью — по его cwd; чужой каталог не занят.
        XCTAssertTrue(ProjectAdmin.cwdIsBusy(machine: m, cwd: "/w/b", label: "b", runs: [run("b")]))
        XCTAssertFalse(ProjectAdmin.cwdIsBusy(machine: m, cwd: "/w/c", label: "c", runs: [run("b")]))
        // Опись ещё не знает ран: занят, если проект совпал или не назван.
        XCTAssertTrue(ProjectAdmin.cwdIsBusy(machine: m, cwd: "/w/c", label: "c", runs: [run("new", project: "c")]))
        XCTAssertTrue(ProjectAdmin.cwdIsBusy(machine: m, cwd: "/w/c", label: "c", runs: [run("new")]))
        XCTAssertFalse(ProjectAdmin.cwdIsBusy(machine: m, cwd: "/w/c", label: "c", runs: [run("new", project: "z")]))
        XCTAssertFalse(ProjectAdmin.cwdIsBusy(machine: m, cwd: "/w/c", label: "c", runs: [run("new", machine: "other")]))
    }

    func testDeleteSessionNeedsControlOrOwnership() throws {
        let own = try session(owner: "me"), other = try session(owner: "him"), none = try session(owner: nil)
        let owner = try machine(canControl: true)
        let legacy = try machine(canControl: nil)
        let member = try machine(canControl: false)
        XCTAssertTrue(ProjectAdmin.canDeleteSession(machine: owner, session: other, viewerId: "me"))
        XCTAssertTrue(ProjectAdmin.canDeleteSession(machine: legacy, session: other, viewerId: "me"))
        XCTAssertTrue(ProjectAdmin.canDeleteSession(machine: member, session: own, viewerId: "me"))
        XCTAssertFalse(ProjectAdmin.canDeleteSession(machine: member, session: other, viewerId: "me"))
        XCTAssertFalse(ProjectAdmin.canDeleteSession(machine: member, session: none, viewerId: "me"))
        XCTAssertFalse(ProjectAdmin.canDeleteSession(machine: nil, session: own, viewerId: "me"))
    }
}
