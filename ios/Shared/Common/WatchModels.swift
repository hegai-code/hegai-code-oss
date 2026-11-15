import Foundation

// Codable shapes of WATCH.md §1 (push payload extras) and §4 (inbox).

struct WatchQuestion: Codable, Equatable {
    var key: String
    var question: String
    var options: [String]
    var multiSelect: Bool

    init(key: String, question: String, options: [String], multiSelect: Bool) {
        self.key = key; self.question = question; self.options = options; self.multiSelect = multiSelect
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(String.self, forKey: .question)
        key = try c.decodeIfPresent(String.self, forKey: .key) ?? question
        options = try c.decodeIfPresent([String].self, forKey: .options) ?? []
        multiSelect = try c.decodeIfPresent(Bool.self, forKey: .multiSelect) ?? false
    }
}

struct WatchReply: Codable, Equatable, Hashable {
    var label: String
    var send: String
}

struct WatchInboxItem: Codable, Equatable, Identifiable {
    /// Absent for idle sessions without a live run (WATCH.md §4a).
    var runId: String?
    var machineId: String
    var sessionId: String
    var title: String
    var machine: String
    var state: String
    var sinceMs: Int64?
    var lastModifiedMs: Int64?
    var source: String?
    var tool: String?
    var requestId: String?
    var questions: [WatchQuestion]?
    var plan: String?
    var lastText: String?
    /// The session's own checklist (WATCH.md §4, since 09.11.2026).
    var progress: WatchProgress? = nil
    /// When the current task began (epoch ms).
    var startedMs: Int64? = nil
    /// 0–100, how full the context window is.
    var contextPct: Int? = nil
    /// Background tasks still running.
    var background: Int? = nil
    /// [admin] What the finished turn did, and what to send next.
    var summary: String? = nil
    var replies: [WatchReply]? = nil
    /// The hub is still making the digest of a turn that just ended.
    var digestPending: Bool? = nil

    var id: String { runId ?? "\(machineId)/\(sessionId)" }
    /// Stable across a session gaining or losing a live run — what navigation keys on.
    var sessionKey: String { "\(machineId)/\(sessionId)" }
    var isWaiting: Bool { state == "needs_attention" && runId != nil }
    var isWorking: Bool { state == "working" }
    /// When the item entered its state (live) or the session last changed (idle).
    var activityMs: Int64? { sinceMs ?? lastModifiedMs }
    /// Engine for a runId-less reply; the hub defaults to claude.
    var engine: String { source ?? "claude" }
}

/// `progress` of an inbox item: the session's own plan.
struct WatchProgress: Codable, Equatable {
    var done: Int
    var total: Int
    var active: String?
    var steps: [WatchStep]?

    /// 0…1 for a ring or a bar.
    var fraction: Double { total > 0 ? min(1, Double(done) / Double(total)) : 0 }
}

struct WatchStep: Codable, Equatable, Hashable {
    var text: String
    var status: String  // completed | in_progress | pending
}

/// Section of the inbox list: waiting first, then working, then the rest.
enum WatchInboxSection: Int, CaseIterable {
    case waiting, working, recent

    var title: String {
        switch self {
        case .waiting: return "Ждут ответа"
        case .working: return "Работают"
        case .recent: return "Недавние"
        }
    }

    static func of(_ item: WatchInboxItem) -> WatchInboxSection {
        if item.state == "needs_attention" || item.state == "error" { return .waiting }
        if item.state == "working" { return .working }
        return .recent
    }

    /// Non-empty sections in display order; order inside a section is the hub's.
    static func group(_ items: [WatchInboxItem]) -> [(WatchInboxSection, [WatchInboxItem])] {
        allCases.compactMap { sec in
            let rows = items.filter { of($0) == sec }
            return rows.isEmpty ? nil : (sec, rows)
        }
    }
}

/// `GET /api/watch/history` (WATCH.md §4b).
struct WatchHistoryItem: Codable, Equatable, Identifiable {
    var role: String        // user | assistant | tool
    var text: String
    var ts: Int64?
    /// Position-based: items arrive oldest first and are re-fetched wholesale.
    var id: String { "\(role)|\(ts ?? 0)|\(text.hashValue)" }
}

struct WatchHistory: Codable, Equatable {
    var items: [WatchHistoryItem]
    var more: Bool

    init(items: [WatchHistoryItem], more: Bool) { self.items = items; self.more = more }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([WatchHistoryItem].self, forKey: .items) ?? []
        more = try c.decodeIfPresent(Bool.self, forKey: .more) ?? false
    }
}

struct WatchInbox: Codable, Equatable {
    var waiting: Int
    var working: Int
    var items: [WatchInboxItem]
}

/// What the hub put next to `aps` in an alert push (WATCH.md §1).
struct PushPayload: Equatable {
    var act: String?
    var runId: String?
    var requestId: String?
    var state: String?
    var questions: [WatchQuestion]
    var plan: String?
    var replies: [WatchReply]

    init(userInfo: [AnyHashable: Any]) {
        act = userInfo["act"] as? String
        runId = userInfo["runId"] as? String
        requestId = userInfo["requestId"] as? String
        state = userInfo["state"] as? String
        plan = userInfo["plan"] as? String
        if let ask = userInfo["ask"], JSONSerialization.isValidJSONObject(ask),
           let data = try? JSONSerialization.data(withJSONObject: ask) {
            struct Ask: Decodable { let questions: [WatchQuestion] }
            questions = (try? JSONDecoder().decode(Ask.self, from: data))?.questions ?? []
        } else {
            questions = []
        }
        if let raw = userInfo["replies"], JSONSerialization.isValidJSONObject(raw),
           let data = try? JSONSerialization.data(withJSONObject: raw) {
            replies = (try? JSONDecoder().decode([WatchReply].self, from: data)) ?? []
        } else {
            replies = []
        }
    }

    /// Strings offered as dictation suggestions for the REPLY text action.
    func suggestions(category: String) -> [String] {
        switch category {
        case HegaiNotif.ask: return questions.first?.options ?? []
        case HegaiNotif.done, HegaiNotif.error: return replies.map(\.send)
        default: return []
        }
    }
}
