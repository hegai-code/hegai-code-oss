import Foundation

/// The FALLBACK layer of turn enrichment (web `render/enrich.ts`): a plain
/// Да / Нет pair for a turn that ends with a yes/no question, used ONLY when
/// the hub's model could not answer at all (call failed, no gateway, no AI
/// consent) — see `Enrichment.shown(state:heuristic:)`. It never shows while
/// the model is still thinking and never overrides a model that answered.
/// Deliberately minimal: list items and «A или B» used to become buttons
/// carrying whole paragraphs of the agent's prose, and a tap on one SENT that
/// paragraph (owner's complaint, 13.10.2026). Decisions and digests need
/// understanding; that half belongs to the model.
public enum EnrichHeuristics {
    /// A question that opens with one of these is not a yes/no question, and
    /// generic [Да]/[Нет] under it would read as the UI not listening. A set
    /// over the first word, as on the web — parity with its tests.
    static let openWords: Set<String> = [
        "что", "чем", "как", "какой", "какая", "какое", "какие", "каким", "какую",
        "где", "куда", "откуда", "почему", "зачем", "сколько", "когда", "кто", "кому",
        "which", "what", "how", "where", "why", "when", "who",
    ]

    /// Quick replies for the question a turn ends with, or nil when the turn
    /// does not end with one the rules understand. Feed it CLEAN text
    /// (harness noise + Codex citations stripped) — markers would leak into
    /// button labels.
    public static func enrichment(for text: String) -> Enrichment? {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard let lastLine = lines.last else { return nil }
        // The LAST line must end with the question: one buried mid-turn is one
        // the agent already moved past, and answering it now would answer the
        // wrong thing.
        let last = stripMarks(lastLine).trimmingCharacters(in: .whitespaces)
        guard last.hasSuffix("?"), last.count <= 200 else { return nil }
        // The question is the last sentence of that line.
        let sentence = replacing(lastSentence(of: last), pattern: "\\?+$", with: "")
            .trimmingCharacters(in: .whitespaces)
        guard !sentence.isEmpty else { return nil }

        // An open question has no guessable answers — better no buttons than
        // wrong ones. Anything else reads as yes/no. label == send, always: what
        // the button says is exactly what a tap sends.
        if opensWide(sentence) { return nil }
        return Enrichment(quickReplies: [
            Enrichment.QuickReply(label: "Да", send: "Да"),
            Enrichment.QuickReply(label: "Нет", send: "Нет"),
        ])
    }

    // MARK: Pieces

    static func opensWide(_ sentence: String) -> Bool {
        let first = sentence.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        let letters = String(String.UnicodeScalarView(first.lowercased().unicodeScalars.filter { CharacterSet.letters.contains($0) }))
        return openWords.contains(letters)
    }

    static func stripMarks(_ s: String) -> String {
        replacing(s, pattern: "[*_`]", with: "")
    }

    /// The text after the last sentence break (`(?<=[.!?])\s+`) — the whole
    /// line when there is none.
    static func lastSentence(of line: String) -> String {
        guard let re = try? NSRegularExpression(pattern: "(?<=[.!?])\\s+") else { return line }
        let ns = line as NSString
        let matches = re.matches(in: line, range: NSRange(location: 0, length: ns.length))
        guard let last = matches.last else { return line }
        return ns.substring(from: last.range.location + last.range.length)
    }

    private static func replacing(_ s: String, pattern: String, with template: String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return s }
        let ns = s as NSString
        return re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: ns.length), withTemplate: template)
    }
}
