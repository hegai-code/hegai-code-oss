import Foundation
import Observation
import CCRemoteKit

/// The displayed history has one owner even when focus, reconnect, load-earlier
/// and end-of-turn convergence all ask for it. Each new read invalidates older
/// completions; a failed/cancelled read never blanks what is already on screen.
@MainActor
@Observable
final class SessionHistory {
    private(set) var messages: [HistoryMessage] = []
    /// What is shown came from the hub's OLD copy (`HistoryPage.stale`). Such
    /// a page is shown only when there is nothing better and never counts as
    /// "the file caught up" — its last question/answer pair is an old one.
    private(set) var stale = false
    /// The last read answered with the hub's old copy, whether or not it was
    /// shown. What is on screen may be an older CACHE the stale page could not
    /// beat — and that page confirms nothing either, so live lines must stay.
    private(set) var lastReadStale = false
    /// A fresh cache or successful non-stale read, never merely visible history.
    private(set) var confirmedCurrent = false
    /// The session's `lastModified` when what is shown was last confirmed
    /// current. A history kept on the shelf (`SessionHistoryShelf`) is still
    /// current when the session has not moved since: reopening it then needs
    /// neither the disk cache nor the hub.
    private var confirmedMtime: Double?
    private(set) var loading = false
    /// The read failed twice (one silent retry) and there is nothing on screen.
    /// The view offers «Повторить» instead of an empty page: 16.10.2026 a
    /// starved agent missed every deadline and fresh sessions opened blank,
    /// with no error and no way to ask again short of leaving the session.
    private(set) var failed = false
    private(set) var loadingEarlier = false
    private(set) var window = defaultTail
    private var identity = ""
    private var generation = 0
    private var focusRead: UUID?
    private var focusReadSawTurnStart = false
    private var loadedWindow = defaultTail

    // The session.messages contract: default tail 1000, maximum 2000. There is
    // no offset/cursor in the wire API. Do not offer an endless "earlier" action
    // once the server's maximum is reached.
    static let defaultTail = 1000
    static let maximumTail = 2000
    var canLoadEarlier: Bool { window < Self.maximumTail && messages.count >= window }
    var limit: Int? { window == Self.defaultTail ? nil : window }
    var isFocusReading: Bool { focusRead != nil }

    func select(_ identity: String) {
        guard self.identity != identity else { return }
        cancel()
        self.identity = identity
        messages = []
        stale = false
        lastReadStale = false
        failed = false
        confirmedMtime = nil
        window = Self.defaultTail
        loadedWindow = Self.defaultTail
    }

    /// Attaching to an already-working run changes busy while this first read
    /// is awaiting the disk cache. Preserve that base transcript; idle convergence
    /// will fetch the new turn. Leaving or changing identity still cancels it.
    func beginFocusRead() -> UUID {
        let token = UUID()
        let inheritedTurnStart = focusRead != nil && focusReadSawTurnStart
        focusRead = token
        focusReadSawTurnStart = inheritedTurnStart
        return token
    }

    /// Whether this read may supersede live lines. An earlier completed turn
    /// is not proof that a turn begun during this read has reached the file.
    @discardableResult
    func endFocusRead(_ token: UUID) -> Bool {
        guard focusRead == token else { return false }
        let mayClearLines = !focusReadSawTurnStart
        focusRead = nil
        return mayClearLines
    }

    func cancelForTurnStart() {
        guard focusRead == nil else {
            focusReadSawTurnStart = true
            return
        }
        cancel()
    }

    func cancel() {
        focusRead = nil
        generation += 1
        confirmedCurrent = false
        loading = false
        loadingEarlier = false
        window = loadedWindow
    }

    func load(preservingConfirmedTail: Bool = false, mtime: Double? = nil, cached: () async -> [HistoryMessage]?,
              isFresh: () async -> Bool,
              read: (Int?) async throws -> [HistoryMessage],
              retryPause: () async throws -> Void = { try await Task.sleep(for: .milliseconds(1500)) }) async {
        await load(preservingConfirmedTail: preservingConfirmedTail, mtime: mtime, cached: cached,
                   isFresh: isFresh, readPage: { try await HistoryPage(messages: read($0)) },
                   retryPause: retryPause)
    }

