import Foundation

/// Какие файлы ответ агента НАЗВАЛ так, что их стоит показать: скриншот или
/// markdown-заметку. «Скриншот: /tmp/agents-0/-srv-x/<id>/scratchpad/mail.png»
/// в последней строке ответа превращается в миниатюру под текстом.
///
/// Правила зеркалят веб (и список расширений `FS_PEEK_EXTENSIONS` в
/// `shared/src/rpc.ts`): меняются вместе.
///  - абсолютный POSIX-путь, Windows `C:\…` или относительный с хотя бы одним `/`;
///  - расширение png jpg jpeg gif webp md markdown, без учёта регистра;
///  - работает внутри обратных кавычек и markdown-ссылок `[x](/a/b.png)`;
///  - хвостовая пунктуация `.,;:)»"'` не часть пути; URL игнорируются;
///  - пробелы: в обратных кавычках, `](<…>)`, "…" и «…» путь — весь промежуток;
///    в прозе один пробел после корневого куска склеивается (`/srv/my dir/a.png`),
///    длиннее — неоднозначно с текстом и не разбирается;
///  - без повторов, порядок появления, не больше шести.
///
/// Разбор линейный, без вложенных квантификаторов (ответ приходит от модели, а
/// не от доверенного автора).
public enum PreviewPaths {
    public static let extensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "md", "markdown"]
    public static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]
    public static let limit = 6

    public static func find(in text: String) -> [String] {
        guard text.contains(".") else { return [] }
        var chars = Array(stripURLs(text))
        var hits: [(at: Int, path: String)] = []
        // 1. Промежутки с разделителями: путь с пробелами внутри — весь промежуток.
        //    Принятый закрашивается пробелами, чтобы шаг 2 не прочёл его кусок.
        var i = 0
        while i < chars.count {
            let c = chars[i]
            var close: Character?
            var start = i + 1
            switch c {
            case "`": close = "`"
            case "\"": close = "\""
            case "«": close = "»"
            case "]" where i + 2 < chars.count && chars[i + 1] == "(" && chars[i + 2] == "<":
                close = ">"; start = i + 3
            default: break
            }
            guard let close, start <= chars.count,
                  let end = chars[start...].firstIndex(where: { $0 == close || $0 == "\n" }),
                  chars[end] == close,
                  c != "]" || (end + 1 < chars.count && chars[end + 1] == ")")
            else { i += 1; continue }
            let stop = c == "]" ? end + 1 : end
            let inner = String(chars[start..<end]).trimmingCharacters(in: .whitespaces)
            if inner.contains(" "), let path = spanPath(inner) {
                hits.append((i, path))
                for k in i...stop { chars[k] = " " }
            }
            i = stop + 1
        }
        // 2. Проза: слова, и один пробел после корневого куска.
        let words = tokens(of: chars)
        for (n, w) in words.enumerated() {
            guard var path = candidate(w.text) else { continue }
            var at = w.start
            if !isAbsolute(path), n > 0 {
                let prev = words[n - 1]
                if prev.end == w.start - 1, chars[prev.end] == " ", bridges(prev.text) {
                    path = prev.text + " " + path
                    at = prev.start
                }
            }
            hits.append((at, path))
        }
        var found: [String] = []
        for hit in hits.sorted(by: { $0.at < $1.at }) where !found.contains(hit.path) {
            found.append(hit.path)
            if found.count >= limit { break }
        }
        return found
    }

    /// Картинка, а не markdown. Расширение у найденного пути есть по построению.
    public static func isImage(_ path: String) -> Bool {
        imageExtensions.contains(extensionOf(path))
    }

    public static func isAbsolute(_ path: String) -> Bool {
        path.hasPrefix("/") || isWindowsDrive(path)
    }

    /// Имя файла для подписи: последний компонент по `/` или `\`.
    public static func fileName(_ path: String) -> String {
        let name = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init)
        return name ?? path
    }

    // MARK: - Parsing

    private static func stripURLs(_ text: String) -> String {
        guard text.contains("://"), let re = Re.regex("https?://\\S+", options: [.caseInsensitive]) else { return text }
        return re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: " ")
    }

    /// Символы, на которых слово обрывается: пробелы и всё, что обрамляет путь
    /// в прозе (кавычки, скобки, разметка). `:` и `\` сюда НЕ входят — они
    /// нужны Windows-путям.
    private static let delimiters: Set<Character> = [
        "`", "(", ")", "[", "]", "{", "}", "<", ">", "\"", "'", "«", "»", "“", "”", "„",
        ",", ";", "|", "*", "!", "?", "=", "#",
    ]

    private struct Word { let start: Int; let end: Int; let text: String }

    /// Слова с позициями: `end` — индекс символа сразу за словом.
    private static func tokens(of chars: [Character]) -> [Word] {
        var out: [Word] = []
        var start: Int?
        for (k, ch) in chars.enumerated() {
            let cut = ch.isWhitespace || delimiters.contains(ch)
            if cut, let s = start { out.append(Word(start: s, end: k, text: String(chars[s..<k]))); start = nil }
            if !cut, start == nil { start = k }
        }
        if let s = start { out.append(Word(start: s, end: chars.count, text: String(chars[s...]))) }
        return out
    }

    /// Корневой кусок, к которому стоит приклеить следующий относительный путь:
    /// `/srv/my` в `/srv/my dir/a.png`. Не готовый файл и не конец фразы.
    private static func bridges(_ word: String) -> Bool {
        guard word.hasPrefix("/") || isWindowsDrive(word), let last = word.last,
              !trailing.contains(last), !"!?".contains(last) else { return false }
        let name = fileName(word)
        if let dot = name.lastIndex(of: "."), dot != name.startIndex {
            let ext = name[name.index(after: dot)...]
            if (1...8).contains(ext.count), ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) { return false }
        }
        return true
    }

    /// Весь промежуток — один путь с пробелами? Относительный обязан дойти до
    /// разделителя раньше первого пробела, иначе это фраза, кончающаяся путём.
    private static func spanPath(_ inner: String) -> String? {
        guard inner.count <= 4096, !inner.contains(where: { "<>\"`|*?\n".contains($0) }) else { return nil }
        guard extensions.contains(extensionOf(inner)) else { return nil }
        guard fileName(inner).count > extensionOf(inner).count + 1 else { return nil }
        if isAbsolute(inner) { return inner.hasPrefix("//") ? nil : inner }
        if inner.lowercased().hasPrefix("www.") { return nil }
        guard let sep = inner.firstIndex(where: { $0 == "/" || $0 == "\\" }),
              let space = inner.firstIndex(of: " "), sep < space else { return nil }
        return inner
    }

    private static let trailing: Set<Character> = [".", ",", ";", ":", ")", "»", "\"", "'"]

    private static func candidate(_ token: String) -> String? {
        var s = Substring(token)
        // «Скриншот:/tmp/a.png» без пробела: метка до двоеточия не часть пути.
        // Одна буква перед `:` — диск Windows, его оставляем.
        if let colon = s.firstIndex(of: ":"), colon != s.startIndex {
            let after = s.index(after: colon)
            let label = s[s.startIndex..<colon]
            if after < s.endIndex, s[after] == "/", label.count > 1, !label.contains("/"), !label.contains("\\") {
                s = s[after...]
            }
        }
        while let last = s.last, trailing.contains(last) { s = s.dropLast() }
        while s.first == ":" { s = s.dropFirst() }
        let path = String(s)
        guard path.count <= 4096 else { return nil }
        guard extensions.contains(extensionOf(path)) else { return nil }
        let name = fileName(path)
        // «.png» без имени — не файл.
        guard name.count > extensionOf(path).count + 1 else { return nil }
        if isWindowsDrive(path) { return path }
        if path.hasPrefix("/") { return path.hasPrefix("//") ? nil : path }
        // Относительный путь обязан содержать `/`: голое «readme.md» в прозе — слово, не ссылка.
        // `www.example.com/a/b.png` без схемы — сайт, а не файл.
        if path.lowercased().hasPrefix("www.") { return nil }
        return (path.contains("/") || path.contains("\\")) ? path : nil
    }

    private static func isWindowsDrive(_ path: String) -> Bool {
        let c = Array(path.prefix(3))
        guard c.count == 3, c[0].isASCII, c[0].isLetter, c[1] == ":" else { return false }
        return c[2] == "\\" || c[2] == "/"
    }

    private static func extensionOf(_ path: String) -> String {
        let name = fileName(path)
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return "" }
        return name[name.index(after: dot)...].lowercased()
    }
}
