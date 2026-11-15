import Foundation

/// «Новая папка» участника на чужой машине: одна папка прямо в выданном корне.
/// Правила — зеркало хаба (`single_folder_name` и `at_shared_root` в
/// `server-rs/src/hub/rpc.rs`) и веба (`NewFolderPanel.tsx`). Хаб всё равно
/// решает сам; здесь — чтобы человек увидел причину до отправки.
public enum MemberFolder {
    /// Текст ошибки для имени или `nil`, если имя годится. Пустое имя — `nil`:
    /// кнопку прячет пустота, ругаться на неё не надо.
    public static func nameError(_ name: String) -> String? {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
        if name != name.trimmingCharacters(in: .whitespacesAndNewlines) { return "Пробелы по краям не нужны." }
        // Хаб считает символы Unicode, как и `count` у String в Rust — по скалярам.
        if name.unicodeScalars.count > 64 { return "Не длиннее 64 символов." }
        if name.hasPrefix(".") { return "Имя не может начинаться с точки." }
        let bad = name.unicodeScalars.contains { s in
            s == "/" || s == "\\" || s == ":" || s.value < 0x20 || (0x7f...0x9f).contains(s.value)
        }
        if bad { return "Одно имя: без «/», «\\» и «:»." }
        return nil
    }

    /// Самый глубокий выданный корень, внутри которого лежит `cwd` (или он сам).
    /// Хаб даёт участнику создать папку только В таком корне, не глубже.
    public static func root(containing cwd: String, roots: [String]) -> String? {
        let c = norm(cwd)
        var best: String?
        for r in roots {
            let n = norm(r)
            guard c == n || c.hasPrefix(n + "/") else { continue }
            if best.map({ n.count > norm($0).count }) ?? true { best = r }
        }
        return best
    }

    /// Полный путь новой папки — с тем разделителем, которым записан корень.
    public static func join(root: String, name: String) -> String {
        let windows = root.contains("\\") && !root.contains("/")
        let sep: Character = windows ? "\\" : "/"
        var base = root
        while base.count > 1, base.last == "/" || base.last == "\\" { base.removeLast() }
        return base.last == sep ? base + name : base + String(sep) + name
    }

    /// Ответ хаба/агента — по-человечески. Совпадает с вебом.
    public static func describe(_ message: String) -> String {
        let m = message.lowercased()
        if m.contains("connection closed") || m.contains("not connected") || m.contains("timeout") {
            return "Машина не ответила — подключение потерялось. Попробуй ещё раз."
        }
        if message.contains("Папка с таким именем уже есть") || m.contains("already exists") || m.contains("eexist") {
            return "Папка с таким именем уже есть."
        }
        if m.contains("read-only workspace") {
            return "Здесь нельзя создавать папки — только внутри общей папки."
        }
        if m.contains("not one of this machine's project roots") {
            return "Машина не открывает эту общую папку. Напиши владельцу сервера."
        }
        return message
    }

    private static func norm(_ p: String) -> String {
        var s = p.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\\", with: "/")
        while s.count > 1, s.hasSuffix("/") { s.removeLast() }
        let driveOrUnc = s.hasPrefix("//") || (s.count >= 2 && s.dropFirst().first == ":" && s.first?.isLetter == true)
        return driveOrUnc ? s.lowercased() : s
    }
}
