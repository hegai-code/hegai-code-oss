import XCTest
@testable import CCRemoteKit

/// Полка проектов стартового экрана. Проверяется здесь то, что телефон терял,
/// пока строил её только по описи сессий, — и что нельзя увидеть на скриншоте
/// без правильно населённого флота.
final class ProjectShelfTests: XCTestCase {
    private func session(_ id: String, cwd: String?, project: String? = nil,
                         lastModified: Double = 1_700_000_000_000,
                         owner: MachineOwner? = nil, entrypoint: String? = nil,
                         livePid: Int? = nil) -> SessionSummary {
        SessionSummary(sessionId: id, title: "T-\(id)", cwd: cwd, project: project,
                       gitBranch: nil, lastModified: lastModified, createdAt: nil,
                       entrypoint: entrypoint, cliVersion: nil, livePid: livePid,
                       source: "claude", active: nil, owner: owner)
    }

    private func machine(_ id: String, name: String? = nil, os: OsKind = .mac,
                         canControl: Bool? = true, canStart: Bool? = nil,
                         owner: MachineOwner? = nil, shared: Bool? = nil,
                         kind: String? = nil,
                         sessions: [SessionSummary]) -> MachineSnapshot {
        MachineSnapshot(
            machine: MachineInfo(machineId: id, name: name ?? id, os: os,
                                 agentVersion: "test", hostname: nil),
            owner: owner, canControl: canControl, canStart: canStart,
            kind: kind, shared: shared,
            online: true, lastSeen: 1, sessions: sessions
        )
    }

    // MARK: Два источника

    /// Ради чего полка вообще переехала на два источника: проект, в котором не
    /// начинали ни одной сессии, по описи невидим — а именно его только что
    /// создали и именно в нём собираются работать.
    func testEmptyProjectFromProjectsListIsOnTheShelf() {
        let fleet = [machine("m1", sessions: [session("s1", cwd: "/home/p/old")])]
        let onlySessions = ProjectShelf.targets(machines: fleet, viewerId: "u1", runs: [])
        XCTAssertEqual(onlySessions.map(\.label), ["old"])

        let withExtras = ProjectShelf.targets(
            machines: fleet, viewerId: "u1", runs: [],
            extra: [ExtraTarget(machineId: "m1", cwd: "/home/p/brand-new",
                                label: "brand-new", origin: .root)]
        )
        XCTAssertEqual(Set(withExtras.map(\.label)), ["old", "brand-new"])
        let fresh = withExtras.first { $0.label == "brand-new" }
        XCTAssertEqual(fresh?.origin, .root)
        // Никогда не тронутый — это ноль, и полка обязана считать его свежим,
        // а не самым протухшим из всех.
        XCTAssertEqual(fresh?.lastModified, 0)
        XCTAssertTrue(ProjectShelf.isFresh(fresh!))
        // «Пусто» — это «опись про него не знает», а не `origin`: агент ставит
        // `root` и каталогам, где сессии есть.
        XCTAssertFalse(fresh?.hasSessions ?? true)
        XCTAssertTrue(withExtras.first { $0.label == "old" }?.hasSessions ?? false)
    }

