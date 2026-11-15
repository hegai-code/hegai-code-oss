import Foundation

/// Session titles come straight from the first transcript line, which is often
/// CLI-injected context ("# Files mentioned by the user: ## …", `<image …>`
/// pseudo-tags). Flatten to a plain one-line label for chrome. Port of
/// `cleanTitle` in `web/src/lib.ts`, applied centrally when frames arrive.
///
/// It lives beside the protocol rather than in the design system because the
/// socket applies it at ingest — a title is already clean by the time any view
/// sees it, and a UI-layer home would mean the package could not compile.
public func cleanTitle(_ t: String?) -> String {
    guard let t, !t.isEmpty else { return "" }
    var s = t
    for (pattern, replacement) in cleanTitleRules {
        s = Re.replacing(pattern, in: s, with: replacement)
    }
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Четыре правила одним набором: шаблоны компилируются при первом вызове
/// (`Re`), а не заново на каждый заголовок каждого кадра инвентаря.
private let cleanTitleRules: [(String, String)] = [
    ("<[^<>\n]{0,200}>", " "),        // <image name=… path=…> pseudo-tags
    ("(^|\\s)#{1,6}(?=\\s|$)", " "),  // markdown heading markers
    ("[*`~]+|_{2,}", " "),            // emphasis fences (single _ kept: snake_case)
    ("\\s+", " "),
]
