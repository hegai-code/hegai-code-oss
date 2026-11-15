import Foundation
import Observation

/// Account-scoped navigation labels, separate from CLI-owned transcript titles.
/// A generated title never renames a transcript or overrides a manual name.
@MainActor @Observable public final class NavigationTitles {
    struct Entry: Codable {
        var raw: String
        var title: String
        var fingerprint: String
        var checked: Date
        var manual: Bool
    }
    /// «This session has no title to generate (yet)»: the opening is not an answered
    /// first prompt, the model said nothing usable, the hub has no gateway. Without
    /// it every visible drawer row without a title repeated a head RPC and an LLM
    /// request each minute. Valid while the session is unchanged (`mtime`) and for
    /// `declineTTL` at most; a session that moved is asked again.
    struct Decline: Codable {
        var mtime: Double
        var at: Date
    }
    static let declineTTL: TimeInterval = 12 * 3600
    private var entries: [String: Entry] = [:]
    @ObservationIgnored private var declined: [String: Decline] = [:]
    @ObservationIgnored private let declinedFile: URL?
    @ObservationIgnored private let file: URL?
    @ObservationIgnored private var generating = false
    @ObservationIgnored private var attempted: [String: Date] = [:]

    public init(directory: URL? = nil) {
        file = directory?.appendingPathComponent("NavigationTitles.v1.json")
        declinedFile = directory?.appendingPathComponent("NavigationTitleMisses.v1.json")
        if let file, let data = try? Data(contentsOf: file),
           let saved = try? JSONDecoder().decode([String: Entry].self, from: data) { entries = saved }
        if let declinedFile, let data = try? Data(contentsOf: declinedFile),
           let saved = try? JSONDecoder().decode([String: Decline].self, from: data) {
            let now = Date()
            declined = saved.filter { now.timeIntervalSince($0.value.at) < Self.declineTTL }
        }
    }

    private func isDeclined(_ id: String, mtime: Double) -> Bool {
        guard let d = declined[id] else { return false }
        return d.mtime == mtime && Date().timeIntervalSince(d.at) < Self.declineTTL
    }

    private func decline(_ id: String, mtime: Double) {
        declined[id] = Decline(mtime: mtime, at: Date())
        guard let declinedFile, let data = try? JSONEncoder().encode(declined) else { return }
        try? FileManager.default.createDirectory(at: declinedFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: declinedFile, options: .atomic)
    }

    func hasDeclined(machineId: String, session: SessionSummary) -> Bool {
        isDeclined(key(machineId, session), mtime: session.lastModified)
    }

    private func key(_ machine: String, _ session: SessionSummary) -> String {
        ClientStorage.digest([machine, session.source ?? "claude", session.sessionId])
    }

    public func label(machineId: String, session: SessionSummary) -> String {
        if let saved = entries[key(machineId, session)], saved.raw == session.title {
            return saved.title
        }
        return compactSessionName(title: session.title, project: session.project,
                                  cwd: session.cwd, sessionId: session.sessionId)
    }

    public func renamed(machineId: String, sessionId: String, source: String?, title: String) {
        let id = ClientStorage.digest([machineId, source ?? "claude", sessionId])
        entries[id] = Entry(raw: title, title: title, fingerprint: "", checked: Date(), manual: true)
        persist()
    }

