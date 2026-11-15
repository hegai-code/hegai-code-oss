import Foundation

/// A short "keep me alive" assertion the socket takes around a send.
///
/// This exists because the need is real on exactly one platform. iOS suspends an
/// app between the moment `send` is called and the moment the frame reaches the
/// wire, so `CentralClient` buys a few seconds of grace around a send, around the
/// `pause` frame, and around a push-triggered approval. An AppKit app is never
/// suspended that way, so the macOS shell keeps the no-op default and the whole
/// mechanism costs nothing.
///
/// The alternative — `#if os(iOS)` around six call sites inside the socket — puts
/// platform knowledge in the one file that most needs to stay portable.
public protocol BackgroundGrace: Sendable {
    /// A token to hand back to `end`, or nil when the host grants nothing.
    func begin(_ name: String) -> Int?
    func end(_ token: Int)
}

/// The default: hosts that never suspend the app grant nothing and end nothing.
public struct NoBackgroundGrace: BackgroundGrace {
    public init() {}
    public func begin(_ name: String) -> Int? { nil }
    public func end(_ token: Int) {}
}
