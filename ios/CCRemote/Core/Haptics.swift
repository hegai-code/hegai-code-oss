#if canImport(UIKit)
import UIKit
#endif

/// Thin wrapper over UIFeedbackGenerator so call sites read intent, not API.
///
/// The macOS build keeps the same five calls as no-ops. That is deliberate: 54
/// call sites across 23 files say `Haptics.light()`, and a Mac has nothing to
/// vibrate. Silencing them here costs one file; `#if os(iOS)` at every call site
/// would cost 54 edits and leave the next person guessing which ones matter.
/// (Trackpads do expose `NSHapticFeedbackManager`, but it fires only for
/// alignment-style feedback during a drag — not for taps and confirmations.)
enum Haptics {
    #if canImport(UIKit)
    static func light() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func rigid() { UIImpactFeedbackGenerator(style: .rigid).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    #else
    static func light() {}
    static func rigid() {}
    static func success() {}
    static func warning() {}
    static func error() {}
    #endif
}