    /// Тот же каталог, пришедший обоими путями, — один проект, а не два.
    func testProjectsListDoesNotDuplicateASessionBackedProject() {
        let fleet = [machine("m1", sessions: [session("s1", cwd: "/home/p/app")])]
        let out = ProjectShelf.targets(
            machines: fleet, viewerId: "u1", runs: [],
            extra: [ExtraTarget(machineId: "m1", cwd: "/home/p/app", label: "app", origin: .root)]
        )
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out.first?.origin, .sessions)
        XCTAssertTrue(out.first?.hasSessions ?? false)
    }

    // MARK: Отсев

    func testRootishAndScratchAndCronAreNotProjects() {
        let fleet = [machine("m1", sessions: [
            session("root", cwd: "/"),
            session("home", cwd: "/Users/owner"),
            session("real", cwd: "/Users/owner/code/app"),
            session("cron", cwd: "/Users/owner/code/loop", entrypoint: "sdk-cli"),
        ])]
        let out = ProjectShelf.targets(
            machines: fleet, viewerId: "u1", runs: [],
            extra: [ExtraTarget(machineId: "m1", cwd: "/tmp/throwaway", label: "throwaway")]
        )
        XCTAssertEqual(out.map(\.label), ["app"])
    }

    /// Машина, на которой хаб откажется стартовать, не место для старта.
    func testUnstartableMachineIsNotOffered() {
        let fleet = [machine("m1", canControl: false, canStart: nil,
                             sessions: [session("s1", cwd: "/home/p/app")])]
        XCTAssertTrue(ProjectShelf.targets(machines: fleet, viewerId: "u1", runs: []).isEmpty)

        let shared = [machine("m1", canControl: false, canStart: true,
                              sessions: [session("s1", cwd: "/home/p/app")])]
        XCTAssertEqual(ProjectShelf.targets(machines: shared, viewerId: "u1", runs: []).count, 1)
    }

    /// Windows пишет букву диска как придётся — одна папка не должна стать двумя.
    func testWindowsDriveLetterCaseFoldsIntoOneProject() {
        let fleet = [machine("pc", os: .windows, sessions: [
            session("a", cwd: #"d:\Hegai_VScode\claudehegai"#, lastModified: 10),
            session("b", cwd: #"D:\Hegai_VScode\claudehegai"#, lastModified: 20),
        ])]
        let out = ProjectShelf.targets(machines: fleet, viewerId: "u1", runs: [])
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out.first?.lastModified, 20)
    }

    /// …а на mac `Foo` и `foo` — разные каталоги.
    func testCaseIsNotFoldedOnCaseSensitiveFilesystems() {
        let fleet = [machine("mac", os: .mac, sessions: [
            session("a", cwd: "/home/p/Foo"),
            session("b", cwd: "/home/p/foo"),
        ])]
        XCTAssertEqual(ProjectShelf.targets(machines: fleet, viewerId: "u1", runs: []).count, 2)
    }

    // MARK: «Моё»

    /// Безымянный терминал на своей машине — твой; на общей коробке — ничей.
    func testUnattributedSessionIsMineOnAPersonalBoxAndNobodysOnASharedOne() {
        let me = MachineOwner(userId: "u1", email: nil, fullName: nil)
        let personal = machine("mine", owner: me, sessions: [session("s", cwd: "/home/p/app")])
        XCTAssertTrue(ProjectShelf.targets(machines: [personal], viewerId: "u1", runs: [])[0].mine)

        // `kind` у песочницы сотрудников — `personal`; общей её делает `shared`.
        let box = machine("sandbox", owner: me, shared: true, kind: "personal",
                          sessions: [session("s", cwd: "/home/p/app")])
        XCTAssertFalse(ProjectShelf.targets(machines: [box], viewerId: "u1", runs: [])[0].mine)
    }

    /// Полка не пустеет, когда хаб ещё ни одну сессию не приписал зрителю.
    func testRecentFallsBackToEverythingRatherThanShowingAnEmptyShelf() {
        let now = Date().timeIntervalSince1970 * 1000
        let all = [ProjectTarget(machineId: "m", machineName: "m", cwd: "/a", label: "a",
                                 lastModified: now, mine: false)]
        XCTAssertEqual(ProjectShelf.recent(all, now: now).count, 1)
    }

    /// Протухшее не предлагается, но и не исчезает — оно просто не «recent».
    func testStaleProjectsAreNotOffered() {
        let now: Double = 1_700_000_000_000
        let all = [
            ProjectTarget(machineId: "m", machineName: "m", cwd: "/fresh", label: "fresh",
                          lastModified: now - 1000, mine: true),
            ProjectTarget(machineId: "m", machineName: "m", cwd: "/stale", label: "stale",
                          lastModified: now - ProjectShelf.recencyWindow - 1, mine: true),
        ]
        XCTAssertEqual(ProjectShelf.recent(all, now: now).map(\.label), ["fresh"])
        XCTAssertFalse(ProjectShelf.isFresh(all[1], now: now))
    }

    // MARK: Живое и ждущее

    /// `working` — это агент в ходу; открытая сессия с живым pid им не является.
    func testLiveCountsTurnsNotOpenEditors() {
        let fleet = [machine("m", sessions: [
            session("a", cwd: "/home/p/app", livePid: 4242),
            session("b", cwd: "/home/p/app"),
        ])]
        let run = ActiveRunInfo(runId: "r", machineId: "m", sessionId: "b",
                                state: .working, since: 1)
        let out = ProjectShelf.targets(machines: fleet, viewerId: "u1", runs: [run])
        XCTAssertEqual(out[0].live, 1)
        XCTAssertEqual(out[0].attention, 0)
    }

    func testAttentionCountsQuestionsAndFailures() {
        let fleet = [machine("m", sessions: [
            session("a", cwd: "/home/p/app"), session("b", cwd: "/home/p/app"),
        ])]
        let runs = [
            ActiveRunInfo(runId: "r1", machineId: "m", sessionId: "a",
                          state: .needs_attention, since: 1),
            ActiveRunInfo(runId: "r2", machineId: "m", sessionId: "b", state: .error, since: 1),
        ]
        XCTAssertEqual(ProjectShelf.targets(machines: fleet, viewerId: "u1", runs: runs)[0].attention, 2)
    }

    // MARK: Уточнитель пути

    /// Одноимённые проекты различаются САМЫМ КОРОТКИМ суффиксом, который в
    /// группе действительно разный, — а не фиксированной глубиной.
    func testDisambiguateGoesAsDeepAsThePathsStopAgreeing() {
        let group = [
            ProjectTarget(machineId: "pc", machineName: "pc", cwd: "/a/Hegai_VScode/claudehegai",
                          label: "claudehegai", lastModified: 1),
            ProjectTarget(machineId: "pc", machineName: "pc", cwd: "/b/Hegai_VScode/claudehegai",
                          label: "claudehegai", lastModified: 1),
        ]
        let where_ = ProjectShelf.disambiguate(group)
        XCTAssertEqual(where_[group[0].id], "a/Hegai_VScode")
        XCTAssertEqual(where_[group[1].id], "b/Hegai_VScode")
    }

    func testDisambiguateIsSilentForAUniqueName() {
        let one = [ProjectTarget(machineId: "m", machineName: "m", cwd: "/a/app",
                                 label: "app", lastModified: 1)]
        XCTAssertTrue(ProjectShelf.disambiguate(one).isEmpty)
    }

    /// 30.09.2026: a drive letter is not a level for the home test, but a
    /// first-level folder on a drive is a project (web `isRootish` parity).
    func testRootishWindowsDrives() {
        XCTAssertTrue(ProjectShelf.isRootish(#"C:\Users\buildbox"#))
        XCTAssertTrue(ProjectShelf.isRootish(#"C:\"#))
        XCTAssertFalse(ProjectShelf.isRootish(#"D:\hegai"#))
        XCTAssertTrue(ProjectShelf.isRootish("/root"))
        XCTAssertTrue(ProjectShelf.isRootish("/"))
        XCTAssertFalse(ProjectShelf.isRootish("/srv/main-source"))
    }
}
