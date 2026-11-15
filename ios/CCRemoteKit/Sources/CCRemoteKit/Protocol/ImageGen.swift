import Foundation

/// One picture being drawn, as the live `image_gen` status events describe it
/// (`ImageGenEventData` in shared/src/rpc.ts). One `id` per picture: `started`
/// first, then exactly one of `done` (with a `ref` for `session.image`) or
/// `failed`. No percentage exists upstream; a progress bar is the client's own
/// clock from `startedAt`.
public struct ImageGenCard: Equatable, Sendable {
    public enum State: String, Sendable { case started, done, failed }

    public let id: String
    public var state: State
    /// Epoch ms the generation began, from the agent. Absent = `firstSeen`.
    public var startedAt: Double?
    /// Epoch ms this client first saw the card; the bar's fallback origin.
    public let firstSeen: Double
    public var prompt: String?
    public var ref: String?
    public var error: String?

    public init(id: String, state: State, startedAt: Double? = nil, firstSeen: Double,
                prompt: String? = nil, ref: String? = nil, error: String? = nil) {
        self.id = id
        self.state = state
        self.startedAt = startedAt
        self.firstSeen = firstSeen
        self.prompt = prompt
        self.ref = ref
        self.error = error
    }

    /// The bar's origin: the agent's clock when it sent one, else our own.
    public var origin: Double { startedAt ?? firstSeen }

    /// Fill 0...0.92 from elapsed seconds: `0.92 * (1 - exp(-t / 28))`. It never
    /// reaches the end on its own — only `done` completes the picture.
    public static func progress(elapsed seconds: Double) -> Double {
        0.92 * (1 - exp(-max(0, seconds) / 28))
    }

    /// «m:ss» for the label.
    public static func clock(elapsed seconds: Double) -> String {
        let s = Int(max(0, seconds))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    /// Does a history `image` ref belong to this card? Codex refs are
    /// `gen:<id>`; a Claude `hegai-image` Bash call yields `gen:<toolUseId>#<n>`.
    public func matches(historyRef candidate: String) -> Bool {
        if let ref, ref == candidate { return true }
        let own = "gen:" + id
        return candidate == own || candidate.hasPrefix(own + "#")
    }
}
