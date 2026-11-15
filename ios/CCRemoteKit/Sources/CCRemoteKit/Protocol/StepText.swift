import Foundation

/// Один вызов инструмента так, как его читает человек: «Смотрю размер папок на
/// мини», «Читаю SubagentViews.swift», «Ищу «stepOf»» — а не
/// `Bash · cd /srv/main-source; deploy/term.sh …`.
///
/// ДОСЛОВНЫЙ порт `web/src/stepText.ts` (20.10.2026, просьба владельца). Меняются
/// вместе; таблицы тестов — `web/test/step-text.test.ts` и
/// `ios/CCRemoteTests/StepTextTests.swift` — тоже.
///
/// Claude пишет `description` к каждому Bash — это предложение и есть шаг. Без
/// него (шеллы Codex, старая модель) команда читается по тому, что она заметнее
/// всего делает, теми же правилами, что слово «Думаю / Собираю» под
/// транскриптом (`WorkActivity`). Сырая команда или путь остаются в `detail`.
///
/// Никаких регулярок с вложенными необязательными квантификаторами: в вебе на
/// разборе ssh нашли ReDoS, поэтому разбор токенов здесь линейный и ручной.
public struct Step: Equatable, Sendable {
    /// Предложение, которое показывает карточка.
    public var text: String
    /// Сырой аргумент за ним (команда, полный путь, URL).
    public var detail: String?

    public init(text: String, detail: String? = nil) {
        self.text = text
        self.detail = detail
    }
}

public enum StepText {
    private static let maxText = 160

    // MARK: - Public

    public static func human(name: String, input: JSONValue) -> Step {
        human(name: name, input: object(of: input))
    }