    /// Serial, debounced and outside layout/gestures. Read only visible sessions;
    /// reuse the transcript cache, never pre-load every project to name a menu.
    public func prepare(client: CentralClient, machineId: String, session: SessionSummary) async {
        // Generating a name sends the conversation to a model: never for a private machine.
        guard !client.isPrivateMachine(machineId) else { return }
        let id = key(machineId, session)
        // A name is the conversation's stable address, not a running summary.
        // Existing v1 entries are already final, including ones older than five minutes.
        guard entries[id] == nil else { return }
        let mtime = session.lastModified
        guard !isDeclined(id, mtime: mtime) else { return }
        if let at = attempted[id], Date().timeIntervalSince(at) < 60 { return }
        let scope = client.storageScope
        do {
            try await Task.sleep(for: .milliseconds(900))
            while generating { try await Task.sleep(for: .milliseconds(250)) }
            try Task.checkCancellation()
            guard client.storageScope == scope, client.status == .open, let cwd = session.cwd else { return }
            guard entries[id] == nil, !isDeclined(id, mtime: mtime) else { return }
            if let at = attempted[id], Date().timeIntervalSince(at) < 60 { return }
            // No AI consent: nothing to ask and nothing learned — not a verdict.
            guard client.aiAllowed else { return }
            generating = true
            defer { generating = false }
            attempted[id] = Date()
            var history = await client.cachedMessages(machineId: machineId, sessionId: session.sessionId)
            // The hub's old copy proves nothing about THIS version of the session.
            // A stored copy older than this mtime is no verdict either: the
            // answer that makes a title possible may be newer than the cache.
            var oldCopy = false
            if history != nil,
               !(await client.hasFreshCache(machineId: machineId, sessionId: session.sessionId, lastModified: mtime)) {
                oldCopy = true
            }
            if history == nil {
                let page = try await client.sessionMessagesPage(machineId: machineId, cwd: cwd,
                    sessionId: session.sessionId, source: session.source, lastModified: session.lastModified)
                history = page.messages
                oldCopy = page.stale
            }
            try Task.checkCancellation()
            guard scope == client.storageScope, var history else { return }
            if Self.context(rawTitle: session.title, history: history) == nil {
                var params: [String: JSONValue] = ["cwd": .string(cwd), "sessionId": .string(session.sessionId),
                    "head": .bool(true), "limit": .number(40), "toolChars": .number(0)]
                if let source = session.source { params["source"] = .string(source) }
                if let raw = try? await client.rpc(machineId: machineId, method: "session.messages", params: .object(params)),
                   let opening = try? await raw.decodeOffMain(as: SessionMessagesResult.self) {
                    history = opening.messages + history
                }
                try Task.checkCancellation()
                guard scope == client.storageScope else { return }
            }
            guard let context = Self.context(rawTitle: session.title, history: history) else {
                if !oldCopy { decline(id, mtime: mtime) }
                return
            }
            let fingerprint = ClientStorage.digest([context])
            let result = try await client.enrich(machineId: machineId, sessionId: session.sessionId,
                source: session.source, uuid: "navigation-title-v1", text: context, purpose: "session_title")
            try Task.checkCancellation()
            guard scope == client.storageScope else { return }
            guard let title = result?.sessionTitle.flatMap(Self.validated) else {
                // The model answered (or the hub has no gateway) and nothing
                // usable came back: do not ask again for this version — unless
                // what it read was an older copy than this version.
                if !oldCopy { decline(id, mtime: mtime) }
                return
            }
            guard // A rename while the model was working must win the race.
                  entries[id] == nil,
                  client.machines.first(where: { $0.machine.machineId == machineId })?
                    .sessions.first(where: { $0.sessionId == session.sessionId })?.title == session.title
            else { return }
            entries[id] = Entry(raw: session.title, title: title, fingerprint: fingerprint,
                                checked: Date(), manual: false)
            declined[id] = nil
            persist()
        } catch { /* Keep the readable fallback. A later appearance may retry. */ }
    }

    static func validated(_ value: String) -> String? {
        let title = value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard (3...40).contains(title.utf16.count), !title.contains("…"), !title.contains("..."),
              !["в", "на", "с", "со", "для", "при", "и", "или", "по", "из", "от", "к", "о", "об", "for", "with", "to", "and", "of"]
                .contains(title.split(separator: " ").last?.lowercased() ?? "") else { return nil }
        return title
    }

    /// Legacy inventories carry no title provenance. Only replace a proven
    /// first-prompt title, never guess that a custom title is autogenerated.
    static func context(rawTitle: String, history: [HistoryMessage]) -> String? {
        let turns = history.compactMap { message -> (MessageRole, String)? in
            guard message.role == .user || message.role == .assistant else { return nil }
            let text = message.blocks.compactMap { block -> String? in
                if case let .text(t) = block { return t }; return nil
            }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : (message.role, text)
        }
        let raw = cleanTitle(rawTitle)
        // Wait for the first answer before fixing a generated title forever.
        guard turns.contains(where: { $0.0 == .assistant }), raw.count >= 5,
              turns.contains(where: { role, text in
                  role == .user && (cleanTitle(text) == raw || cleanTitle(text).hasPrefix(raw))
              }) else { return nil }
        let indices = Set(Array(turns.indices.prefix(3)) + Array(turns.indices.suffix(8))).sorted()
        return indices.map { i in
            let turn = turns[i]
            return "\(turn.0 == .user ? "USER" : "ASSISTANT"): \(turn.1.prefix(1000))"
        }.joined(separator: "\n\n")
    }

    /// Drop the generated names of one machine's sessions (see `TranscriptCache.purge`).
    /// Keys are digests, so the sessions are named by the caller.
    public func purge(machineId: String, sessions: [SessionSummary]) {
        var changed = false
        for s in sessions {
            for source in [nil, "claude", "codex"] as [String?] {
                var probe = s
                probe.source = source
                let k = key(machineId, probe)
                if entries.removeValue(forKey: k) != nil { changed = true }
                declined[k] = nil
            }
        }
        if changed { persist() }
        if let declinedFile, let data = try? JSONEncoder().encode(declined) { try? data.write(to: declinedFile, options: .atomic) }
    }

    private func persist() {
        // Names are durable identity, not an LRU: evicting one would generate a
        // different name the next time that older conversation was opened.
        guard let file, let data = try? JSONEncoder().encode(entries) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
}
