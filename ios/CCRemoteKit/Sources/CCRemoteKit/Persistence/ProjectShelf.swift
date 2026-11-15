import Foundation

/// Где можно начать работу — полка проектов стартового экрана.
///
/// Дословный порт `projectTargets` / `recentProjects` из `web/src/lib.ts`. Порт,
/// а не «примерно то же»: до этой фазы телефон строил полку по одному правилу —
/// «каталоги, в которых уже есть сессии» (`StartTargets.derive`), — и от этого
/// терял ровно те проекты, ради которых полку открывают:
///
///   * только что созданный или клонированный — сессий в нём ещё нет;
///   * пустой — их в нём не было никогда;
///   * разделённый (control-share) — они есть, но у другого человека, и в
///     инвентарь этого зрителя не попадают.
///
/// Поэтому источников ДВА: опись сессий и ответ `projects.list` с машин
/// (`extra`). Kit это уже умеет — `CentralClient.listProjects` лежит в
/// `Net/Rpc.swift` с тех пор, как появился пикер, и им никто не пользовался.
///
/// Живёт в Kit, а не в приложении, по той же причине, что и `ProjectGrouping`:
/// это чистая функция от инвентаря, её можно прижать тестом, и ни SwiftUI, ни
/// UIKit ей не нужны.

/// Откуда агент узнал про проект.
public enum ProjectOrigin: String, Codable, Hashable, Sendable {
    /// Выведен из сессий (в вебе — из снимка флота).
    case sessions
    /// Найден сканированием корня проектов: репозиторий, в котором ещё не
    /// начинали ни одной сессии.
    case root
    /// Каталог, который назвали проектом руками.
    case adopted

    /// Незнакомое значение читается как `sessions` — ровно то, что означает
    /// ОТСУТСТВИЕ поля. Тот же приём, что у `OsKind` и `StreamKind`: агент
    /// новее этой сборки не должен ронять разбор всей полки, а цена ошибки
    /// здесь — одна подсказка «пустой проект», а не экран.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectOrigin(rawValue: raw) ?? .sessions
    }
}

/// Место, где можно начать сессию: пара (машина, каталог) с ярлыком проекта.
public struct ProjectTarget: Identifiable, Hashable, Sendable {
    public let machineId: String
    public let machineName: String
    public let cwd: String
    public let label: String
    public var lastModified: Double
    /// Твой: ты здесь что-то начинал, либо это неатрибутированная работа на
    /// твоей машине (см. `SessionSummary.isMine`).
    public var mine: Bool
    /// Сессии здесь, где агент прямо сейчас делает ход.
    public var live: Int
    /// Сессии здесь, которые ждут ответа или упали.
    public var attention: Int
    public var origin: ProjectOrigin?
    /// Есть ли здесь хоть одна сессия, которую видит опись.
    ///
    /// `false` = проект существует только потому, что его нашёл АГЕНТ: пустой,
    /// только что созданный или клонированный. Ровно то, чего одна опись не
    /// видит, и ровно то, что полка обязана назвать словом — иначе «ещё не
    /// начинали» и «всё закрыто» на ней неразличимы, а это разные ответы.
    ///
    /// Читать это по `origin` нельзя: агент ставит `root` и тем каталогам, где
    /// сессии ЕСТЬ, — «репозиторий на диске» для него более сильный факт, чем
    /// «здесь работали». Про пустоту `origin` не говорит ничего.
    public var hasSessions: Bool

    public var id: String { "\(machineId)::\(cwd)" }

    public init(machineId: String, machineName: String, cwd: String, label: String,
                lastModified: Double, mine: Bool = false, live: Int = 0, attention: Int = 0,
                origin: ProjectOrigin? = nil, hasSessions: Bool = true) {
        self.machineId = machineId
        self.machineName = machineName
        self.cwd = cwd
        self.label = label
        self.lastModified = lastModified
        self.mine = mine
        self.live = live
        self.attention = attention
        self.origin = origin
        self.hasSessions = hasSessions
    }
}

