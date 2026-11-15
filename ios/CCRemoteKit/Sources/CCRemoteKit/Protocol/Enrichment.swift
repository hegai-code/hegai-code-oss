import Foundation

/// Turn enrichment (web `EnrichmentSchema`): the takeaways under a transcript's
/// tail turn and one-tap answers to the question it ends with. Every field is
/// optional — an empty enrichment is a valid answer, "nothing to add".
public struct Enrichment: Codable, Hashable, Sendable {
    public struct QuickReply: Codable, Hashable, Sendable {
        public let label: String
        public let send: String
        /// What a tap means (web `kind`): `answer` / `next` go out as a message,
        /// `idea` is a thought for the composer, not an instruction. A String,
        /// not an enum, for the same reason as `handoff`: a value this build
        /// does not know must not fail the decode. Absent from older hubs and
        /// from the heuristics — both read as "send it".
        public let kind: String?
        public init(label: String, send: String, kind: String? = nil) {
            self.label = label
            self.send = send
            self.kind = kind
        }

        public var isIdea: Bool { kind == "idea" }
    }

    public var sessionTitle: String?
    /// Why the agent stopped, as the hub's model judged it: `done`, `question`
    /// or `blocked` (web `EnrichmentSchema.handoff`, 10.10.2026). A String, not
    /// an enum: a value this build does not know must not fail the decode of
    /// the whole enrichment — `headline` simply has nothing to say about it.
    public var handoff: String?
    public var decisions: [String]?
    public var digest: String?
    public var quickReplies: [QuickReply]?

    public init(decisions: [String]? = nil, digest: String? = nil, quickReplies: [QuickReply]? = nil,
                handoff: String? = nil) {
        self.handoff = handoff
        self.decisions = decisions
        self.digest = digest
        self.quickReplies = quickReplies
    }

    public var isEmpty: Bool {
        (decisions?.isEmpty ?? true) && (digest?.isEmpty ?? true) && (quickReplies?.isEmpty ?? true)
    }

    /// The one line above the buttons (web `HANDOFF_HEAD`): is the agent done,
    /// or waiting on you? Buttons alone did not say. Nil for an unknown or
    /// absent verdict — no line rather than a guessed one.
    public var headline: String? {
        switch handoff {
        case "done": return "Готово. Дальше — по желанию:"
        case "question": return "Ждёт твоего ответа:"
        case "blocked": return "Без тебя не продолжит:"
        default: return nil
        }
    }

    /// The most buttons the strip ever shows.
    public static let maxReplies = 3
    /// A `send` longer than this is not what the hub emits (it drops anything
    /// over 60 UTF-16 units, the web's zod cap): an old or misbehaving hub. A
    /// tap would send text the button was never sized for. Dropped, not clipped.
    public static let maxSendLength = 60

    /// What the strip shows for one turn, given the state of the model's pass.
    ///
    /// The model's verdict is FINAL when it exists, including an empty one: it
    /// sees the whole turn and says so when the agent stopped mid-work or
    /// nothing is worth a tap, and putting Да/Нет back under that verdict was
    /// the noise this layer used to add. So:
    ///  - `pending`: nothing — the heuristic must not flash before the model
    ///    answers and then be replaced under the reader's thumb;
    ///  - `success`: the model's replies only (nothing on an empty answer);
    ///  - `failed` / `unavailable` (no gateway, or no AI consent): the
    ///    heuristic, the only voice left.
    /// `allowIdeas: false` for a screen without a composer (the mirror): an idea
    /// has nowhere to land there.
    public static func shown(state: EnrichState, heuristic: Enrichment?, allowIdeas: Bool = true) -> Enrichment? {
        let source: Enrichment?
        switch state {
        case .pending: return nil
        case .success(let model): source = model
        case .failed, .unavailable: source = heuristic
        }
        guard let source else { return nil }
        // The button shows `send`, so `label` is pinned to it: whatever the hub
        // put in `label`, the person sees exactly what a tap will say.
        var seen = Set<String>()
        let replies = (source.quickReplies ?? []).compactMap { r -> QuickReply? in
            let text = r.send.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, text.utf16.count <= maxSendLength, allowIdeas || !r.isIdea,
                  seen.insert(text).inserted else { return nil }
            return QuickReply(label: text, send: text, kind: r.kind)
        }.prefix(maxReplies)
        guard !replies.isEmpty else { return nil }
        var out = Enrichment(quickReplies: Array(replies))
        // The verdict describes the model's buttons; over heuristic ones it
        // would be a claim about buttons the model never proposed.
        if case .success = state { out.handoff = source.handoff }
        return out
    }
}

/// Where the model's pass for one tail turn stands. Explicit, because "no
/// answer" used to mean four different things at once (not asked yet, asked
/// and said nothing, asked and failed, cannot ask) and the heuristic fallback
/// rode on all of them.
public enum EnrichState: Equatable, Sendable {
    /// Not asked, or asked and not answered yet.
    case pending
    /// The model answered; the enrichment may be empty ("nothing worth a tap").
    case success(Enrichment)
    /// Asked and failed: busy hub, dropped socket, timeout, any other error.
    case failed
    /// Cannot be asked: the hub has no gateway ("enrichment not configured"),
    /// or the person has not agreed to AI data sharing.
    case unavailable
}
