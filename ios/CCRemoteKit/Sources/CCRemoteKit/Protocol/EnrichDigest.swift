import Foundation

/// What the suggestion model reads besides the final message (web
/// `buildTurnDigest` in `render/enrich.ts`): who asked for what, every action
/// the agent took since, every error it hit, and a little of the conversation
/// before. The final assistant message is NOT in here — it travels as `text`,
/// and the hub puts it last, where the handoff is judged.
///
/// Without it the model judged a turn by its closing summary alone and
/// proposed steps the agent had already taken. Same shape and budgets as the
/// web's; byte-identical output is not a goal (Swift counts characters where JS
/// counts UTF-16 units), the model reads the same sections either way.
///
/// Foundation-only on purpose: the text cleaning that lives in the app target
/// (`stripHarnessNoise`, Codex citations) arrives as the `clean` closure.
public enum EnrichDigest {
    /// Characters the digest may take (the hub accepts 16 000).
    public static let budget = 12_000
    /// Actions listed before the middle of a long turn is elided.
    public static let maxActions = 60

    private enum Role { case user, assistant, tool, error }
    private struct Entry { let role: Role; let text: String }

    /// `history` is the file's messages, `live` the stream lines ahead of it
    /// (the run just went idle and the refetch has not landed). `nil` when there
    /// is nothing beyond the final message to say.
    public static func build(history: [HistoryMessage], live: [TranscriptLine], cwd: String? = nil,
                             clean: (String) -> String) -> String? {
        let all = historyEntries(history, clean: clean) + liveEntries(live, clean: clean)
        // The final assistant message is the tail itself — it goes separately.
        var end = all.count
        while end > 0, all[end - 1].role == .assistant { end -= 1 }
        let lastUser = all[..<end].lastIndex { $0.role == .user }
        let turn = lastUser.map { Array(all[($0 + 1)..<end]) } ?? Array(all[..<end])
        let ask = lastUser.map { all[$0].text }
        let before = lastUser.map { Array(all[..<$0]) } ?? []
        if (ask ?? "").isEmpty && turn.isEmpty { return nil }

        // Actions, with runs of the same line collapsed («Read ×4») and the
        // middle of a very long turn elided — its start says what it set out to
        // do, its end what state it left things in.
        var acts: [String] = []
        for e in turn {
            let line: String
            switch e.role {
            case .tool: line = e.text
            case .error: line = "✗ ERROR: \(e.text)"
            default: line = "(said) \(oneLine(e.text, 300))"
            }
            if let prev = acts.last {
                if prev == line {
                    acts[acts.count - 1] = "\(line) ×2"
                    continue
                }
                if let (base, n) = repeatCount(prev), base == line {
                    acts[acts.count - 1] = "\(line) ×\(n + 1)"
                    continue
                }
            }
            acts.append(line)
        }
        let shown: [String]
        if acts.count > maxActions {
            shown = Array(acts.prefix(12)) + ["… \(acts.count - maxActions) more actions …"]
                + Array(acts.suffix(maxActions - 12))
        } else {
            shown = acts
        }

        // The two exchanges before this one: what the person said, what the
        // agent answered last — for «проверь оба фикса» to know which fixes.
        var earlier: [String] = []
        var exchanges = 0
        var i = before.count - 1
        while i >= 0, exchanges < 2 {
            defer { i -= 1 }
            let e = before[i]
            guard e.role == .user else { continue }
            // The agent's last words in THIS exchange: stop at the next person's
            // turn (the web's `slice(i + 1)` runs on and can pick a later one).
            let reply = before[(i + 1)...].prefix { $0.role != .user }.last { $0.role == .assistant }
            var block = "USER: \(oneLine(e.text, 600))"
            if let reply {
                block += "\nASSISTANT (last words): \(oneLine(String(reply.text.suffix(900)), 900))"
            }
            earlier.insert(block, at: 0)
            exchanges += 1
        }

        let head = (cwd?.isEmpty == false) ? "PROJECT: \(cwd!)\n\n" : ""
        let askPart = (ask?.isEmpty == false) ? "USER TURN (what the person asked):\n\(clip(ask!, 3000))\n\n" : ""
        let actPart = "WHAT THE AGENT DID THIS TURN (in order):\n"
            + (shown.isEmpty ? "- (no tool calls — it only answered)" : shown.map { "- \($0)" }.joined(separator: "\n"))
        var earlierPart = earlier.isEmpty ? "" : "EARLIER IN THE SESSION:\n\(earlier.joined(separator: "\n\n"))\n\n"
        let fixed = head.count + askPart.count + actPart.count
        if fixed + earlierPart.count > budget {
            earlierPart = fixed < budget - 200
                ? String(earlierPart.prefix(max(0, budget - fixed - 2))) + "\n\n"
                : ""
        }
        return clip(head + earlierPart + askPart + actPart, budget + 500)
    }

