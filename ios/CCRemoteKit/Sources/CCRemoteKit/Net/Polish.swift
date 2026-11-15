import Foundation

/// Dictation clean-up — `POST /polish` (server-rs/src/polish.rs, wire in
/// shared/src/polish.ts, web f37e688).
///
/// The recognizer writes down sounds: «юз рекордер», «деплой хаб эс эйч». The
/// hub's rewrite turns that into what the person meant to type — misheard
/// terms fixed against the project, punctuation, paragraphs, lists — and the
/// thing that makes it right for THIS person is context: the project and the
/// words the conversation has been using. The raw text is always kept: a
/// failure, a refusal or a slow gateway leaves it in the box untouched.
public struct PolishRequest: Encodable, Equatable, Sendable {
    /// `POLISH_MAX_TEXT` / `polish::MAX_TEXT`.
    public static let maxText = 12_000
    /// `POLISH_MAX_RECENT`.
    public static let maxRecent = 4_000

    public var text: String
    /// Project label (last cwd segment).
    public var project: String?
    /// Session title.
    public var title: String?
    /// The end of the conversation, `role: text` lines — vocabulary only.
    public var recent: String?

    /// Absent, never empty: the wire's optionals are `optional()`, not `''`.
    public init(text: String, project: String? = nil, title: String? = nil, recent: String? = nil) {
        func clip(_ s: String?) -> String? {
            guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
            return String(t.prefix(200))
        }
        self.text = text
        self.project = clip(project)
        self.title = clip(title)
        self.recent = recent.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The same request with nothing derived from the conversation: text and
    /// project label only. For rewrites the person never sees before they go
    /// out («Отправить запись»): `recent` and `title` are conversation content
    /// and must not be able to steer an unseen rewrite.
    public var withoutConversation: PolishRequest { PolishRequest(text: text, project: project) }

    /// Last six turns, oldest first, `role: text` — the END of each long turn,
    /// where the agent says what it did and asks (web `recentForPolish`).
    public static func recent(_ history: [HistoryMessage]) -> String? {
        var lines: [String] = []
        for message in history.reversed() where lines.count < 6 {
            guard message.role == .user || message.role == .assistant else { continue }
            let text = message.blocks.compactMap { block -> String? in
                if case let .text(t) = block { return t }
                return nil
            }
            .joined(separator: " ")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard !text.isEmpty else { continue }
            let cut = text.count > 1_200 ? "…" + text.suffix(1_200) : text
            lines.append("\(message.role.rawValue): \(cut)")
        }
        let out = lines.reversed().joined(separator: "\n")
        guard !out.isEmpty else { return nil }
        return out.count > maxRecent ? String(out.suffix(maxRecent)) : out
    }
}

/// The «как сказал» switch: one dictation, two spellings, and the composer
/// shows one of them (web `DictationPair`).
///
/// Anchored, not searched: the dictation went in right after `prefix` (what was
/// in the box before it), and only THAT occurrence is ever swapped. Searching
/// for the last match instead would rewrite an older copy of the same phrase
/// once the new one was edited away.
public struct DictationPair: Equatable, Sendable {
    public let raw: String
    public let polished: String
    public var showingPolished: Bool
    /// The draft before the dictated text, separator included.
    public let prefix: String

    public init(raw: String, polished: String, showingPolished: Bool = true, prefix: String = "") {
        self.raw = raw
        self.polished = polished
        self.showingPolished = showingPolished
        self.prefix = prefix
    }

    private var shown: String { showingPolished ? polished : raw }

    private func anchored(in draft: String) -> Range<String.Index>? {
        guard draft.hasPrefix(prefix) else { return nil }
        let start = draft.index(draft.startIndex, offsetBy: prefix.count)
        guard draft[start...].hasPrefix(shown) else { return nil }
        return start..<draft.index(start, offsetBy: shown.count)
    }

    /// The other spelling in place of the shown one. Nil: the dictated text is
    /// no longer where it was put (edited or sent) and the switch should go.
    public func swap(in draft: String) -> (draft: String, pair: DictationPair)? {
        guard let at = anchored(in: draft) else { return nil }
        var next = self
        next.showingPolished.toggle()
        return (draft.replacingCharacters(in: at, with: next.shown), next)
    }

    /// Is the switch still about text that is in the box, where it was put?
    public func visible(in draft: String) -> Bool { anchored(in: draft) != nil }
}

/// What `/polish` came to. The composer shows a sign only for `.failed`:
/// `.off` is a hub without the feature (nothing to report) and `.unchanged` is
/// text that needed no rewrite.
public enum PolishOutcome: Equatable, Sendable {
    case polished(String)
    case unchanged
    case failed
    case off

    /// (HTTP status, body) → outcome. Pure, so the mapping is testable without
    /// a network. A nil status is a transport failure or timeout.
    public static func map(status: Int?, body: Data?, raw: String) -> PolishOutcome {
        guard let status else { return .failed }
        if status == 503 { return .off }
        struct Answer: Decodable { let text: String; let polished: Bool }
        guard status == 200, let body,
              let answer = try? JSONDecoder().decode(Answer.self, from: body),
              answer.polished,
              !answer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .failed }
        return answer.text == raw ? .unchanged : .polished(answer.text)
    }
}

extension RestClient {
    /// The rewrite's outcome. Eight seconds: the raw text is already in hand,
    /// and a rewrite slower than that costs more than it gives.
    public func polish(_ request: PolishRequest) async -> PolishOutcome {
        guard !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .unchanged }
        guard request.text.count <= PolishRequest.maxText,
              let base, !token.isEmpty,
              var comps = URLComponents(url: base.appendingPathComponent("polish"), resolvingAgainstBaseURL: false)
        else { return .failed }
        // `/polish` authenticates like `/ui`: the session token rides the query.
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = comps.url, let body = try? JSONEncoder().encode(request) else { return .failed }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 8
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let status = (response as? HTTPURLResponse)?.statusCode else {
            return PolishOutcome.map(status: nil, body: nil, raw: request.text)
        }
        return PolishOutcome.map(status: status, body: data, raw: request.text)
    }
}