/// Место, за которым ещё не стоит ни одной найденной сессии: корень
/// control-share или проект, который агент нашёл сканированием своего корня.
public struct ExtraTarget: Hashable, Sendable {
    public let machineId: String
    public let cwd: String
    public let label: String
    public var origin: ProjectOrigin?
    /// Миллисекунды эпохи, когда агент их знает; 0 = не трогали никогда.
    public var lastModified: Double

    public init(machineId: String, cwd: String, label: String,
                origin: ProjectOrigin? = nil, lastModified: Double = 0) {
        self.machineId = machineId
        self.cwd = cwd
        self.label = label
        self.origin = origin
        self.lastModified = lastModified
    }
}

public enum ProjectShelf {
    /// Окно свежести: «здесь работают сейчас». Всё, что старше, достижимо
    /// поиском — просто не предлагается сразу.
    public static let recencyWindow: Double = 14 * 24 * 60 * 60 * 1000

    /// Корни, за которыми нет проекта: `/`, `/root`, голые домашние каталоги.
    public static func isRootish(_ cwd: String) -> Bool {
        // Буква диска — не уровень для проверки домашней папки (`C:\Users\x`
        // = `/home/x`), но `D:\hegai` — проект: корнем папка первого уровня
        // бывает только в POSIX (`/root`, `/srv`). Паритет с web `isRootish`.
        let norm = cwd.replacingOccurrences(of: "\\", with: "/")
        let drive = norm.range(of: #"^[A-Za-z]:"#, options: .regularExpression) != nil
        let seg = (drive ? String(norm.dropFirst(2)) : norm)
            .split(separator: "/").map(String.init)
        if seg.isEmpty || (!drive && seg.count == 1) { return true } // "/", "/root", "C:"
        return seg.count == 2 && ["users", "home"].contains(seg[0].lowercased())
    }

    /// Ключ, под которым проект считается на одной машине.
    ///
    /// Пути Windows регистронезависимы, и флот это доказывает: на `buildbox-pc`
    /// лежат `d:\Hegai_VScode\claudehegai` и `D:\Hegai_VScode\claudehegai` — одна
    /// папка, открытая из двух мест, которые по-разному написали букву диска.
    /// Побуквенный ключ превращал её в два проекта: две строки с одним именем,
    /// одним содержимым и без единого признака, чем они отличаются.
    ///
    /// Регистр складывается ТОЛЬКО там, где его складывает файловая система. На
    /// mac и Linux `Foo` и `foo` — разные каталоги, и слияние навело бы композер
    /// на тот из них, который просто попался первым.
    public static func key(machineId: String, cwd: String, os: OsKind?) -> String {
        "\(machineId)::\(os == .windows ? cwd.lowercased() : cwd)"
    }

    /// Куда этот зритель может начать сессию, свежее — выше.
    ///
    /// Три правила, и каждое существует потому, что плоский список «все каталоги
    /// флота» нарушал обещание:
    ///
    ///  * **Только стартовые машины.** Машине, на которой хаб откажется
    ///    стартовать, нечего делать в пикере, у которого одна работа — стартовать.
    ///  * **Не корень.** `/` и `/root` — это cwd, а не проект.
    ///  * **Не крон.** Скриптованная сессия не делает проект «твоим»: петля
    ///    лидов CRM просыпается каждые 20 минут на машине, которую хозяин
    ///    открывает редко, и полка «где ты работаешь» оказывалась во главе с
    ///    каталогом, в котором неделями никто ничего не печатал.
    ///
    /// `mine` НЕСЁТСЯ, а не фильтруется, — чтобы вызывающий мог предложить
    /// остальное длинным хвостом, а не делать вид, что его нет.
    public static func targets(machines: [MachineSnapshot],
                               viewerId: String?,
                               runs: [ActiveRunInfo],
                               extra: [ExtraTarget] = []) -> [ProjectTarget] {
        var runIndex: [String: ActiveRunInfo] = [:]
        for r in runs { runIndex["\(r.machineId)::\(r.sessionId)"] = r }

        var map: [String: ProjectTarget] = [:]
        var order: [String] = []
        for m in machines {
            guard m.canStartHere else { continue }
            for s in m.sessions {
                guard let cwd = s.cwd, !cwd.isEmpty, !isRootish(cwd), !s.isAutomated else { continue }
                let k = key(machineId: m.machine.machineId, cwd: cwd, os: m.machine.os)
                let run = runIndex["\(m.machine.machineId)::\(s.sessionId)"]
                var t = map[k] ?? {
                    order.append(k)
                    return ProjectTarget(
                        machineId: m.machine.machineId,
                        machineName: m.machine.name,
                        cwd: cwd,
                        label: s.project ?? cwd.split(separator: "/").last.map(String.init) ?? cwd,
                        lastModified: 0,
                        origin: .sessions,
                        hasSessions: true
                    )
                }()
                t.lastModified = max(t.lastModified, s.lastModified)
                t.mine = t.mine || s.isMine(on: m, viewerId: viewerId)
                // WORKING — это «агент делает ход», а не «сессия открыта».
                // `|| livePid` считал второе: возобновлённая сессия держит живой
                // процесс, пока она у тебя открыта, поэтому каждая когда-либо
                // тронутая сессия отчитывалась работающей, и счётчик перестал
                // что-либо значить.
                if run?.state == .working { t.live += 1 }
                if run?.state == .needs_attention || run?.state == .error { t.attention += 1 }
                map[k] = t
            }
        }
        // Корни control-share, за которыми пока нет ни одной найденной сессии
        // (холодный старт), — всё равно места, которые этому человеку выдали
        // явно: они его по определению. То же и с проектом, который агент нашёл
        // сканированием корня: он существует только потому, что его завели.
        // Фильтры «корень» и «времянка» действуют и здесь, чтобы список агента
        // не мог протащить `/tmp/…` на полку, которая прячет его для сессий.
        for e in extra {
            guard !isRootish(e.cwd), !SessionSummary.isScratchCwd(e.cwd) else { continue }
            let snap = machines.first { $0.machine.machineId == e.machineId }
            guard let snap, snap.canStartHere else { continue }
            let k = key(machineId: e.machineId, cwd: e.cwd, os: snap.machine.os)
            // Цель, про которую опись уже знает, что в ней есть сессии, — это
            // та же цель, а не вторая: что бы ни сказало сканирование корня.
            if map[k] != nil { continue }
            order.append(k)
            map[k] = ProjectTarget(machineId: e.machineId, machineName: snap.machine.name,
                                   cwd: e.cwd, label: e.label, lastModified: e.lastModified,
                                   mine: true, origin: e.origin, hasSessions: false)
        }
        return order.compactMap { map[$0] }.sorted { $0.lastModified > $1.lastModified }
    }

    /// Немногие проекты, которые предлагаются сразу: твои, тронутые недавно,
    /// свежие первыми. Откатывается к общему стартовому списку, а не показывает
    /// пустую полку человеку, чью работу хаб ещё не записал ни на кого.
    public static func recent(_ all: [ProjectTarget], limit: Int = 12,
                              now: Double = Date().timeIntervalSince1970 * 1000) -> [ProjectTarget] {
        let mine = all.filter { $0.mine && ($0.lastModified == 0 || now - $0.lastModified < recencyWindow) }
        return Array((mine.isEmpty ? all : mine).prefix(limit))
    }

    /// Свежий ли проект для полки. `0` — «сессий не было никогда», то есть
    /// созданный минуту назад, что противоположно протухшему.
    public static func isFresh(_ p: ProjectTarget,
                               now: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
        p.lastModified == 0 || now - p.lastModified < recencyWindow
    }

    /// Достаточно пути, чтобы отличить одноимённые проекты, — САМЫЙ КОРОТКИЙ
    /// суффикс, который в группе действительно разный.
    ///
    /// `claudehegai` на `buildbox-pc` лежит дважды. Первая попытка печатала
    /// родительскую папку, и на живом флоте она оказалась `Hegai_VScode` для
    /// ОБЕИХ копий: две строки, одно имя, один уточнитель, выбирать по-прежнему
    /// не из чего. Значит, фрагмент не может быть фиксированной глубины — он
    /// ровно настолько глубок, насколько пути перестают совпадать.
    ///
    /// Возвращает карту id→фрагмент на всю группу, потому что «самый короткий
    /// различающий суффикс» — свойство НАБОРА, а не одного пути.
    public static func disambiguate(_ group: [ProjectTarget]) -> [String: String] {
        guard group.count > 1 else { return [:] }
        let split = group.map { p -> (ProjectTarget, [String]) in
            (p, p.cwd.replacingOccurrences(of: "\\", with: "/")
                .split(separator: "/").map(String.init))
        }
        let deepest = split.map(\.1.count).max() ?? 0
        if deepest >= 2 {
            for take in 2...max(deepest, 2) {
                let seen = Set(split.map { $0.1.suffix(take).joined(separator: "/") })
                guard seen.count == split.count else { continue }
                var out: [String: String] = [:]
                for (p, parts) in split {
                    // Лист отбрасывается: это и есть ярлык, напечатанный рядом.
                    out[p.id] = parts.suffix(take).dropLast().joined(separator: "/")
                }
                return out
            }
        }
        // Пути, совпадающие до самого конца, невозможны (cwd и есть ключ), но
        // запасной вариант лучше пустого уточнителя на строке, которой он нужен.
        var out: [String: String] = [:]
        for (p, _) in split { out[p.id] = p.cwd }
        return out
    }
}

public extension SessionSummary {
    /// Одно определение «это моя работа» — на весь интерфейс.
    ///
    /// Откат на владельца МАШИНЫ — несущая половина. `owner` проставляет хаб из
    /// своей карты владельцев сессий, а строка там заводится только для сессии,
    /// которую начал сам cc-remote; сессия, которую агент нашёл на диске —
    /// каждый терминал и каждое окно VS Code, — приходит без владельца и обзавестись
    /// им уже не может. То есть `owner?.userId == viewerId` отфильтровал бы не
    /// чужих людей, а почти всю ТВОЮ СОБСТВЕННУЮ работу.
    ///
    /// …на ЛИЧНОЙ машине. Откат предполагает одного человека за этой
    /// клавиатурой, и общая коробка это предположение ломает: песочница
    /// сотрудников — одна машина одного владельца, на которой работают
    /// несколько человек, и приписывание каждого безымянного терминала её
    /// владельцу подшивало работу всей команды под «моё». На такой машине
    /// неатрибутированная сессия — ровно то, чем её назвал хаб:
    /// неатрибутированной, а это не твоё.
    ///
    /// Какая коробка считается общей — это `shared`, а НЕ `kind`: `kind`
    /// записывает, как машина заводилась, и песочница сотрудников заводилась
    /// личным устройством своего владельца. Единственная коробка флота, на
    /// которой работает целая команда, говорит про себя `personal`.
    func isMine(on machine: MachineSnapshot?, viewerId: String?, run: ActiveRunInfo? = nil) -> Bool {
        if let owner { return owner.userId == viewerId }
        if let ownerId = run?.ownerUserId { return ownerId == viewerId }
        if machine?.shared == true || machine?.isSandbox == true { return false }
        guard let machineOwner = machine?.owner else { return true }
        return machineOwner.userId == viewerId
    }

    /// Живёт ли сессия ПРЯМО СЕЙЧАС — по любому из двух независимых сигналов.
    ///
    /// Ран в любом состоянии считается, `idle` включительно: открытый ран держит
    /// замок единственного писателя, и сессия занята независимо от того, делает
    /// ли агент ход. `livePid` — вторая половина, и та, которую старое «Сейчас в
    /// работе» не видело вовсе: pid-файл под `~/.claude/sessions`, то есть
    /// собственный редактор или терминал человека.
    func isActive(run: ActiveRunInfo?) -> Bool { isLive || run != nil }
}
