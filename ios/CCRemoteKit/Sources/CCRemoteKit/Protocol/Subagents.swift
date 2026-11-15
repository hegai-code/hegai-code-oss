import Foundation

// Sub-agents in the chat (10.10.2026) — the iPhone half of
// `shared/src/subagents.ts` and `web/src/render/Subagents.tsx`.
//
// A sub-agent the session's model started (Claude's `Agent`/`Task` tool, a
// Codex `spawn_agent` thread) is drawn as ONE card under the paragraph that
// started it, plus a row in the «В фоне» panel over the composer while it runs.
// Never its messages: those live in its own transcript (`session.subagent`),
// because streamed into the parent's they read as the session talking.
//
// The live facts come from the agent's `subagents` status — a LEVEL, like
// `background_tasks`: each frame replaces the last and the hub replays the
// latest to a late viewer. A reloaded transcript has no such frame, so the card
// falls back on what the parent's own transcript says (`SubagentNotices`).

public enum SubagentStatus: String, Decodable, Equatable, Sendable {
    case running, completed, failed, stopped

    /// The word under a finished card (web `STATUS_WORD`).
    public var word: String {
        switch self {
        case .running: return "работает"
        case .completed: return "готово"
        case .failed: return "ошибка"
        case .stopped: return "остановлен"
        }
    }
}

/// One sub-agent of the followed run (`SubagentSchema`). Times are ms epoch.
public struct Subagent: Decodable, Equatable, Sendable, Identifiable {
    /// The runtime's handle: Claude's `task_id`, Codex's child thread id.
    /// What `run.stopSubagent` takes.
    public let id: String
    /// The parent's tool call that started it — the card's anchor and the key
    /// `session.subagent` reads by.
    public var toolUseId: String?
    public var kind: String
    public var description: String
    public var status: SubagentStatus
    public var background: Bool?
    public var startedAt: Double
    public var endedAt: Double?
    public var toolUses: Int?
    public var tokens: Int?
    /// What it is doing now, one line. Running only.
    public var lastAction: String?
    /// The few actions before `lastAction`, oldest first (≤ `recentMax`).
    /// Running only.
    public var recent: [String]?
    /// ms epoch of its last sign of work — «тихо 1:05» when it stalls.
    public var activeAt: Double?
    /// Its final report, capped. Ended only.
    public var summary: String?
    public var model: String?
    /// Its own checklist, if it keeps one: «3/5 · сейчас». Optional and lossy —
    /// a malformed `plan` is nil, the row stays (an old agent sends none).
    public var plan: PlanProgress?

    public init(id: String, toolUseId: String? = nil, kind: String, description: String,
                status: SubagentStatus, background: Bool? = nil, startedAt: Double,
                endedAt: Double? = nil, toolUses: Int? = nil, tokens: Int? = nil,
                lastAction: String? = nil, recent: [String]? = nil, activeAt: Double? = nil,
                summary: String? = nil, model: String? = nil, plan: PlanProgress? = nil) {
        self.id = id
        self.toolUseId = toolUseId
        self.kind = kind
        self.description = description
        self.status = status
        self.background = background
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.toolUses = toolUses
        self.tokens = tokens
        self.lastAction = lastAction
        self.recent = recent
        self.activeAt = activeAt
        self.summary = summary
        self.model = model
        self.plan = plan
    }

    private enum K: String, CodingKey {
        case id, toolUseId, kind, description, status, background, startedAt, endedAt
        case toolUses, tokens, lastAction, recent, activeAt, summary, model, plan
    }

