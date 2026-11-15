import Foundation

/// Что агент делает прямо сейчас, двумя-тремя словами — «Думаю», «Читаю файл»,
/// «Ищу в коде», «Читаю сайт · github.com».
///
/// Заменило «работает · 8:25 · 5250.4k ток.» 08.10.2026 по просьбе владельца:
/// токены никто не читал, а «работает» повторяло пульсирующую метку. ChatGPT в
/// том же месте пишет одно серое слово («Думаю»); здесь то же, по последнему шагу хода.
///
/// ДОСЛОВНЫЙ порт `web/src/workActivity.ts`. Меняются вместе, таблицы тестов
/// (`web/test/work-activity.test.ts`, `ios/CCRemoteTests/WorkActivityTests.swift`) — тоже.
public enum WorkActivity {
    public static let thinking = "Думаю"

    /// Подпись для ТЕКУЩЕГО хода: считаются только строки после последней реплики человека.
    ///
    /// Идёт с конца и останавливается на первой значимой строке: копировать весь
    /// транскрипт в кортежи ради одной последней строки — по проходу на каждую дельту стрима.
    public static func of(_ lines: [TranscriptLine]) -> String {
        for line in lines.reversed() {
            if let said = classify(kind: line.kind.rawValue, text: line.text, streaming: line.streaming, code: line.code) {
                return said
            }
        }
        return thinking
    }

    /// Статусы, которыми шаг ЗАКАНЧИВАЕТСЯ: инструмент вернулся (Codex
    /// `command_output`, `tool_error`) или модель спросили снова (Claude
    /// `requesting`). После них ход между шагами, а не всё ещё «Собираю».
    private static let stepEnded: Set<String> = ["command_output", "tool_error", "requesting", "compact_done", "compact_failed"]

    static func label(_ lines: [(kind: String, text: String, streaming: Bool, code: String?)]) -> String {
        for line in lines.reversed() {
            if let said = classify(kind: line.kind, text: line.text, streaming: line.streaming, code: line.code) {
                return said
            }
        }
        return thinking
    }

    /// Слово для одной строки; nil — строка ничего не говорит, смотрим предыдущую.
    private static func classify(kind: String, text: String, streaming: Bool, code: String?) -> String? {
        switch kind {
        case "user": return thinking
        case "assistant": return streaming ? "Пишу ответ" : thinking
        case "tool_use": return tool(text)
        case "status", "system":
            if code == "compact_started" { return "Сжимаю контекст" }
            if let code, stepEnded.contains(code) { return thinking }
            return nil
        default: return thinking
        }
    }

    /// Одна строка `tool_use` → глагол. Незнакомый инструмент — «Работаю», без догадок.
    public static func tool(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.hasPrefix("$ ") { return command(String(t.dropFirst(2))) }
        if t.hasPrefix("edit ") { return "Пишу код" }
        if t.hasPrefix("web_search:") { return "Ищу в интернете" }
        if t.hasPrefix("mcp:") {
            return service(String(t.dropFirst(4)).trimmingCharacters(in: .whitespaces))
        }

        let name: String
        let input: String
        if let space = t.firstIndex(of: " ") {
            name = String(t[..<space])
            input = String(t[t.index(after: space)...])
        } else {
            name = t
            input = ""
        }
        switch name {
        case "Bash": return command(field(input, "command"))
        case "Read": return "Читаю файл"
        case "Grep", "Glob", "LS": return "Ищу в коде"
        case "Edit", "MultiEdit", "Write", "NotebookEdit": return "Пишу код"
        case "WebFetch":
            let host = hostOf(field(input, "url"))
            return host.isEmpty ? "Читаю сайт" : "Читаю сайт · \(host)"
        case "WebSearch": return "Ищу в интернете"
        case "Agent", "Task": return "Работает помощник"
        case "TodoWrite", planToolName: return "Составляю план"
        case "ExitPlanMode": return "Готовлю план"
        case "AskUserQuestion": return "Жду ответа"
        case "Skill": return "Открываю инструкцию"
        case "ToolSearch": return "Подбираю инструменты"
        case "Monitor", "BashOutput", "TaskOutput": return "Слежу за процессом"
        case "Workflow": return "Запускаю сценарий"
        default: break
        }
        if name.hasPrefix("mcp__") { return service(name) }
        return "Работаю"
    }

