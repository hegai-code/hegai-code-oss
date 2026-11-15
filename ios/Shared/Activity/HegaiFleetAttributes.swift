import ActivityKit
import Foundation

/// WATCH.md §5. Compiled into the app (it decodes nothing, but must name the
/// type so the system accepts a push-to-start) and into the widget extension.
/// The field names are the hub's JSON keys; do not rename.
struct HegaiFleetAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        struct Item: Codable, Hashable {
            var title: String
            var state: String
            var sinceMs: Int64
            /// The session's plan («3/7»), when it keeps one. Optional: an
            /// older hub does not send them, and a missing key decodes as nil.
            var planDone: Int?
            var planTotal: Int?
        }
        var working: Int
        var waiting: Int
        var items: [Item]
        var updatedMs: Int64
    }
}
