import XCTest
@testable import CCRemoteKit
@testable import CCRemote

/// Три правила сведения полки. Каждое существует из-за конкретной поломки, и
/// ни одно из них не роняет сборку, когда ломается.
///
/// **Почему тест вообще.** До фазы 6 полка собиралась «всё или ничего»:
/// `withTaskGroup` ждал ВСЕХ управляемых машин, и одна молчащая держала
/// остальных до таймаута RPC (30 с) — фаза 4 намерила на стенде 27 секунд.
/// Починка — публиковать каждый ответ отдельно, а у публикации по частям
/// появляются свои способы соврать: перетасовать полку на каждом ответе,
/// стереть показанное молчанием машины, оставить на полке машину, которая
/// ушла из флота. Все три здесь.
final class OwnedProjectsTests: XCTestCase {

    private func target(_ machineId: String, _ label: String) -> ExtraTarget {
        ExtraTarget(machineId: machineId, cwd: "/home/\(label)", label: label)
    }

    /// Порядок задаёт СПИСОК ОПРОСА, а не гонка ответов. Иначе полка
    /// переставляется под пальцем каждый раз, когда приезжает ещё одна машина.
    func testOrderFollowsTheAskedListNotTheAnswerOrder() {
        var shelf = ShelfAccumulator()
        let ids = ["alpha", "beta", "gamma"]
        shelf.keep(ids)
        // Ответы приходят задом наперёд.
        shelf.put("gamma", [target("gamma", "g1")])
        shelf.put("beta", [target("beta", "b1")])
        shelf.put("alpha", [target("alpha", "a1")])
        XCTAssertEqual(shelf.targets(order: ids).map(\.label), ["a1", "b1", "g1"])
    }

    /// Частичная полка — это полка. Пока молчит одна машина, остальные УЖЕ на
    /// экране: ровно это и есть починка 27 секунд.
    func testAnsweredMachinesShowBeforeTheSlowOne() {
        var shelf = ShelfAccumulator()
        let ids = ["alpha", "slow"]
        shelf.keep(ids)
        shelf.put("alpha", [target("alpha", "a1"), target("alpha", "a2")])
        XCTAssertEqual(shelf.targets(order: ids).map(\.label), ["a1", "a2"])
        shelf.put("slow", [target("slow", "s1")])
        XCTAssertEqual(shelf.targets(order: ids).map(\.label), ["a1", "a2", "s1"])
    }

    /// Молчание — не пустой список. Агент старше `projects.list` или на
    /// переподключении не отвечает вовсе, и стирать по этому поводу уже
    /// показанное значит терять полку на ровном месте.
    func testSilenceKeepsThePreviousAnswerButAnEmptyAnswerClearsIt() {
        var shelf = ShelfAccumulator()
        let ids = ["alpha"]
        shelf.keep(ids)
        shelf.put("alpha", [target("alpha", "a1")])

        shelf.put("alpha", nil)                       // не ответила
        XCTAssertEqual(shelf.targets(order: ids).map(\.label), ["a1"])

        shelf.put("alpha", [])                        // ответила: проектов нет
        XCTAssertTrue(shelf.targets(order: ids).isEmpty)
    }

    /// Машина, выбывшая из флота, уходит с полки — даже если её ответ лежит в
    /// памяти. Предложить старт на коробке, которой нет, — это сессия, которая
    /// не начнётся.
    func testDepartedMachineLeavesTheShelf() {
        var shelf = ShelfAccumulator()
        shelf.keep(["alpha", "beta"])
        shelf.put("alpha", [target("alpha", "a1")])
        shelf.put("beta", [target("beta", "b1")])

        shelf.keep(["alpha"])
        XCTAssertEqual(shelf.targets(order: ["alpha"]).map(\.label), ["a1"])
        // И не возвращается вместе со списком опроса.
        XCTAssertEqual(shelf.targets(order: ["alpha", "beta"]).map(\.label), ["a1"])
    }

    /// Ключ опроса — только онлайн и только управляемые, и отсортированный:
    /// офлайновая не ответит, на машине без контроля начинать всё равно
    /// нельзя, а порядок машин во флоте меняется на каждом событии и сам по
    /// себе перезапроса не стоит.
    @MainActor
    func testKeyAsksOnlyOnlineControllableMachinesInStableOrder() {
        func machine(_ id: String, online: Bool, canControl: Bool?) -> MachineSnapshot {
            MachineSnapshot(
                machine: MachineInfo(machineId: id, name: id, os: .mac,
                                     agentVersion: "test", hostname: nil),
                owner: nil, canControl: canControl, canStart: nil,
                kind: nil, shared: nil,
                online: online, lastSeen: 1, sessions: []
            )
        }
        let fleet = [machine("zulu", online: true, canControl: true),
                     machine("alpha", online: true, canControl: true),
                     machine("dark", online: false, canControl: true),
                     machine("guest", online: true, canControl: false),
                     machine("unknown", online: true, canControl: nil)]
        XCTAssertEqual(OwnedProjects.key(for: fleet), "alpha,zulu")
        // Тот же флот в другом порядке — тот же ключ, значит без перезапроса.
        XCTAssertEqual(OwnedProjects.key(for: fleet.reversed()), "alpha,zulu")
        XCTAssertEqual(OwnedProjects.key(for: []), "")
    }

    // MARK: - Когда спрашивать каталог заново

    private func state(key: String = "a", wasOpen: Bool = true, generation: Int = 1,
                       askedAt: Date? = Date(timeIntervalSince1970: 1_000)) -> ShelfAskPolicy.State {
        ShelfAskPolicy.State(key: key, wasOpen: wasOpen, generation: generation, askedAt: askedAt)
    }
    private func ask(_ st: ShelfAskPolicy.State, key: String = "a", open: Bool = true, generation: Int = 1,
                     appeared: Bool = false, force: Bool = false, at: TimeInterval = 1_000) -> Bool {
        ShelfAskPolicy.shouldAsk(st, key: key, open: open, generation: generation, appeared: appeared,
                                 force: force, now: Date(timeIntervalSince1970: at))
    }

    /// Новый сокет с тем же составом машин спрашивает заново: проект могли создать,
    /// пока приложение было в фоне. Смена статуса того же сокета (поколение то же) — нет.
    func testNewSocketAsksAgainButTheSameSocketDoesNot() {
        XCTAssertFalse(ask(state()), "nothing moved")
        XCTAssertFalse(ask(state(), open: false), "a closed socket has nobody to ask")
        XCTAssertTrue(ask(state(), generation: 2), "a replacement socket re-asks")
    }

    func testChangedFleetKeyAndOpeningWhileWaitingStillAsk() {
        XCTAssertTrue(ask(state(), key: "a,b"))
        XCTAssertTrue(ask(state(wasOpen: false)), "the key waited for the socket to open")
        XCTAssertTrue(ask(state(), force: true))
    }

    /// Появление экрана перезапрашивает не чаще раза в пять минут.
    func testAppearanceRefreshIsRateLimited() {
        let st = state(askedAt: Date(timeIntervalSince1970: 1_000))
        XCTAssertFalse(ask(st, appeared: true, at: 1_000 + ShelfAskPolicy.minInterval - 1))
        XCTAssertTrue(ask(st, appeared: true, at: 1_000 + ShelfAskPolicy.minInterval))
        XCTAssertFalse(ask(st, appeared: false, at: 1_000 + 10 * ShelfAskPolicy.minInterval),
                       "only an appearance triggers the time-based refresh")
        XCTAssertFalse(ask(state(askedAt: nil), appeared: true, at: 9_999), "nothing was ever asked: the key task owns the first ask")
    }
}
