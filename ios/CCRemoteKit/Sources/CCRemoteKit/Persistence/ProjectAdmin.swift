import Foundation

/// Создание и удаление проекта и удаление сессии — правила веба
/// (`NewProjectPanel.tsx`, `StartScreen.tsx`, `appHooks.ts`), чтобы телефон не
/// придумывал своих. Только Foundation: запросы строятся здесь, а не во view.
public enum ProjectAdmin {
    /// Правило агента (`projects.create` в shared/src/rpc.ts), как в вебе:
    /// `^[a-z0-9][a-z0-9._-]{0,63}$`.
    public static func nameIsValid(_ name: String) -> Bool {
        let scalars = Array(name.unicodeScalars)
        guard !scalars.isEmpty, scalars.count <= 64 else { return false }
        func alnum(_ c: Unicode.Scalar) -> Bool {
            (c >= "a" && c <= "z") || (c >= "0" && c <= "9")
        }
        guard alnum(scalars[0]) else { return false }
        return scalars.allSatisfy { alnum($0) || $0 == "." || $0 == "_" || $0 == "-" }
    }

    /// Что становится набранным: строчные, серия пробелов — один дефис (имя — каталог).
    public static func normalizeName(_ raw: String) -> String {
        var out = ""
        var inSpace = false
        for ch in raw.lowercased() {
            if ch.isWhitespace {
                if !inSpace { out.append("-") }
                inSpace = true
            } else {
                out.append(ch)
                inSpace = false
            }
        }
        return out
    }

    /// Параметры `projects.create`: пустой репозиторий (`git init`, README и первый
    /// коммит делает агент) либо клон по https.
    public static func createParams(name: String, gitUrl: String? = nil) -> [String: JSONValue] {
        var p: [String: JSONValue] = ["name": .string(name)]
        let url = gitUrl?.trimmingCharacters(in: .whitespaces) ?? ""
        if url.isEmpty { p["template"] = .string("empty") } else { p["gitUrl"] = .string(url) }
        return p
    }

    public static func removeParams(cwd: String) -> [String: JSONValue] { ["cwd": .string(cwd)] }

    public static func deleteSessionParams(cwd: String, sessionId: String, source: String?) -> [String: JSONValue] {
        var p: [String: JSONValue] = ["cwd": .string(cwd), "sessionId": .string(sessionId)]
        if let source { p["source"] = .string(source) }
        return p
    }

    /// Ошибка агента при создании → предложение на языке человека; незнакомое
    /// остаётся как есть (догадка скрыла бы единственную строку с правдой).
    public static func describeCreateError(_ message: String) -> String {
        let m = message.lowercased()
        if m.contains("already exists") { return "Проект с таким именем уже есть." }
        if m.contains("limit reached") { return "На машине уже максимум проектов — уберите один, и место освободится." }
        if m.contains("timed out") { return "Git не ответил за две минуты — проверьте адрес или попробуйте позже." }
        if m.contains("read-only workspace") { return "В этом пространстве у вас только просмотр — создать проект можно на своей машине." }
        return message
    }

    /// Отказы `projects.remove` — слова из веба (`describeRemoveError`).
    public static func describeRemoveError(_ message: String) -> String {
        let m = message.lowercased()
        if m.contains("session is live") { return "В проекте идёт сессия — закрой её, потом убирай." }
        if m.contains("projects root") { return "Убрать можно только проект из папки проектов на машине." }
        if m.contains("not found") { return "Папки уже нет на машине." }
        return message
    }

    /// Подтверждение удаления проекта — слово в слово как в вебе.
    public static func removeConfirmation(label: String, machineName: String) -> String {
        "Убрать «\(label)» с машины \(machineName)?\n\nПапка переедет в корзину агента (~/.cc-remote/trash) — ничего не удаляется насовсем."
    }

    public static let deleteSessionConfirmation = "Удалить запись этой сессии?"

    /// В этом каталоге что-то держит процесс: сессия с живым `livePid` (редактор, терминал)
    /// или ран хаба. НЕ счётчик `ProjectTarget.live` (только `.working` и только ранов,
    /// сопоставленных с описью — в окне «ран есть, описи ещё нет» он ноль) и не
    /// `SessionSummary.active`. Ран, которого опись ещё не знает, каталога не называет —
    /// считаем его занятым, если он не опровергнут проектом (`project` совпал или пуст):
    /// лишняя скрытая кнопка дешевле отказа агента.
    public static func cwdIsBusy(machine: MachineSnapshot?, cwd: String, label: String,
                                 runs: [ActiveRunInfo]) -> Bool {
        guard let machine else { return false }
        let inCwd = machine.sessions.filter { $0.cwd == cwd }
        if inCwd.contains(where: { $0.livePid != nil }) { return true }
        let ids = Set(inCwd.map(\.sessionId))
        let known = Set(machine.sessions.map(\.sessionId))
        return runs.contains { r in
            guard r.machineId == machine.machine.machineId else { return false }
            if ids.contains(r.sessionId) { return true }
            if known.contains(r.sessionId) { return false }
            return r.project == nil || r.project == label
        }
    }

    /// «Удалить с машины» — только на управляемой машине, у проекта из корня
    /// проектов и без живых сессий (`StartScreen.tsx`); `busy` — `cwdIsBusy`.
    public static func canRemoveProject(machine: MachineSnapshot?, origin: ProjectOrigin?, busy: Bool) -> Bool {
        machine?.canControl == true && origin == .root && !busy
    }

    /// Удалять сессию можно на машине с полным контролем или свою
    /// (`canEditSession` в App.tsx): участник чужие записи не удаляет.
    public static func canDeleteSession(machine: MachineSnapshot?, session: SessionSummary, viewerId: String?) -> Bool {
        guard let machine else { return false }
        if machine.hasControl { return true }
        guard let owner = session.owner?.userId, let viewerId else { return false }
        return owner == viewerId
    }
}

public struct ProjectCreateResult: Decodable, Sendable {
    public let cwd: String
    public let label: String
    public let created: Bool
    public let git: String
}

public struct ProjectRemoveResult: Decodable, Sendable {
    public let ok: Bool
    public let movedTo: String?
}
