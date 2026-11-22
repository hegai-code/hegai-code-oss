import SwiftUI
import Observation
import CCRemoteKit

/// Вторая половина полки: то, что знают АГЕНТЫ, а опись сессий не знает.
///
/// Порт `useOwnedProjects` (`web/src/appHooks.ts`). Опись говорит только про
/// каталоги, в которых уже кто-то работал, — то есть теряет ровно те проекты,
/// ради которых полку открывают: созданный минуту назад, пустой, и тот, что
/// разделили с тобой, но начинали в нём не вы.
///
/// Три свойства, каждое из-за конкретной поломки:
///
///  * **Спрашиваются только управляемые онлайн-машины.** `projects.list` — это
///    круговой рейс до далёкой коробки; офлайновая всё равно не ответит, а
///    машина без контроля не место для старта.
///  * **Отказ — не ошибка.** Агент старше `projects.list` или на
///    переподключении просто молчит, и полка честно откатывается к описи.
///    Стартовый экран, который не рисуется, потому что не пришёл список, хуже
///    того, который предлагает меньше.
///  * **Ключ — состав машин, а не их снимок.** Снимок меняется на каждом
///    событии флота; перезапрос на каждом означал бы RPC в секунду на девять
///    коробок ради ответа, который не менялся.
///  * **Каждый ответ публикуется сам по себе.** Рейсов столько, сколько машин,
///    и едут они вразнобой: восемь отвечают за секунду, девятая молчит до
///    таймаута RPC (30 с). Пока полка собиралась «всё или ничего», эта одна
///    держала ВОСЕМЬ — фаза 4 намерила 27 секунд, и всё это время пустых
///    проектов на экране не существовало вовсе. Спиннер тут не лечит: никто не
///    ждёт полминуты, чтобы увидеть список.
/// Сведение ответов в полку — отдельно от сокета, потому что в нём три
/// правила, и каждое ломается молча.
///
/// Проверяется `OwnedProjectsTests`: порядок не зависит от того, кто успел
/// первым; молчание машины не стирает её прошлый ответ; выбывшая из флота
/// машина уходит с полки.
struct ShelfAccumulator {
    private var byMachine: [String: [ExtraTarget]] = [:]

    /// Оставить только тех, кого спрашиваем сейчас.
    mutating func keep(_ ids: [String]) {
        byMachine = byMachine.filter { ids.contains($0.key) }
    }

    /// `rows == nil` — машина не ответила. Это НЕ пустой список: агент старше
    /// `projects.list` или на переподключении, и стирать по такому поводу уже
    /// показанное хуже, чем показать вчерашнее.
    mutating func put(_ machineId: String, _ rows: [ExtraTarget]?) {
        guard let rows else { return }
        byMachine[machineId] = rows
    }

    /// Убрать проект, который только что удалили: молчание машины на следующем опросе
    /// иначе вернуло бы его из прошлого ответа.
    mutating func remove(_ machineId: String, cwd: String) {
        byMachine[machineId]?.removeAll { $0.cwd == cwd }
    }

    /// Порядок — по машинам, а не по тому, кто успел первым: иначе полка
    /// перетасовывалась бы на каждом прилетевшем ответе.
    func targets(order ids: [String]) -> [ExtraTarget] {
        ids.flatMap { byMachine[$0] ?? [] }
    }
}

/// Когда каталог проектов надо спрашивать у агентов заново. Отдельно от сокета, чтобы
/// решение проверялось без сети: каждое условие — свой способ соврать.
///
///  * состав управляемых машин изменился, или сокет открылся, пока ключ ждал;
///  * **новый сокет** (`socketGeneration`) — каталог мог измениться, пока мы были
///    в фоне или без связи: проект создали с веба или с другого телефона, и ключ
///    «состав машин» этого не заметит никогда. Смена `status` на ТОМ ЖЕ сокете
///    (не бывает: connecting/closed всегда означают новый сокет) повода не даёт;
///  * экран появился, а прошлый вопрос старше `minInterval` — иначе проект, созданный
///    рядом, не появился бы на стартовом экране, пока приложение живо.
struct ShelfAskPolicy {
    /// Не чаще: экран старта открывают десятки раз в день, а `projects.list` — рейс
    /// до каждой машины.
    static let minInterval: TimeInterval = 300

    struct State {
        var key = ""
        var wasOpen = false
        var generation = -1
        var askedAt: Date?
    }

    static func shouldAsk(_ state: State, key: String, open: Bool, generation: Int,
                          appeared: Bool, force: Bool, now: Date) -> Bool {
        if force || key != state.key { return true }
        guard open else { return false }
        if !state.wasOpen || generation != state.generation { return true }
        guard appeared, let askedAt = state.askedAt else { return false }
        return now.timeIntervalSince(askedAt) >= minInterval
    }
}

/// Поколение запроса: принимается только ответ ПОСЛЕДНЕГО. Иначе уже летевший
/// запрос, начатый до remove/create, вернул бы удалённый проект и стёр созданный.
struct RequestGeneration {
    private(set) var current = 0
    mutating func begin() -> Int { current += 1; return current }
    func accepts(_ token: Int) -> Bool { token == current }
}