    /// As strict as `SubagentSchema`: a field that is present but of the wrong
    /// type, or over the schema's length, fails the row (`LossySubagent` then
    /// drops it), so the phone never shows — and offers Stop on — a row the
    /// web rejected. Absent optionals are fine; `null` is not (the wire omits
    /// an absent optional, and zod refuses null). Lengths count UTF-16 units,
    /// as JavaScript's `.max()` does.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        func opt<T: Decodable>(_ type: T.Type, _ key: K) throws -> T? {
            guard c.contains(key) else { return nil }
            if try c.decodeNil(forKey: key) {
                throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "null")
            }
            return try c.decode(type, forKey: key)
        }
        func str(_ key: K, max: Int) throws -> String? {
            guard let v = try opt(String.self, key) else { return nil }
            guard v.utf16.count <= max else {
                throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "over \(max)")
            }
            return v
        }
        func count(_ key: K) throws -> Int? {
            guard let v = try opt(Int.self, key) else { return nil }
            guard v >= 0 else { throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "negative") }
            return v
        }
        guard let id = try str(.id, max: 200), !id.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "missing or empty id")
        }
        self.id = id
        guard let kind = try str(.kind, max: 80), let description = try str(.description, max: 200) else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "kind/description required")
        }
        self.kind = kind
        self.description = description
        status = try c.decode(SubagentStatus.self, forKey: .status)
        startedAt = try c.decode(Double.self, forKey: .startedAt)
        toolUseId = try str(.toolUseId, max: 200)
        background = try opt(Bool.self, .background)
        endedAt = try opt(Double.self, .endedAt)
        toolUses = try count(.toolUses)
        tokens = try count(.tokens)
        lastAction = try str(.lastAction, max: 160)
        recent = try opt([String].self, .recent)
        if let recent, recent.count > Self.recentMax || recent.contains(where: { $0.utf16.count > 160 }) {
            throw DecodingError.dataCorruptedError(forKey: .recent, in: c, debugDescription: "recent over limits")
        }
        activeAt = try opt(Double.self, .activeAt)
        summary = try str(.summary, max: 2000)
        model = try str(.model, max: 80)
        plan = (try? c.decodeIfPresent(PlanProgress.self, forKey: .plan)) ?? nil
    }

    /// At most this many go on the wire (`SUBAGENTS_MAX`).
    public static let maxCount = 32
    /// Steps a card keeps above «сейчас» (`SUBAGENT_RECENT`).
    public static let recentMax = 3
}

/// One row of `data.agents`; a malformed row decodes to nil instead of failing
/// the frame — one bad agent must not blank the others (`parseSubagents`).
struct LossySubagent: Decodable {
    let agent: Subagent?
    init(from decoder: Decoder) throws { agent = try? Subagent(from: decoder) }
}

// MARK: - The parent's transcript

/// What a Claude `<task-notification>` says about a background agent that
/// finished (`parseTaskNotification` in shared/src/subagents.ts).
public struct TaskNotice: Equatable, Sendable {
    public var toolUseId: String?
    public var taskId: String?
    public var status: SubagentStatus?
    public var summary: String?

    public init?(text: String) {
        guard text.contains("<task-notification>") else { return nil }
        func tag(_ name: String) -> String? {
            guard let open = text.range(of: "<\(name)>"),
                  let close = text.range(of: "</\(name)>", range: open.upperBound..<text.endIndex) else { return nil }
            let value = text[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }
        toolUseId = tag("tool-use-id")
        taskId = tag("task-id")
        switch tag("status") {
        case "completed": status = .completed
        case "failed": status = .failed
        case "stopped", "killed": status = .stopped
        default: status = nil
        }
        summary = (tag("result") ?? tag("summary")).map { String($0.prefix(2000)) }
    }
}

/// One `Agent`/`Task` call in the parent's transcript — what a card is drawn for.
public struct SubagentCall: Equatable, Sendable {
    public var toolUseId: String?
    public var kind: String
    public var description: String

    public init(toolUseId: String?, kind: String, description: String) {
        self.toolUseId = toolUseId
        self.kind = kind
        self.description = description
    }

    public static let toolNames: Set<String> = ["Agent", "Task"]

    static func of(name: String, input: JSONValue, id: String?) -> SubagentCall? {
        guard toolNames.contains(name) else { return nil }
        func s(_ k: String) -> String { input[k]?.stringValue ?? "" }
        let kind = s("subagent_type")
        let description = s("description")
        return SubagentCall(toolUseId: id.flatMap { $0.isEmpty ? nil : $0 },
                            kind: kind.isEmpty ? "агент" : kind,
                            description: description.isEmpty ? String(s("prompt").prefix(120)) : description)
    }