    public static func human(name: String, input: [String: Any]) -> Step {
        func s(_ k: String) -> String {
            guard let v = input[k] as? String else { return "" }
            return v.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let desc = s("description")
        switch name {
        case "Bash", "$", "PowerShell":
            let cmd = s("command")
            if !desc.isEmpty { return step(sentence(desc), cmd) }
            return step(commandText(cmd), cmd)
        case "Read":
            return fileStep("Читаю", s("file_path").isEmpty ? s("path") : s("file_path"))
        case "Edit", "MultiEdit":
            return fileStep("Правлю", s("file_path").isEmpty ? s("path") : s("file_path"))
        case "Write":
            return fileStep("Пишу", s("file_path").isEmpty ? s("path") : s("file_path"))
        case "NotebookEdit":
            return fileStep("Правлю блокнот", s("notebook_path").isEmpty ? s("file_path") : s("notebook_path"))
        case "Grep":
            let pattern = s("pattern")
            let path = s("path")
            let where_ = path.isEmpty ? "" : " в \(tail(path))"
            let text = pattern.isEmpty ? "Ищу в коде" : "Ищу «\(short(pattern, 60))»\(where_)"
            return step(text, path.isEmpty ? nil : path)
        case "Glob":
            let pattern = s("pattern")
            let path = s("path")
            return step(pattern.isEmpty ? "Ищу файлы" : "Ищу файлы \(short(pattern, 60))", path.isEmpty ? nil : path)
        case "LS":
            return fileStep("Смотрю папку", s("path"))
        case "WebFetch":
            let url = s("url")
            let host = WorkActivity.hostOf(url)
            return step(host.isEmpty ? "Читаю сайт" : "Читаю \(host)", url.isEmpty ? nil : url)
        case "WebSearch", "web_search", "Search", "web_search_call":
            let q = s("query")
            return step(q.isEmpty ? "Ищу в интернете" : "Ищу в интернете: \(q)")
        case "Agent", "Task":
            return step(desc.isEmpty ? "Зову помощника" : "Помощник: \(desc)")
        case "TodoWrite", planToolName:
            return step("Обновляю план")
        case "ExitPlanMode":
            return step("Предлагаю план")
        case "AskUserQuestion":
            return step("Задаю вопрос")
        case "Skill":
            return step(s("skill").isEmpty ? "Открываю инструкцию" : "Открываю инструкцию \(s("skill"))")
        case "ToolSearch", "tool_search_call":
            return step("Подбираю инструменты")
        case "Monitor", "BashOutput", "TaskOutput":
            return step(desc.isEmpty ? "Слежу за фоновым процессом" : sentence(desc))
        case "KillShell", "KillBash", "TaskStop":
            return step("Останавливаю фоновый процесс")
        case "Workflow":
            return step("Запускаю сценарий")
        case "ScheduleWakeup":
            return step("Ставлю напоминание себе")
        default:
            break
        }
        if name.hasPrefix("mcp__") || name.hasPrefix("mcp:") {
            let tool = name.components(separatedBy: "__").filter { !$0.isEmpty }.last ?? ""
            let what = (name.hasPrefix("mcp__") && tool != name) ? " · " + tool.replacingOccurrences(of: "_", with: " ") : ""
            var service = name
            if service.hasPrefix("mcp:") {
                service = String(service.dropFirst(4).drop(while: { $0.isWhitespace }))
            }
            return step(WorkActivity.service(service) + what)
        }
        if !desc.isEmpty { return step(sentence(desc)) }
        return step(name.isEmpty ? "Работаю" : name)
    }

    /// Живая строка `tool_use`: Claude «Name {json}», Codex «$ cmd»,
    /// «edit paths», «web_search: q», «mcp: tool».
    public static func toolLine(_ text: String) -> Step {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.hasPrefix("$ ") { return human(name: "$", input: ["command": String(t.dropFirst(2))]) }
        if t.hasPrefix("edit ") {
            let rest = String(t.dropFirst(5))
            let paths = rest.split(whereSeparator: { $0 == "," || $0.isWhitespace }).map(String.init)
            let said = paths.isEmpty ? "Правлю файлы" : "Правлю " + paths.map(tail).joined(separator: ", ")
            return step(said, rest)
        }
        if t.hasPrefix("web_search:") {
            let q = String(t.dropFirst(11)).trimmingCharacters(in: .whitespacesAndNewlines)
            return human(name: "WebSearch", input: ["query": q])
        }
        if t.hasPrefix("mcp:") {
            return step(WorkActivity.service(String(t.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        guard let space = t.firstIndex(of: " ") else { return human(name: t, input: [String: Any]()) }
        let afterSpace = t.index(after: space)
        guard afterSpace < t.endIndex, t[afterSpace] == "{" else { return step(t) }
        let name = String(t[..<space])
        let json = String(t[afterSpace...])
        var input: [String: Any] = [:]
        if let data = json.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
            input = parsed as? [String: Any] ?? [:]
        } else {
            // Длинный ввод приходит обрезанным; ведущие поля всё равно читаются.
            input = salvage(json)
        }
        return human(name: name, input: input)
    }

    /// Шаг помощника в том виде, в каком его шлёт агент (`Subagent.lastAction`,
    /// `recent`): собственное предложение CLI или «Tool · что». У Claude «что»
    /// для Bash — обычно уже description; у Codex — сама команда. Различаем и
    /// формулируем остальное как любой другой шаг.
    public static func action(_ action: String) -> Step {
        let a = action.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.hasPrefix("$ ") || a.hasPrefix("edit ") || a.hasPrefix("web_search:") || a.hasPrefix("mcp:") {
            return toolLine(a)
        }
        guard let sep = a.range(of: " · ") else { return step(a) }
        let name = String(a[..<sep.lowerBound])
        let rest = String(a[sep.upperBound...])
        guard isToolName(name), !rest.isEmpty else { return step(a) }
        if name == "Bash" {
            if !looksLikeCommand(rest) { return step(sentence(rest)) }
            let asCommand = human(name: "Bash", input: ["command": rest])
            // «check generated files»: простые слова, которых не знает ни одно
            // правило, читаются лучше как описание, чем как «Запускаю check».
            if asCommand.text.hasPrefix("Запускаю ") || asCommand.text == "Выполняю команду", isLowercaseWords(rest.trimmingCharacters(in: .whitespacesAndNewlines)) {
                return step(sentence(rest))
            }
            return asCommand
        }
        if name == "Edit", rest.contains(", ") {
            return step("Правлю " + rest.components(separatedBy: ", ").map(tail).joined(separator: ", "), rest)
        }
        if name == "MCP" {
            let parts = rest.components(separatedBy: "/")
            let server = parts.first ?? rest
            let what = rest.contains("/") ? " · " + (parts.last ?? "") : ""
            return step(WorkActivity.service(server) + what)
        }
        if name == "Tool" { return step(rest) }
        if let field = actionField[name] { return human(name: name, input: [field: rest]) }
        return human(name: name, input: ["description": rest])
    }

    // MARK: - Tables

    /// Имена инструментов в строке помощника «Tool · что» и поле ввода, которым было «что».
    private static let actionField: [String: String] = [
        "Read": "file_path", "Edit": "file_path", "MultiEdit": "file_path", "Write": "file_path",
        "NotebookEdit": "notebook_path", "Grep": "pattern", "Glob": "pattern", "LS": "path",
        "WebFetch": "url", "WebSearch": "query", "Search": "query",
        "Agent": "description", "Task": "description", "Skill": "skill",
    ]

    private static let gitLook: [String: String] = [
        "status": "Смотрю, что изменено в git",
        "log": "Смотрю историю git",
        "diff": "Смотрю изменения",
        "show": "Смотрю коммит",
        "branch": "Смотрю ветки git",
    ]

    /// Опции ssh, которым нужен аргумент (`-o X`, `-p 22`).
    private static let sshArgFlags: Set<Character> = Set("BbcDEeFIiJLlmOoPpQRSWw")

    // MARK: - Command wording

    /// Описание Bash, а не строка шелла: предложение начинается с заглавной (или
    /// кириллической) буквы и не несёт шелловой пунктуации.
    static func looksLikeCommand(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = t.unicodeScalars.first else { return true }
        if isCyrillic(first) { return false }
        if t.contains(where: { ";|&`$<>".contains($0) }) { return true }
        if Re.test(#"\s--?\w"#, in: t) { return true }
        let tokens = t.split(whereSeparator: { $0.isWhitespace })
        if tokens.count >= 2, isEnvAssign(String(tokens[0])) { return true }   // ENV=x cmd
        if Re.test(#"^[A-Z][a-z]+-[A-Z]"#, in: t) { return true } // PowerShell Verb-Noun
        if first.value >= 65 && first.value <= 90 { return false }
        return true
    }

    /// Команда без описания — по тому, что она делает: «Смотрю размер папок
    /// на dev-mac-mini-001», «Жду ответа legal.acme.test», «Запускаю node».
    private static func commandText(_ cmd: String, depth: Int = 0) -> String {
        let c = cmd.trimmingCharacters(in: .whitespacesAndNewlines)
        if c.isEmpty { return "Запускаю команду" }
        // `cd somewhere; real thing` — cd ничего не говорит.
        let body = Re.replacing(#"^cd\s+\S+\s*(?:&&|;)\s*"#, in: c, with: "")
        // До проверки машины: цикл, опрашивающий по ssh, — ожидание, а не вход.
        if let wait = waitText(body, depth: depth) { return wait }
        if depth == 0, let remote = remoteTarget(body) { return remoteStep(remote, depth: depth) }
        if let file = readTarget(body) { return "Читаю \(tail(file))" }
        if let dir = listTarget(body) { return dir.isEmpty ? "Смотрю, что в папке" : "Смотрю папку \(tail(dir))" }
        if let sub = group(#"^git\s+(status|log|diff|show|branch)\b"#, in: body), let said = gitLook[sub] { return said }
        if let service = serviceStep(body) { return service }
        let label = WorkActivity.command(body)
        if label != "Запускаю команду" { return label }
        return programStep(body) ?? "Выполняю команду"
    }

    /// Пауза или цикл опроса — по тому, чего ждёт (веб `waitText`, 02.11.2026:
    /// карточка «Жду · Жду · Жду» над проверкой выкатки не говорила ничего).
    /// `sleep N` — пауза и то, что после неё; `until` / `while` / `for` со
    /// `sleep` — условие: сайт, вывод фоновой задачи, ref в git, процесс, файл,
    /// машина. Не ожидание — nil.
    private static func waitText(_ body: String, depth: Int) -> String? {
        func cap(_ m: NSTextCheckingResult, _ i: Int, _ s: String) -> String? {
            let r = m.range(at: i)
            guard r.location != NSNotFound, let range = Range(r, in: s) else { return nil }
            return String(s[range])
        }
        if let m = Re.firstMatch(#"^sleep\s+(\d+(?:\.\d+)?)([smhd]?)\s*(?:(?:;|&&)\s*([\s\S]*))?$"#, in: body) {
            let head = "Жду \(waitDuration(Double(cap(m, 1, body) ?? "") ?? 0, cap(m, 2, body) ?? ""))"
            let rest = (cap(m, 3, body) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if rest.isEmpty { return head }
            let host = urlHost(rest)
            let then = host.isEmpty ? lowerFirst(commandText(rest, depth: depth)) : "проверяю \(host)"
            return "\(head), потом \(then)"
        }
        let loop = Re.firstMatch(#"^(until|while)\s+([\s\S]+?)[;\n]\s*do\b"#, in: body)
        var cond: String?
        var kind = ""
        if let loop {
            cond = cap(loop, 2, body)
            kind = cap(loop, 1, body) ?? ""
        } else if Re.test(#"^for\b"#, in: body), Re.test(#"\bsleep\b"#, in: body) {
            cond = Re.group(#"\bdo\b([\s\S]*?)\bsleep\b"#, in: body) ?? ""
        }
        guard let cond else { return Re.test(#"^sleep\b"#, in: body) ? "Жду" : nil }
        if Re.test(#"/tasks/[\w-]+\.output\b"#, in: cond) { return "Жду фоновую задачу" }
        let host = urlHost(cond)
        if !host.isEmpty { return "Жду ответа \(host)" }
        if Re.test(#"refs/ci-ok\b"#, in: cond) { return "Жду зелёный CI" }
        if let ref = Re.group(#"refs/heads/([\w./-]+)"#, in: cond) { return "Жду ветку \(ref)" }
        // `until X` и `while ! X` ждут появления X, `while X` — его ухода.
        let neg = Re.test(#"^\s*!"#, in: cond) || Re.test(#"\[\s+!\s"#, in: cond)
        let forAppear = (kind == "while") == neg
        if let proc = Re.group(#"\bpgrep\b(?:\s+-\S+)*\s+['"]?([\w.-]+)"#, in: cond) {
            return forAppear ? "Жду запуска \(proc)" : "Жду, пока завершится \(proc)"
        }
        if let file = Re.group(#"\[\s+(?:!\s+)?-[sfed]\s+['"]?([^\s'"\]]+)"#, in: cond) {
            return forAppear ? "Жду файл \(tail(file))" : "Жду, пока исчезнет \(tail(file))"
        }
        if let server = remoteTarget(cond)?.host {
            return "Жду сервер \(Re.replacing(#"^[^@]*@"#, in: server, with: ""))"
        }
        return "Жду"
    }

    private static func waitDuration(_ n: Double, _ unit: String) -> String {
        // `Int(n)` падает за Int.max, а `sleep 99999999999999999999` — допустимая команда.
        let whole = Int(exactly: n)
        let num = whole.map(String.init) ?? String(n)
        switch unit {
        case "m": return "\(num) мин"
        case "h": return "\(num) ч"
        case "d": return "\(num) дн"
        default:
            if let w = whole, w >= 60, w % 60 == 0 { return "\(w / 60) мин" }
            return "\(num) с"
        }
    }

    private static func urlHost(_ s: String) -> String {
        guard let url = Re.group(#"https?://[^\s'"\\);|&<>]+"#, in: s, at: 0) else { return "" }
        return WorkActivity.hostOf(url)
    }

    private static func lowerFirst(_ s: String) -> String {
        s.prefix(1).lowercased() + s.dropFirst()
    }

    private struct Remote {
        let host: String
        /// Команда, отправленная на машину; "" — интерактивный вход.
        let command: String
        /// `term.sh` (команда через агента машины), а не `ssh`.
        let term: Bool
    }

    /// Работа на другой машине — по тому, что там делается (веб `remoteStep`,
    /// 31.10.2026): удалённая команда словами + «на <машина>». Не распознана —
    /// «Захожу на stage» (ssh) или «Даю команду на dev-mac-mini-001» (term.sh).
    private static func remoteStep(_ r: Remote, depth: Int) -> String {
        let host = Re.replacing(#"^[^@]*@"#, in: r.host, with: "")
        let fallback = r.term ? "Даю команду на \(host)" : "Захожу на \(host)"
        if r.command.isEmpty { return fallback }
        let inner = commandText(r.command, depth: depth + 1)
        if ["Выполняю команду", "Запускаю команду", "Работаю на другой машине"].contains(inner) { return fallback }
        if inner == "Проверяю состояние" { return "Проверяю состояние \(host)" }
        if inner.hasPrefix("Запускаю скрипт на ") { return "Запускаю скрипт на \(host)" }
        return "\(inner) на \(host)"
    }

    /// Команды служб и машины словами: `uptime`, `systemctl`, `journalctl`,
    /// `pm2 restart`, `git pull` (веб `serviceStep`). Не распознано — nil.
    private static func serviceStep(_ body: String) -> String? {
        let b = Re.replacing(#"^sudo\s+"#, in: body, with: "")
        if Re.test(#"^uptime\b"#, in: b) { return "Проверяю состояние" }
        let ctl = #"^systemctl\s+(?:-[\w-]*(?:\s+\d+)?\s+)*(status|is-active|restart|reload|start|stop)\b\s*(?:-[A-Za-z0-9_-]*(?:\s+\d+)?\s+)*((?:[A-Za-z0-9_@.:][A-Za-z0-9_@.:-]*)?)"#
        if let verb = Re.group(ctl, in: b) {
            let unit = Re.replacing(#"\.service$"#, in: Re.group(ctl, in: b, at: 2) ?? "", with: "")
            switch verb {
            case "status", "is-active": return unit.isEmpty ? "Проверяю службы" : "Проверяю службу \(unit)"
            case "restart", "reload": return unit.isEmpty ? "Перезапускаю службу" : "Перезапускаю \(unit)"
            case "start": return unit.isEmpty ? "Запускаю службу" : "Запускаю службу \(unit)"
            default: return unit.isEmpty ? "Останавливаю службу" : "Останавливаю службу \(unit)"
            }
        }
        if Re.test(#"^journalctl\b"#, in: b) {
            let unit = group(#"\s(?:-u\s*|--unit[=\s])([A-Za-z0-9_@.:-]+)"#, in: b).map { Re.replacing(#"\.service$"#, in: $0, with: "") }
            return unit.map { "Читаю лог \($0)" } ?? "Читаю лог"
        }
        if let pm2 = group(#"^pm2\s+(?:restart|reload)\s+([A-Za-z0-9_@.-]+)(?!\S)"#, in: b) { return "Перезапускаю \(pm2)" }
        if Re.test(#"^git\s+pull\b"#, in: b) { return "Обновляю код" }
        return nil
    }

    /// Обёртки и слова оболочки, ничего не говорящие о том, что запущено.
    private static let shellNoise: Set<String> = ["sudo", "env", "nice", "nohup", "time", "exec", "export", "set", "local", "then", "do", "if", "!", "(", "{"]
    private static let interpreters: [String: String] = ["python": "Python", "python3": "Python", "node": "Node", "bash": "bash", "sh": "bash", "zsh": "bash", "ruby": "Ruby", "perl": "Perl"]

    /// Программа команды словами (веб `programStep`, 20.10.2026): присваивания и
    /// обёртки пропускаются, `sed -i` правит файл, интерпретатор называет скрипт.
    private static func programStep(_ body: String) -> String? {
        var tokens = Array(body.prefix(600).split(whereSeparator: { $0.isWhitespace }).prefix(60).map(String.init))
        var i = 0
        while i < tokens.count, isAssignment(tokens[i]) || shellNoise.contains(tokens[i]) {
            // `S=$(du -sk …)` — запускается то, что внутри подстановки.
            if let sub = group(#"^[A-Za-z_]\w*="?\$\((.+)$"#, in: tokens[i]) {
                tokens[i] = sub
                break
            }
            i += 1
        }
        if i + 1 < tokens.count, tokens[i] == "timeout", tokens[i + 1].first?.isNumber == true { i += 2 }
        guard i < tokens.count else { return nil }
        let prog = tokens[i]
        let okChars = !prog.isEmpty && !prog.hasPrefix("-") && prog.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || "_./-".contains($0) }
        guard okChars else { return nil }
        let name = tail(prog)
        let rest = Array(tokens[(i + 1)...])
        if name == "sed", rest.contains(where: { $0.hasPrefix("-i") }) {
            if let file = rest.reversed().first(where: { !$0.hasPrefix("-") && hasExtension($0) }) {
                return "Правлю \(tail(file.trimmingCharacters(in: CharacterSet(charactersIn: "'\""))))"
            }
            return "Правлю файл"
        }
        if let lang = interpreters[name] {
            if let idx = rest.firstIndex(where: { !$0.hasPrefix("-") && hasExtension($0) }),
               !rest[..<idx].contains(where: { $0 == "-c" || $0 == "-e" }) {
                return "Запускаю скрипт \(tail(rest[idx]))"
            }
            return "Запускаю скрипт на \(lang)"
        }
        if name == "du" { return "Смотрю размер папок" }
        if name == "df" { return "Смотрю место на диске" }
        return "Запускаю \(name)"
    }

    private static func isAssignment(_ t: String) -> Bool {
        Re.test(#"^[A-Za-z_]\w*="#, in: t)
    }

    private static func hasExtension(_ t: String) -> Bool {
        Re.test(#"\.\w+$"#, in: t)
    }

    /// `cat|head|tail|less|bat|wc|sed -n X` [флаги [число]]… файл.расширение.
    private static func readTarget(_ body: String) -> String? {
        let tokens = Array(body.prefix(600).split(whereSeparator: { $0.isWhitespace }).prefix(60).map(String.init))
        guard let head = tokens.first else { return nil }
        var i = 1
        if ["cat", "head", "tail", "less", "bat", "wc"].contains(head) {
            // ok
        } else if head == "sed", tokens.count >= 3, tokens[1] == "-n" {
            i = 3
        } else {
            return nil
        }
        while i < tokens.count {
            let t = tokens[i]
            if t.count >= 2, t.hasPrefix("-") {
                i += 1
                if i < tokens.count, !tokens[i].isEmpty, tokens[i].allSatisfy({ $0.isASCII && $0.isNumber }) { i += 1 }
                continue
            }
            return group(#"^[^\s|;&<>]+\.\w+"#, in: t)
        }
        return nil
    }

    /// `ls|tree` [-флаги] [путь]; пустая строка — путь не назван.
    private static func listTarget(_ body: String) -> String? {
        let rest: Substring
        if body.hasPrefix("ls") { rest = body.dropFirst(2) }
        else if body.hasPrefix("tree") { rest = body.dropFirst(4) }
        else { return nil }
        if let next = rest.first, next.isLetter || next.isNumber || next == "_" { return nil }   // \b
        var s = Substring(String(rest.prefix(600)))
        while true {
            let ws = s.prefix(while: { $0.isWhitespace }).count
            let after = s.dropFirst(ws)
            if ws > 0, after.hasPrefix("-"), after.count >= 2 {
                s = after.drop(while: { !$0.isWhitespace })
                continue
            }
            s = after
            break
        }
        return String(s.prefix(while: { !$0.isWhitespace && !"|;&<>".contains($0) }))
    }

    /// Первое слово команды после `VAR=x`.

    /// Машина, на которой работает команда, и команда, отправленная туда:
    /// `term.sh HOST [WAIT] 'cmd'` или первый `ssh [флаги] HOST [cmd]` (веб
    /// `remoteTarget`). Линейный разбор токенов, кавычки группируют токен.
    private static func remoteTarget(_ cmd: String) -> Remote? {
        if let at = Re.firstRange(#"\bterm\.sh\s"#, in: cmd) {
            let tokens = shellTokens(String(cmd[at.upperBound...].prefix(600)), limit: 40)
            if let host = tokens.first, Re.test(#"^[\w.-]+$"#, in: host) {
                var rest = Array(tokens.dropFirst())
                if let wait = rest.first, !wait.isEmpty, wait.allSatisfy({ $0.isASCII && $0.isNumber }) { rest.removeFirst() }
                return Remote(host: host, command: remoteCommand(rest), term: true)
            }
        }
        // `rsync -e ssh …` копирует, `GIT_SSH_COMMAND="ssh …"` настраивает — это не вход.
        if Re.test(#"^(?:sudo\s+)?(?:scp|rsync)\b"#, in: cmd) { return nil }
        guard let at = Re.firstRange(#"(?<!["'=])\bssh\s"#, in: cmd) else { return nil }
        // Как в вебе: 3 символа «ssh» и пробел отсекаются, дальше ≤ 600 символов.
        let tokens = shellTokens(String(cmd[at.upperBound...].prefix(600)), limit: 40)
        var i = 0
        while i < tokens.count {
            let t = tokens[i]
            if t.hasPrefix("-") {
                if t.count == 2, let flag = t.last, sshArgFlags.contains(flag) { i += 1 }
                i += 1
                continue
            }
            guard Re.test(#"^[\w@.][\w@.-]*$"#, in: t) else { return nil }
            return Remote(host: t, command: remoteCommand(Array(tokens[(i + 1)...])), term: false)
        }
        return nil
    }

    /// Токены после хоста до первой локальной трубы или перенаправления, один
    /// слой кавычек снят: `'du -sk' | tail` → `du -sk`.
    private static func remoteCommand(_ tokens: [String]) -> String {
        var taken: [String] = []
        for t in tokens {
            if Re.test(#"^(?:\||\|\||&&|;|&|<.*|>.*|\d>.*)$"#, in: t) { break }
            taken.append(t)
            if t.hasSuffix(";") { break }
        }
        var out = taken.joined(separator: " ")
        if out.hasSuffix(";") { out.removeLast() }
        out = out.trimmingCharacters(in: .whitespaces)
        if let q = out.first, q == "'" || q == "\"" {
            out.removeFirst()
            if out.last == q { out.removeLast() }
            out = out.trimmingCharacters(in: .whitespaces)
        }
        return out
    }

    /// `"…"` | `'…'` | `\S+` — как `match(/"[^"]*"|'[^']*'|\S+/g)`.
    private static func shellTokens(_ s: String, limit: Int) -> [String] {
        let chars = Array(s)
        var out: [String] = []
        var i = 0
        while i < chars.count, out.count < limit {
            if chars[i].isWhitespace { i += 1; continue }
            var end = i
            if chars[i] == "\"" || chars[i] == "'" {
                var j = i + 1
                while j < chars.count, chars[j] != chars[i] { j += 1 }
                if j < chars.count { end = j + 1 }
            }
            if end == i {
                end = i
                while end < chars.count, !chars[end].isWhitespace { end += 1 }
            }
            out.append(String(chars[i..<end]))
            i = end
        }
        return out
    }

    // MARK: - Small helpers

    private static func fileStep(_ verb: String, _ path: String) -> Step {
        path.isEmpty ? step("\(verb) файл") : step("\(verb) \(tail(path))", path)
    }

    private static func step(_ text: String, _ detail: String? = nil) -> Step {
        var out = Step(text: short(text, maxText))
        if let detail, !detail.isEmpty, detail != text {
            out.detail = detail.count > 2000 ? String(detail.prefix(1999)) + "…" : detail
        }
        return out
    }

    /// «list files in home» → «List files in home».
    private static func sentence(_ s: String) -> String {
        let t = collapse(s)
        return t.prefix(1).uppercased() + t.dropFirst()
    }

    static func tail(_ p: String) -> String {
        p.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? p
    }

    private static func collapse(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func short(_ s: String, _ max: Int) -> String {
        let one = collapse(s)
        return one.count > max ? String(one.prefix(max - 1)) + "…" : one
    }

    /// Строковые поля JSON, оборванного на полуслове.
    private static func salvage(_ json: String) -> [String: Any] {
        var out: [String: Any] = [:]
        guard let re = Re.regex(#""(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"#) else { return out }
        let ns = json as NSString
        for m in re.matches(in: json, range: NSRange(location: 0, length: ns.length)) {
            let key = ns.substring(with: m.range(at: 1))
            let raw = ns.substring(with: m.range(at: 2))
            if let data = "\"\(raw)\"".data(using: .utf8),
               let decoded = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? String {
                out[key] = decoded
            } else {
                out[key] = raw
            }
        }
        return out
    }

    private static func group(_ pattern: String, in s: String) -> String? {
        Re.group(pattern, in: s)
    }

    private static func object(of value: JSONValue) -> [String: Any] {
        guard case let .object(o) = value else { return [:] }
        return o.mapValues(any)
    }

    private static func any(_ v: JSONValue) -> Any {
        switch v {
        case let .string(s): return s
        case let .number(n): return n
        case let .bool(b): return b
        case let .array(a): return a.map(any)
        case let .object(o): return o.mapValues(any)
        case .null: return NSNull()
        }
    }

    private static func isCyrillic(_ u: Unicode.Scalar) -> Bool {
        (0x410...0x44F).contains(u.value) || u.value == 0x401 || u.value == 0x451
    }

    private static func isToolName(_ s: String) -> Bool {
        guard let first = s.unicodeScalars.first, first.isASCII, first.properties.isAlphabetic else { return false }
        return s.unicodeScalars.allSatisfy { u in
            u.isASCII && (u.properties.isAlphabetic || (0x30...0x39).contains(u.value) || u == "_" || u == "-")
        }
    }

    /// `[A-Za-z_]\w*=` в начале токена.
    private static func isEnvAssign(_ t: String) -> Bool {
        guard let eq = t.firstIndex(of: "=") else { return false }
        let name = t[..<eq]
        guard let first = name.unicodeScalars.first, first.isASCII, first.properties.isAlphabetic || first == "_" else { return false }
        return name.unicodeScalars.allSatisfy { u in
            u.isASCII && (u.properties.isAlphabetic || (0x30...0x39).contains(u.value) || u == "_")
        }
    }

    /// `\w+=\S+`: переменная и непустое значение.
    private static func isEnvValue(_ t: String) -> Bool {
        guard let eq = t.firstIndex(of: "="), eq != t.startIndex else { return false }
        let name = t[..<eq]
        return name.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" } && t.index(after: eq) < t.endIndex
    }

    /// `^[a-z]+(?: [a-z]+)+$` без учёта регистра: два слова и больше, только латиница.
    private static func isLowercaseWords(_ s: String) -> Bool {
        let words = s.components(separatedBy: " ")
        guard words.count >= 2 else { return false }
        return words.allSatisfy { w in
            !w.isEmpty && w.unicodeScalars.allSatisfy { $0.isASCII && $0.properties.isAlphabetic }
        }
    }
}