@MainActor
@Observable
final class OwnedProjects {
    /// Публикуется по мере прихода — сведение в порядке опроса.
    private(set) var targets: [ExtraTarget] = []
    /// Кого ещё ждём. Полка при этом уже нарисована тем, что приехало, —
    /// это не «загрузка», а хвост списка, который дополнится.
    private(set) var awaiting: Set<String> = []

    private var shelf = ShelfAccumulator()
    private var lastKey = ""
    private var requests = RequestGeneration()
    /// Решение «спрашивать ли» — `ShelfAskPolicy`. `wasOpen`: ключ, записанный пока
    /// спрашивать было некого, надо спросить, как только сокет откроется.
    private var ask = ShelfAskPolicy.State()

    /// Кого спрашивать — и заодно ключ, по которому решают, спрашивать ли снова.
    static func key(for machines: [MachineSnapshot]) -> String {
        machines.filter { $0.online && $0.canControl == true }
            .map(\.machine.machineId)
            .sorted()
            .joined(separator: ",")
    }

    /// Проект удалён на машине: сразу с полки и из прошлых ответов.
    func forget(machineId: String, cwd: String) {
        shelf.remove(machineId, cwd: cwd)
        targets.removeAll { $0.machineId == machineId && $0.cwd == cwd }
    }

    /// Обновить по `ShelfAskPolicy`: состав машин изменился, открылся новый сокет, либо
    /// экран появился (`appeared`) и прошлый вопрос старше 5 минут. Смена статуса одного
    /// и того же сокета не спрашивает заново: раньше каждая смена
    /// (connecting/open/closed) рассылала `projects.list` по кругу на каждую машину.
    /// `force` — явное «спросить ещё раз» (после того, как что-то создали).
    func refresh(client: CentralClient, force: Bool = false, appeared: Bool = false,
                 now: Date = Date()) async {
        let key = Self.key(for: client.machines)
        let open = client.status == .open
        let generation = client.socketGeneration
        guard ShelfAskPolicy.shouldAsk(ask, key: key, open: open, generation: generation,
                                       appeared: appeared, force: force, now: now) else { return }
        let token = requests.begin()
        lastKey = key
        ask.key = key
        ask.wasOpen = open
        if open { ask.generation = generation }
        guard client.status == .open, !key.isEmpty else {
            // Не «всё ещё спрашиваем» — спрашивать НЕКОГО. Оборванный сокет и
            // флот без управляемой машины — это окончательный ответ, и тот, кто
            // его ждёт, ждал бы вечно.
            shelf = ShelfAccumulator()
            targets = []
            awaiting = []
            #if DEBUG
            // «Спрашивать некого» — ответ ТОЛЬКО когда флот уже приехал и в нём
            // действительно нет ни одной управляемой машины. Пустой ключ на
            // ещё не открытом сокете (или до первого снимка) — это «пока
            // некого», и маяк тут гасить нельзя: он гаснет навсегда, первым
            // значением, а настоящий ответ придёт секундой позже и будет
            // подавлен. Ровно так кадр приёмки и снялся с полусобранной полкой.
            if client.status == .open, !client.machines.isEmpty {
                HarnessSignals.shelfSettled(projects: 0, asked: 0, answered: 0)
            }
            #endif
            return
        }
        ask.askedAt = now
        let ids = key.components(separatedBy: ",")
        shelf.keep(ids)
        awaiting = Set(ids)
        targets = shelf.targets(order: ids)
        var silent = Set(ids)
        await withTaskGroup(of: (String, [ExtraTarget]?).self) { group in
            for machineId in ids {
                group.addTask { @MainActor in
                    guard let list = try? await client.listProjects(machineId: machineId) else {
                        return (machineId, nil)
                    }
                    return (machineId, list.map {
                        ExtraTarget(machineId: machineId, cwd: $0.cwd, label: $0.label,
                                    origin: $0.origin, lastModified: $0.lastModified)
                    })
                }
            }
            for await (machineId, rows) in group {
                // Ответ мог прийти на запрос, который уже не про этот флот.
                guard lastKey == key, requests.accepts(token) else { break }
                if rows != nil { silent.remove(machineId) }
                shelf.put(machineId, rows)
                awaiting.remove(machineId)
                // Каждый ответ — сразу на экран. Ждать девятую машину, чтобы
                // показать первые восемь, и есть та самая полуминута.
                targets = shelf.targets(order: ids)
            }
        }
        guard lastKey == key, requests.accepts(token) else { return }
        // A machine that did not answer (mid-reconnect, or too old for
        // `projects.list`) is asked again the next time the socket opens.
        if !silent.isEmpty { ask.wasOpen = false }
        #if DEBUG
        HarnessSignals.shelfSettled(projects: targets.count, asked: ids.count,
                                    answered: ids.count - silent.count, silent: Array(silent))
        #endif
    }
}