    private static let commandRules: [(String, String)] = [
        (#"\b(hegai-stt)\b"#, "Расшифровываю запись"),
        (#"\b(hegai-browser)\b"#, "Смотрю в браузере"),
        (#"\b(hegai-phone)\b"#, "Смотрю в телефоне"),
        (#"\b(hegai-image)\b"#, "Рисую картинку"),
        (#"\b(curl|wget)\b"#, "Смотрю сайт"),
        (#"\b(scp|rsync)\b"#, "Копирую файлы"),
        (#"(?<!["'=])\bssh\b|\bterm\.sh\b"#, "Работаю на другой машине"),
        (#"\b(vitest|jest|pytest|cargo test|go test|xcodebuild test|npm (run )?test|node --test|swift test)\b|check-protocol"#, "Прогоняю тесты"),
        (#"\b(git (push|commit|merge|rebase|pull|fetch|clone))\b"#, "Работаю с git"),
        (#"\b(deploy|systemctl (restart|reload)|pm2 (restart|reload))\b"#, "Выкатываю"),
        (#"\b(npm (run )?build|tsc|cargo build|xcodebuild|vite build|make)\b"#, "Собираю"),
        (#"\b(npm (i|install|ci)|pip3? install|apt(-get)? install|brew install)\b"#, "Ставлю пакеты"),
        (#"\b(psql|sqlite3|mysql)\b"#, "Смотрю базу"),
        (#"\b(ffmpeg|ffprobe)\b"#, "Обрабатываю видео"),
        (#"^(rg|grep|find|fd)\b|\|\s*(rg|grep)\b"#, "Ищу в коде"),
        (#"^(cat|head|tail|sed -n|less|wc|ls|tree|jq)\b"#, "Читаю файлы"),
        (#"^git\b"#, "Смотрю git"),
    ]

    static func command(_ cmd: String) -> String {
        let c = cmd.trimmingCharacters(in: .whitespacesAndNewlines)
        if c.isEmpty { return "Запускаю команду" }
        for (pattern, label) in commandRules where Re.test(pattern, in: c) {
            return label
        }
        return "Запускаю команду"
    }

    /// `mcp__claude_ai_Google_Drive__search_files` → «Смотрю Google Drive».
    static func service(_ tool: String) -> String {
        let parts = tool.components(separatedBy: "__").filter { !$0.isEmpty }
        let server = (parts.first == "mcp" ? (parts.count > 1 ? parts[1] : "") : (parts.first ?? ""))
        var name = server
        if name.hasPrefix("claude_ai_") { name = String(name.dropFirst("claude_ai_".count)) }
        name = name.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "Работаю с сервисом" : "Смотрю \(name)"
    }

    private static func field(_ json: String, _ key: String) -> String {
        if let data = json.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object[key] as? String ?? ""
        }
        // Длинный ввод может прийти обрезанным; первое поле всё равно читается.
        let pattern = "\"\(key)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)"
        guard let re = Re.regex(pattern),
              let m = re.firstMatch(in: json, range: NSRange(json.startIndex..., in: json)),
              let r = Range(m.range(at: 1), in: json) else { return "" }
        return String(json[r])
    }

    static func hostOf(_ url: String) -> String {
        guard let re = Re.regex(#"^[a-z][a-z0-9+.-]*://([^/?#:]+)"#, options: .caseInsensitive),
              let m = re.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
              let r = Range(m.range(at: 1), in: url) else { return "" }
        let host = String(url[r])
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}