    /// The calls among history blocks (web `agentCallsFromBlocks`).
    public static func from(blocks: [RenderBlock]) -> [SubagentCall] {
        blocks.compactMap { block in
            guard case let .toolUse(id, name, input) = block else { return nil }
            return of(name: name, input: input, id: id)
        }
    }

    /// The calls among live lines: a `tool_use` line is "Name {json}", its id
    /// in `toolUseId` (the stream event's `data.id`; web `agentCallsFromLines`).
    public static func from(lines: [TranscriptLine]) -> [SubagentCall] {
        lines.compactMap { line in
            guard line.kind == .tool_use else { return nil }
            let text = line.text
            let space = text.firstIndex(of: " ")
            let name = space.map { String(text[..<$0]) } ?? text
            guard toolNames.contains(name) else { return nil }
            var input: JSONValue = .object([:])
            if let space, let data = String(text[text.index(after: space)...]).data(using: .utf8),
               let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) {
                input = parsed
            }
            // A clipped line still names the call.
            return of(name: name, input: input, id: line.toolUseId)
        }
    }
}

/// What the parent's transcript itself says about how a call ended.
public struct AgentNotice: Equatable, Sendable {
    public var status: SubagentStatus?
    public var summary: String?
    /// The result was «launched in the background», not a report.
    public var async: Bool = false

    public init(status: SubagentStatus? = nil, summary: String? = nil, async: Bool = false) {
        self.status = status
        self.summary = summary
        self.async = async
    }
}

public enum SubagentNotices {
    /// The parent transcript's record of how each `Agent` call ended
    /// (web `agentNotices`). The FIRST ending is the ending, as the agent's
    /// `attachTaskNotices` keeps it (f47a2c9): a Stop and then the CLI's
    /// trailing «completed» reads «остановлен», as it does live. A later
    /// notice may only fill in a report the first one lacked.
    public static func from(history: [HistoryMessage]) -> [String: AgentNotice] {
        var calls = Set<String>()
        var out: [String: AgentNotice] = [:]
        func end(_ id: String, _ status: SubagentStatus, _ summary: String?) {
            var notice = out[id] ?? AgentNotice()
            if notice.status == nil {
                notice.status = status
                notice.summary = summary ?? notice.summary
            } else if notice.summary == nil {
                notice.summary = summary
            }
            out[id] = notice
        }
        for message in history {
            for block in message.blocks {
                switch block {
                case let .toolUse(id, name, _) where SubagentCall.toolNames.contains(name) && !id.isEmpty:
                    calls.insert(id)
                case let .toolResult(toolUseId, text, isError) where calls.contains(toolUseId):
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if trimmed.range(of: "^async agent launched", options: [.regularExpression, .caseInsensitive]) != nil {
                        var notice = out[toolUseId] ?? AgentNotice()
                        notice.async = true
                        out[toolUseId] = notice
                    } else {
                        // A blank result is no report: a later notice may still supply one.
                        end(toolUseId, isError ? .failed : .completed,
                            trimmed.isEmpty ? nil : String(trimmed.prefix(2000)))
                    }
                case let .text(text) where text.contains("<task-notification>"):
                    if let n = TaskNotice(text: text), let id = n.toolUseId {
                        end(id, n.status ?? .completed, n.summary)
                    }
                default:
                    break
                }
            }
        }
        return out
    }
}

// MARK: - Presentation helpers (pure, shared by card, panel and tests)

public enum SubagentFormat {
    /// «41k» / «812».
    public static func tokens(_ n: Int) -> String {
        n >= 1000 ? "\(Int((Double(n) / 1000).rounded()))k" : String(n)
    }

    /// «42с» / «1:23».
    public static func clock(ms: Double) -> String {
        // Any finite number is schema-valid; one far out of range must not trap
        // the Int conversion.
        guard ms.isFinite else { return "0с" }
        let secs = Int(min(max(0, (ms / 1000).rounded()), Double(Int32.max)))
        return secs < 60 ? "\(secs)с" : String(format: "%d:%02d", secs / 60, secs % 60)
    }

