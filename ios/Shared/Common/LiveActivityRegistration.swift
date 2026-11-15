import Foundation

/// Body of `POST /api/push/live-activity` (WATCH.md §5).
struct LiveActivityRegistration: Encodable, Equatable {
    var kind: String
    var token: String?
    var activityId: String?
    var tokens: [String]?

    static func start(token: Data) -> Self { .init(kind: "start", token: hex(token), activityId: nil, tokens: nil) }
    static func activity(id: String, token: Data) -> Self { .init(kind: "activity", token: hex(token), activityId: id, tokens: nil) }
    static func ended(id: String) -> Self { .init(kind: "ended", token: nil, activityId: id, tokens: nil) }
    /// The app is in the foreground and has no card: whatever start the hub was
    /// waiting on will never answer (WATCH.md §5).
    static var noCards: Self { ended(id: "no-cards") }

    /// Sent before the app clears its session: the hub drops these tokens for every user.
    static func signout(tokens: [String]) -> Self { .init(kind: "signout", token: nil, activityId: nil, tokens: tokens) }

    /// Lowercase hex, as the hub expects.
    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
