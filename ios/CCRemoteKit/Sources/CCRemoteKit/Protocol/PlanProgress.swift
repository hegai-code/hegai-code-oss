import Foundation

// The session's plan as a checklist the person can watch — «3/7 · прогоняю
// тесты» over the composer and on a sub-agent card (07.11.2026).
//
// ДОСЛОВНЫЙ порт `shared/src/plan.ts`: `isPlanTool`, `planItems`, `planProgress`.
// Меняются вместе. Агент регистрирует инструмент `mcp__hegai__plan` с входом
// `TodoWrite` (`{todos:[{content,status,activeForm}]}`), модель переписывает
// список целиком при каждом вызове; сессии со старым `TodoWrite` читаются так же.

public let planToolName = "mcp__hegai__plan"

/// The tool names a client reads as a plan. Same input shape for both.
public func isPlanTool(_ name: String?) -> Bool {
    name == planToolName || name == "TodoWrite"
}

public enum PlanStatus: String, Equatable, Sendable {
    case pending, in_progress, completed
}

public struct PlanItem: Equatable, Sendable {
    public var content: String
    public var status: PlanStatus
    /// Present continuous, shown while the step runs («Прогоняю тесты»).
    public var activeForm: String?

    public init(content: String, status: PlanStatus, activeForm: String? = nil) {
        self.content = content
        self.status = status
        self.activeForm = activeForm
    }
}

/// «done of total, doing what» — what a card or a strip draws. Wire shape of
/// `Subagent.plan` (`PlanProgressSchema`). Decoding is as strict as the schema;
/// the sub-agent row decodes it lossily, so a bad one never costs the row.
public struct PlanProgress: Decodable, Equatable, Sendable {
    public var done: Int
    public var total: Int
    /// The step in progress, as its `activeForm` (else its `content`).
    public var active: String?

    public static let activeMax = 160

    public init(done: Int, total: Int, active: String? = nil) {
        self.done = done
        self.total = total
        self.active = active
    }

    private enum K: String, CodingKey { case done, total, active }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let done = try c.decode(Int.self, forKey: .done)
        let total = try c.decode(Int.self, forKey: .total)
        guard done >= 0, total >= 0 else {
            throw DecodingError.dataCorruptedError(forKey: .done, in: c, debugDescription: "negative")
        }
        var active: String?
        if c.contains(.active) {
            let s = try c.decode(String.self, forKey: .active)   // null is refused, as zod does
            guard s.utf16.count <= Self.activeMax else {
                throw DecodingError.dataCorruptedError(forKey: .active, in: c, debugDescription: "over \(Self.activeMax)")
            }
            active = s
        }
        self.done = done
        self.total = total
        self.active = active
    }

    /// 0…1 for a bar; nothing planned is nothing done.
    public var fraction: Double {
        total > 0 ? min(1, Double(done) / Double(total)) : 0
    }

    /// «3/5».
    public var count: String { "\(done)/\(total)" }
}

public enum Plan {
    /// A plan tool's `input.todos`, with every malformed row dropped rather
    /// than failing the whole list. `nil` when the input is not a plan at all.
    public static func items(_ input: JSONValue) -> [PlanItem]? {
        guard let todos = input["todos"]?.arrayValue else { return nil }
        var out: [PlanItem] = []
        for raw in todos {
            guard let row = raw.objectValue,
                  let content = row["content"]?.stringValue,
                  !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            let status = row["status"]?.stringValue.flatMap(PlanStatus.init(rawValue:)) ?? .pending
            var item = PlanItem(content: content, status: status)
            if let form = row["activeForm"]?.stringValue,
               !form.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                item.activeForm = form
            }
            out.append(item)
        }
        return out
    }

    public static func progress(_ items: [PlanItem]) -> PlanProgress {
        let done = items.filter { $0.status == .completed }.count
        var progress = PlanProgress(done: done, total: items.count)
        if let current = items.first(where: { $0.status == .in_progress }) {
            let active = (current.activeForm ?? current.content).trimmingCharacters(in: .whitespacesAndNewlines)
            if !active.isEmpty {
                progress.active = active.count > PlanProgress.activeMax
                    ? String(active.prefix(PlanProgress.activeMax - 1)) + "…" : active
            }
        }
        return progress
    }
}

/// The plan the main thread is working through right now.
public struct CurrentPlan: Equatable, Sendable {
    public var items: [PlanItem]
    public var progress: PlanProgress

    public init(items: [PlanItem]) {
        self.items = items
        self.progress = Plan.progress(items)
    }

    /// The one line of the strip: what runs now, else what is next.
    public var activeLine: String? {
        if let active = progress.active { return active }
        return items.first(where: { $0.status == .pending })?.content
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The latest plan call of the main thread that comes AFTER the last human
    /// message. The live tail (`lines`) is newer than the loaded history, so it
    /// is read first; a human line in it closes the search (a plan from before
    /// it does not count), otherwise history is read from its end to its own
    /// last human message. `nil` when there is none, or its list is empty.
    /// Same rule as web `currentPlan`.
    public static func current(history: [HistoryMessage], lines: [TranscriptLine]) -> CurrentPlan? {
        for line in lines.reversed() {
            // The person's line is live: this turn's plan, if any, is after it.
            // The file is not read — nothing ties its last human message to
            // THIS line (a repeated «продолжай», a picture, a clipped prompt
            // fool a text match), and no strip beats the previous task's count.
            if line.kind == .user { return nil }
            guard line.kind == .tool_use, let input = liveInput(line.text),
                  let items = Plan.items(input) else { continue }
            return make(items)
        }
        for message in history.reversed() {
            if isHuman(message) { return nil }
            guard message.role == .assistant else { continue }
            for block in message.blocks.reversed() {
                if case let .toolUse(_, name, input) = block, isPlanTool(name),
                   let items = Plan.items(input) {
                    return make(items)
                }
            }
        }
        return nil
    }

    /// A call with no `todos` at all is not a plan and the search goes on
    /// (as on the web); an EMPTY list is the model clearing it: no strip.
    private static func make(_ items: [PlanItem]) -> CurrentPlan? {
        items.isEmpty ? nil : CurrentPlan(items: items)
    }

    /// A live `tool_use` line is «Name {json}». A line that is not a plan call,
    /// or whose JSON was clipped, yields nil and the search goes on to an
    /// earlier call.
    private static func liveInput(_ text: String) -> JSONValue? {
        guard let space = text.firstIndex(of: " "), isPlanTool(String(text[..<space])),
              let data = String(text[text.index(after: space)...]).data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    private static let harnessBlocks = [
        "task-notification", "system-reminder", "local-command-stdout",
        "local-command-caveat", "command-name", "command-message", "command-args",
    ]

    private static func stripHarness(_ text: String) -> String {
        var s = text
        for tag in harnessBlocks {
            s = s.replacingOccurrences(of: "<\(tag)>[\\s\\S]*?</\(tag)>", with: "", options: .regularExpression)
        }
        return s
    }

    /// A user-typed turn: text or a picture, not a tool result and not harness
    /// plumbing (same rule as `TurnWork.isHuman`).
    static func isHuman(_ message: HistoryMessage) -> Bool {
        guard message.role == .user else { return false }
        var hasText = false
        for block in message.blocks {
            switch block {
            case .toolResult: return false
            case let .text(text):
                if !stripHarness(text).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { hasText = true }
            case .image: hasText = true
            default: break
            }
        }
        return hasText
    }
}