    /// `mtime` is the session's `lastModified` as the caller sees it now; what
    /// is confirmed by this load is remembered against it.
    func load(preservingConfirmedTail: Bool = false, mtime: Double? = nil, cached: () async -> [HistoryMessage]?,
              isFresh: () async -> Bool,
              readPage read: (Int?) async throws -> HistoryPage,
              retryPause: () async throws -> Void = { try await Task.sleep(for: .milliseconds(1500)) }) async {
        // Kept from an earlier visit and the session has not moved since.
        if !preservingConfirmedTail, limit == nil, !messages.isEmpty, !stale,
           let mtime, confirmedMtime == mtime {
            generation += 1
            failed = false
            lastReadStale = false
            confirmedCurrent = true
            return
        }
        generation += 1
        // Loading older messages keeps the same tail on screen if the read
        // fails. A reconnect/refresh must confirm it again, even with an
        // expanded window; a non-nil limit alone cannot distinguish those.
        confirmedCurrent = preservingConfirmedTail && confirmedCurrent
        let ticket = generation
        let requestedLimit = limit
        defer {
            if generation == ticket {
                loading = false; loadingEarlier = false
                window = loadedWindow
            }
        }
        if messages.isEmpty, requestedLimit == nil, let copy = await cached(), !copy.isEmpty {
            guard accepts(ticket) else { return }
            messages = copy
            let fresh = await isFresh()
            guard accepts(ticket) else { return }
            if fresh { lastReadStale = false; stale = false; confirmedCurrent = true; confirmedMtime = mtime; return }
        } else if !messages.isEmpty, requestedLimit == nil, mtime != nil, await isFresh(),
                  accepts(ticket), let copy = await cached(), !copy.isEmpty {
            // The kept copy is behind, but the background prefetch already
            // stored the current file on disk.
            guard accepts(ticket) else { return }
            messages = copy
            lastReadStale = false; stale = false; confirmedCurrent = true; confirmedMtime = mtime
            return
        }
        guard accepts(ticket) else { return }
        loading = messages.isEmpty
        failed = false
        var page: HistoryPage?
        for attempt in 0..<2 {
            do {
                page = try await read(requestedLimit)
                break
            } catch {
                guard accepts(ticket) else { return }
                // A transcript already on screen stays; nothing to report.
                guard messages.isEmpty else { return }
                if attempt == 1 { failed = true; return }
                do { try await retryPause() } catch { return }
                guard accepts(ticket) else { return }
            }
        }
        guard let page, accepts(ticket) else { return }
        lastReadStale = page.stale
        // The hub's old copy beats a blank screen, not a transcript already shown.
        if page.stale, !messages.isEmpty, page.messages.count <= messages.count { return }
        messages = page.messages
        stale = page.stale
        confirmedCurrent = !page.stale
        confirmedMtime = page.stale || requestedLimit != nil ? nil : mtime
        loadedWindow = requestedLimit ?? Self.defaultTail
    }

    func expand() -> Bool {
        guard !loadingEarlier, canLoadEarlier else { return false }
        loadingEarlier = true
        window = min(Self.maximumTail, window + Self.defaultTail)
        return true
    }

    /// Returns true only when the current read contains a completed assistant
    /// response. The caller additionally checks focus and busy state before
    /// dropping live lines. An expanded history remains expanded after a turn.
    func converge(read: (Int?) async throws -> [HistoryMessage],
                  pause: () async throws -> Void = { try await Task.sleep(for: .milliseconds(400)) }) async -> Bool {
        await converge(readPage: { try await HistoryPage(messages: read($0)) }, pause: pause)
    }

    /// Convergence polls a SMALL tail (`probeTail` turns) while the saved file
    /// catches up with a run that just ended, and reads the whole window once,
    /// when the tail shows the answer. It used to re-read the whole window (up to
    /// 1-2k messages, megabytes) up to six times 400 ms apart. A limited reply is
    /// a fragment: the caller never caches it and it never replaces what is on
    /// screen — only a full, non-stale, caught-up read does. If no probe ever
    /// shows the answer, the old last attempt (one full read) still runs.
    static let probeTail = 40
    private static let convergeProbes = 6

