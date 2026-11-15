import Foundation
import os

/// On-disk copy of every transcript the phone has ever read.
///
/// Opening a session used to mean an RPC round trip to the machine that owns it —
/// through the hub, through the agent, off a file on the far end — before a single
/// word appeared. The cache turns that into a disk read: the conversation is on
/// screen immediately and the network only supplies what changed since.
///
/// An actor, so decoding a multi-megabyte transcript never lands on the main
/// thread. The payload is stored exactly as the agent sent it and decoded through
/// the same path as a live reply, which is what keeps this honest: there is no
/// second representation of a message to drift out of sync.
public actor TranscriptCache {
    /// A transcript we refuse to keep. The RPC already caps at 2000 messages, but
    /// a pathological session can still be enormous, and filling the user's phone
    /// to make one chat open faster is a bad trade.
    private static let maxBytes = 32 * 1024 * 1024

    /// Format version of the stored payload, baked into the index file name.
    /// Bump it whenever a field is ADDED to what `HistoryMessage` reads: the
    /// files are verbatim agent replies, so an older build's copy simply lacks
    /// the field — and `hasFreshCache` would keep serving it for as long as the
    /// session's mtime stands still. A fresh index means every session is
    /// refetched exactly once, silently, on the next open. (v2: `ts`.)
    // v3 invalidates fragments previously marked fresh by the 4 MB agent tail.
    private static let formatVersion = 3

    private let dir: URL
    /// key → the session `lastModified` this copy was read at. Held in memory so
    /// "is my copy current?" costs nothing; persisted so it survives a restart.
    private var index: [String: Double] = [:]
    private let indexURL: URL
    private var indexDirty = false
    private var retired = false
    private let log = Logger(subsystem: "net.hegai.ccremote", category: "cache")

    public init(directory: URL? = nil) {
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("Transcripts", isDirectory: true)
        indexURL = dir.appendingPathComponent("index.v\(Self.formatVersion).json")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // The previous format's index is dead weight once superseded.
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("index.json"))
        if let data = try? Data(contentsOf: indexURL),
           let loaded = try? JSONDecoder().decode([String: Double].self, from: data) {
            index = loaded
        }
    }

    public static func key(machineId: String, sessionId: String) -> String {
        // Session ids are uuids and machine ids are opaque; both are already safe
        // as filenames, but a stray separator would silently collide two sessions.
        "\(machineId)__\(sessionId)".replacingOccurrences(of: "/", with: "_")
    }

    /// The `lastModified` our copy corresponds to, if we have one.
    public func cachedAt(_ key: String) -> Double? { index[key] }

    /// Decoded messages, or nil when nothing is stored (or the file is unreadable,
    /// in which case it is dropped so the next fetch replaces it cleanly).
    public func read(_ key: String) -> [HistoryMessage]? {
        let url = dir.appendingPathComponent("\(key).json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let result = try? JSONDecoder().decode(SessionMessagesResult.self, from: data) else {
            try? FileManager.default.removeItem(at: url)
            index[key] = nil
            indexDirty = true
            return nil
        }
        return result.messages
    }

    /// Store the agent's reply verbatim. `lastModified` is the session mtime the
    /// reply corresponds to — the whole basis for deciding staleness later.
    public func write(_ key: String, payload: JSONValue, lastModified: Double) {
        guard !retired else { return }
        guard let data = try? JSONEncoder().encode(payload) else { return }
        guard data.count <= Self.maxBytes else {
            log.info("transcript too large to cache (\(data.count) bytes), streaming only")
            return
        }
        do {
            try data.write(to: dir.appendingPathComponent("\(key).json"), options: .atomic)
            index[key] = lastModified
            indexDirty = true
        } catch {
            log.warning("cache write failed: \(error.localizedDescription)")
        }
    }

    /// Persist the index. Called after a prefetch pass rather than per file — the
    /// files themselves are the durable part; the index is a convenience.
    public func flush() {
        guard !retired else { return }
        guard indexDirty, let data = try? JSONEncoder().encode(index) else { return }
        do {
            try data.write(to: indexURL, options: .atomic)
            indexDirty = false
        } catch { log.warning("cache index write failed: \(error.localizedDescription)") }
    }

    /// How much of the phone this is using, for Settings.
    public func stats() -> (sessions: Int, bytes: Int64) {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        var bytes: Int64 = 0
        for f in files {
            bytes += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return (index.count, bytes)
    }

    /// Forget every copy of one machine's sessions (it became private, or a key was
    /// paired: what is on disk predates the key and must not outlive it).
    public func purge(machineId: String) {
        let prefix = "\(machineId)__".replacingOccurrences(of: "/", with: "_")
        for key in index.keys where key.hasPrefix(prefix) { index[key] = nil }
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for f in files where f.lastPathComponent.hasPrefix(prefix) && f.pathExtension == "json" {
            try? FileManager.default.removeItem(at: f)
        }
        indexDirty = true
        flush()
    }

    public func retire() { retired = true; index = [:]; indexDirty = false }

    public func clear() {
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        index = [:]
        indexDirty = true
        flush()
    }
}
