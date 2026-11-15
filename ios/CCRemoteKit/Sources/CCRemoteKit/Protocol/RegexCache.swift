import Foundation

/// Регулярки, скомпилированные один раз на шаблон.
///
/// `String.range(of:options: .regularExpression)` и `replacingOccurrences(…,
/// .regularExpression)` на каждый вызов собирают `NSRegularExpression` заново, а
/// `StepText` / `WorkActivity` / `CleanTitle` зовут их на каждую строку чата и
/// каждую сессию списка. Шаблоны — литералы кода (число конечно), поэтому кэш
/// ничем не ограничен и не вытесняется. Тот же ICU, те же результаты, что у
/// строковых вариантов: это только место компиляции.
enum Re {
    private final class Store: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [String: NSRegularExpression] = [:]

        func regex(_ pattern: String, _ options: NSRegularExpression.Options) -> NSRegularExpression? {
            let key = "\(options.rawValue)|\(pattern)"
            lock.lock()
            defer { lock.unlock() }
            if let hit = items[key] { return hit }
            guard let made = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
            items[key] = made
            return made
        }
    }

    private static let store = Store()

    static func regex(_ pattern: String, options: NSRegularExpression.Options = []) -> NSRegularExpression? {
        store.regex(pattern, options)
    }

    /// Первое совпадение целиком.
    static func firstMatch(_ pattern: String, in s: String, options: NSRegularExpression.Options = []) -> NSTextCheckingResult? {
        guard let re = regex(pattern, options: options) else { return nil }
        return re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s))
    }

    /// `s.range(of: pattern, options: .regularExpression) != nil`.
    static func test(_ pattern: String, in s: String) -> Bool {
        firstMatch(pattern, in: s) != nil
    }

    /// `s.range(of: pattern, options: .regularExpression)`.
    static func firstRange(_ pattern: String, in s: String) -> Range<String.Index>? {
        guard let m = firstMatch(pattern, in: s) else { return nil }
        return Range(m.range, in: s)
    }

    /// Группа `index` первого совпадения; нет совпадения или группа не участвовала — nil.
    static func group(_ pattern: String, in s: String, at index: Int = 1, options: NSRegularExpression.Options = []) -> String? {
        guard let m = firstMatch(pattern, in: s, options: options) else { return nil }
        let r = m.numberOfRanges > index ? m.range(at: index) : m.range
        guard r.location != NSNotFound, let range = Range(r, in: s) else { return nil }
        return String(s[range])
    }

    /// `s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)`.
    static func replacing(_ pattern: String, in s: String, with template: String) -> String {
        guard let re = regex(pattern) else { return s }
        return re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: template)
    }
}