    // MARK: Entries

    private static func historyEntries(_ history: [HistoryMessage], clean: (String) -> String) -> [Entry] {
        var out: [Entry] = []
        for m in history {
            for b in m.blocks {
                switch b {
                case .text(let t):
                    // A `<task-notification>` arrives as a USER row and is
                    // machinery; stripped, it is empty and must not read as the
                    // person speaking.
                    let text = clean(t).trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty { continue }
                    if m.role == .user { out.append(Entry(role: .user, text: text)) }
                    else if m.role == .assistant { out.append(Entry(role: .assistant, text: text)) }
                case .toolUse(_, let name, let input):
                    out.append(Entry(role: .tool, text: describeCall(name, input)))
                case .toolResult(_, let text, let isError):
                    if isError { out.append(Entry(role: .error, text: oneLine(text, 240))) }
                default:
                    continue
                }
            }
        }
        return out
    }

    private static func liveEntries(_ lines: [TranscriptLine], clean: (String) -> String) -> [Entry] {
        var out: [Entry] = []
        for l in lines {
            switch l.kind {
            case .user, .assistant:
                let text = clean(l.text).trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { out.append(Entry(role: l.kind == .user ? .user : .assistant, text: text)) }
            case .tool_use:
                let (name, input) = parseToolLine(l.text)
                out.append(Entry(role: .tool, text: describeCall(name, input)))
            case .error:
                out.append(Entry(role: .error, text: oneLine(l.text, 240)))
            default:
                continue
            }
        }
        return out
    }

    // MARK: Pieces

    /// A streamed `tool_use` line arrives as "ToolName {json}" (web
    /// `parseToolLine`); Codex streams a shell call as "$ <command>".
    static func parseToolLine(_ text: String) -> (name: String, input: JSONValue) {
        if text.hasPrefix("$ ") { return ("$", .object(["command": .string(String(text.dropFirst(2)))])) }
        guard let sp = text.firstIndex(of: " ") else { return (text, .object([:])) }
        let name = String(text[..<sp])
        let rest = String(text[text.index(after: sp)...])
        if let value = try? JSONDecoder().decode(JSONValue.self, from: Data(rest.utf8)) { return (name, value) }
        return (name, .string(rest))
    }

    /// One tool call as a line the model can reason about: «did it deploy?»,
    /// «did it run the tests?», «is something still in the background?». Fuller
    /// than a transcript pill (the whole command, the path's tail) and still one
    /// line (web `describeCall`).
    static func describeCall(_ name: String, _ input: JSONValue) -> String {
        let o = input.objectValue ?? [:]
        func str(_ k: String) -> String? { o[k]?.stringValue }
        func first(_ keys: String...) -> String? {
            for k in keys { if let v = str(k) { return v.isEmpty ? nil : v } }
            return nil
        }
        let bg = o["run_in_background"]?.boolValue == true ? " [in background]" : ""
        if name == "$" { return "$ \(oneLine(str("command") ?? "", 200))" }
        if let cmd = str("command"), !cmd.isEmpty { return "\(name): \(oneLine(cmd, 200))\(bg)" }
        if let file = first("file_path", "notebook_path", "path") { return "\(name) \(shortPath(file))" }
        if let desc = str("description"), !desc.isEmpty {
            let who = str("subagent_type").flatMap { $0.isEmpty ? nil : $0 }
            return "\(name)\(who.map { "(\($0))" } ?? ""): \(oneLine(desc, 160))\(bg)"
        }
        if let what = first("pattern", "url", "query", "skill", "prompt") { return "\(name) \(oneLine(what, 160))" }
        if let s = input.stringValue { return "\(name) \(oneLine(s, 160))" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        if let data = try? encoder.encode(input), let json = String(data: data, encoding: .utf8),
           !json.isEmpty, json != "{}", json != "null" {
            return "\(name) \(oneLine(json, 120))"
        }
        return name
    }

    /// The tail of a path — enough to name the file without a worktree prefix.
    static func shortPath(_ p: String) -> String {
        let parts = p.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        let tail = parts.suffix(3).joined(separator: "/")
        return tail.isEmpty ? p : tail
    }

    static func oneLine(_ s: String, _ max: Int) -> String {
        clip(s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " "), max)
    }

    static func clip(_ s: String, _ n: Int) -> String {
        guard s.count > n else { return s }
        var head = String(s.prefix(max(0, n - 1)))
        while let last = head.last, last.isWhitespace { head.removeLast() }
        return head + "…"
    }

    /// «Read ×4» → ("Read", 4); nil when the line carries no repeat count.
    private static func repeatCount(_ line: String) -> (String, Int)? {
        guard let r = line.range(of: " ×", options: .backwards) else { return nil }
        let digits = line[r.upperBound...]
        guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(digits) else { return nil }
        return (String(line[..<r.lowerBound]), n)
    }
}