    static func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        let m100 = n % 100
        if (11...14).contains(m100) { return many }
        let m10 = n % 10
        return m10 == 1 ? one : (2...4).contains(m10) ? few : many
    }

    /// A running agent that has not moved for this long says so (web `QUIET_MS`).
    public static let quietAfterMs: Double = 30_000

    /// How long a RUNNING agent has been silent, when that is ≥ 30 с — the
    /// «· тихо 1:05» after the counters (web `quietFor`).
    public static func quiet(_ agent: Subagent?, nowMs: Double) -> Double? {
        guard let agent, agent.status == .running, let at = agent.activeAt, at > 0 else { return nil }
        let quiet = nowMs - at
        return quiet >= quietAfterMs ? quiet : nil
    }

    /// «12 вызовов · 41k токенов · 1:23» (web `Meta`).
    public static func meta(_ agent: Subagent, nowMs: Double) -> String {
        var parts: [String] = []
        if let uses = agent.toolUses { parts.append("\(uses) \(plural(uses, "вызов", "вызова", "вызовов"))") }
        if let tokens = agent.tokens, tokens > 0 { parts.append("\(Self.tokens(tokens)) токенов") }
        let end = agent.status == .running ? nowMs : (agent.endedAt ?? nowMs)
        parts.append(clock(ms: end - agent.startedAt))
        return parts.joined(separator: " · ")
    }
}

/// A row of the «В фоне» panel: a live sub-agent, or another background task.
public struct SubagentPanelRow: Equatable, Sendable, Identifiable {
    public let id: String
    public var label: String
    public var kind: String?
    public var lastAction: String?
    public var since: Double
    public var agent: Subagent?
    public var toolUseId: String?
    /// The sub-agent that started this task (`RunBackgroundTask.owner`).
    public var owner: String?
    /// Every task id the row stands for: a repeated task is one row, and Stop
    /// must reach them all (`collapseRepeats` on web).
    public var ids: [String] = []

    /// What still runs, joined by task id — the background list names a
    /// sub-agent the same way the `subagents` level does (web `panelRows`).
    /// A foreground sub-agent whose card sits in the transcript (`anchored`)
    /// is never a row. A background one is not a row while its card is in the
    /// mounted window of the transcript (`near`, default `anchored`) — the card
    /// already has its clock, its step and «Остановить», and a second copy
    /// under it was the duplicate the owner pointed at (24.10.2026). One whose
    /// card left the window above keeps its row (the web does the same by
    /// visibility; iOS 17 has no scroll-visibility signal).
    /// A background Bash or a Codex child has no `Agent` call to anchor a
    /// card, so it is a row.
    public static func rows(background: [RunBackgroundTask], agents: [Subagent],
                            anchored: Set<String>, near: Set<String>? = nil) -> [SubagentPanelRow] {
        let near = near ?? anchored
        let byId = Dictionary(agents.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var rows: [SubagentPanelRow] = []
        var seen = Set<String>()
        var firstOf: [String: Int] = [:]
        for task in background {
            let a = byId[task.id]
            seen.insert(task.id)
            if let call = a?.toolUseId, near.contains(call) { continue }
            // A sub-agent is its own work with its own transcript, never a repeat.
            if a == nil, let key = task.repeatKey, let head = firstOf[key] {
                rows[head].ids.append(task.id)
                rows[head].since = min(rows[head].since, task.since)
                continue
            }
            if a == nil, let key = task.repeatKey { firstOf[key] = rows.count }
            let description = a?.description ?? ""
            rows.append(SubagentPanelRow(id: task.id, label: description.isEmpty ? task.label : description,
                                         kind: a?.kind, lastAction: a?.lastAction,
                                         since: a?.startedAt ?? task.since, agent: a, toolUseId: a?.toolUseId,
                                         owner: task.owner, ids: [task.id]))
        }
        for a in agents where a.status == .running && !seen.contains(a.id) {
            if let call = a.toolUseId, a.background == true ? near.contains(call) : anchored.contains(call) { continue }
            rows.append(SubagentPanelRow(id: a.id, label: a.description, kind: a.kind, lastAction: a.lastAction,
                                         since: a.startedAt, agent: a, toolUseId: a.toolUseId, ids: [a.id]))
        }
        return rows
    }
}