    func converge(readPage read: (Int?) async throws -> HistoryPage,
                  pause: () async throws -> Void = { try await Task.sleep(for: .milliseconds(400)) }) async -> Bool {
        generation += 1
        confirmedCurrent = false
        let ticket = generation
        let requestedLimit = limit
        defer {
            if generation == ticket {
                loading = false; loadingEarlier = false
                window = loadedWindow
            }
        }
        let probe = min(Self.probeTail, requestedLimit ?? Self.defaultTail)
        var anyRead = false

        func commit(_ fresh: [HistoryMessage]) {
            messages = fresh
            stale = false
            confirmedCurrent = true
            loadedWindow = requestedLimit ?? Self.defaultTail
        }

        for attempt in 0..<Self.convergeProbes {
            guard accepts(ticket) else { return false }
            if let tail = try? await read(probe) {
                guard accepts(ticket) else { return false }
                anyRead = true
                failed = false
                lastReadStale = tail.stale
                // A stale page's last pair is an OLD one: accepting it as
                // caught up dropped the live answer off the screen and left
                // the old copy in its place (26.09.2026). Keep polling; the
                // live lines stay if the file never answers.
                if !tail.stale, Self.caughtUp(tail.messages) {
                    // The file has the answer: one full read puts the whole
                    // window on screen, and it must prove the same itself.
                    if let page = try? await read(requestedLimit) {
                        guard accepts(ticket) else { return false }
                        lastReadStale = page.stale
                        if !page.stale, Self.caughtUp(page.messages) {
                            commit(page.messages)
                            return true
                        }
                    }
                }
            }
            guard accepts(ticket) else { return false }
            if attempt == Self.convergeProbes - 1 { break }
            do { try await pause() } catch { return false }
        }

        // No probe showed the answer: the last resort of the old loop — one full
        // read, kept on screen when it is the best we have.
        guard accepts(ticket) else { return false }
        if let page = try? await read(requestedLimit) {
            guard accepts(ticket) else { return false }
            anyRead = true
            failed = false
            lastReadStale = page.stale
            let fresh = page.messages
            if !page.stale, Self.caughtUp(fresh) {
                commit(fresh)
                return true
            }
            if !fresh.isEmpty, !page.stale || messages.isEmpty {
                messages = fresh
                stale = page.stale
                loadedWindow = requestedLimit ?? Self.defaultTail
            }
        }
        guard accepts(ticket) else { return false }
        // Nothing ever answered and there is nothing to show: the same blank page
        // `load` reports — say so instead.
        if !anyRead, messages.isEmpty { failed = true }
        return false
    }

    static func caughtUp(_ messages: [HistoryMessage]) -> Bool {
        guard let lastUser = messages.lastIndex(where: { $0.role == .user }) else {
            return messages.contains { $0.role == .assistant }
        }
        return messages[(lastUser + 1)...].contains { $0.role == .assistant }
    }

    private func accepts(_ ticket: Int) -> Bool { generation == ticket && !Task.isCancelled }
}

/// The histories of the last few sessions opened, kept across leaving a session
/// and coming back. The screen used to own its history, so every reopen started
/// from nothing: the disk cache, then the replay, then a fresh read, each one a
/// whole new transcript — the work card's step count jumped between them and
/// the chat rebuilt three times (24.10.2026). A kept history is on screen at
/// once, and a read that follows only replaces it with what changed.
/// Identities carry the account's storage scope; another account's are dropped
/// the moment one of this account's is made.
@MainActor
final class SessionHistoryShelf {
    static let shared = SessionHistoryShelf()
    static let capacity = 6

    private var items: [String: SessionHistory] = [:]
    /// Least recently used first.
    private var order: [String] = []

    func history(for identity: String) -> SessionHistory {
        if let kept = items[identity] {
            if order.last != identity, let at = order.firstIndex(of: identity) {
                order.remove(at: at)
                order.append(identity)
            }
            return kept
        }
        let scope = Self.scope(of: identity)
        for other in order where Self.scope(of: other) != scope { items[other] = nil }
        order.removeAll { items[$0] == nil }
        let made = SessionHistory()
        made.select(identity)
        items[identity] = made
        order.append(identity)
        while order.count > Self.capacity { items[order.removeFirst()] = nil }
        return made
    }

    func forget(_ identity: String) {
        items[identity] = nil
        order.removeAll { $0 == identity }
    }

    /// The kept history of `identity`, without making one or reordering.
    func kept(_ identity: String) -> SessionHistory? { items[identity] }

    func removeAll() {
        items.removeAll()
        order.removeAll()
    }

    /// `storageScope::machineId::sessionId` — see `SessionDetailBody.onFocus`.
    private static func scope(of identity: String) -> Substring {
        identity.range(of: "::", options: .backwards)
            .flatMap { identity[..<$0.lowerBound].range(of: "::", options: .backwards) }
            .map { identity[..<$0.lowerBound] } ?? Substring(identity)
    }
}
