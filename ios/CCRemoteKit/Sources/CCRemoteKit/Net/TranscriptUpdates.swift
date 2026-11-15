import Foundation

/// Wire identities and local echoes belong to one turn, even during replay.
enum TranscriptUpdates {
    static func wireTail(_ lines: [TranscriptLine]) -> Int? { lines.lastIndex { !$0.replayPending } }
    static func appendWire(_ line: TranscriptLine, to lines: inout [TranscriptLine]) {
        lines.insert(line, at: wireTail(lines).map { $0 + 1 } ?? 0)
    }
    static func userTurn(_ lines: inout [TranscriptLine], id: Int, turnId: String, text: String,
                         truncated: Bool, ts: Double?, images: Int, files: [String], matchEcho: Bool = true) {
        if let known = lines.firstIndex(where: { $0.turnId == turnId }) {
            if lines[known].replayPending {
                var echo = lines.remove(at: known)
                echo.replayPending = false
                appendWire(echo, to: &lines)
            }
            return
        }
        let shown = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? TranscriptLine.attachmentLabel(images: images, files: files) : text
        guard !shown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let turn = TranscriptLine(id: id, kind: .user,
                                  text: truncated ? shown.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) + "…" : shown,
                                  ts: ts ?? Date().timeIntervalSince1970 * 1000, turnId: turnId,
                                  truncated: truncated, attachedImageCount: images,
                                  attachmentOnly: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, files: files)
        if matchEcho, let index = lines.firstIndex(where: { $0.turnId == nil && matches($0, turn) }) {
            let replacement = confirmed(lines[index], by: turn)
            if lines[index].replayPending {
                lines.remove(at: index); appendWire(replacement, to: &lines)
            } else { lines[index] = replacement }
        } else { appendWire(turn, to: &lines) }
    }

    private static func matches(_ echo: TranscriptLine, _ turn: TranscriptLine) -> Bool {
        guard echo.kind == .user,
              (echo.attachedImageCount ?? echo.images.count) == (turn.attachedImageCount ?? turn.images.count),
              echo.files == turn.files else { return false }
        let raw = echo.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (raw.isEmpty || echo.attachmentOnly) == turn.attachmentOnly else { return false }
        let text = raw.isEmpty ? TranscriptLine.attachmentLabel(images: echo.images.count, files: echo.files) : raw
        let prefix = (turn.truncated ? String(turn.text.dropLast()) : turn.text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return turn.truncated ? text.hasPrefix(prefix) : text == prefix
    }

    private static func confirmed(_ echo: TranscriptLine, by turn: TranscriptLine) -> TranscriptLine {
        var result = echo
        result.turnId = turn.turnId
        result.attachedImageCount = turn.attachedImageCount
        result.files = turn.files
        result.replayPending = false
        // Preserve the full local text, bytes, timestamp and view identity.
        return result
    }

    static func finishReplay(lines: [TranscriptLine], echoes: [TranscriptLine], pendingIDs: Set<Int>) -> [TranscriptLine] {
        var result = lines
        var matched: Set<Int> = []
        var consumedIndices: Set<Int> = []
        // A trailing steer must not be placed before the replay's opening
        // question. Match pending identical phrases from the end, not the head.
        let ordered = echoes.reversed().filter { $0.turnId != nil } + echoes.reversed().filter { $0.turnId == nil }
        for echo in ordered {
            let index = result.indices.reversed().first { index in
                let turn = result[index]
                guard turn.kind == .user, !consumedIndices.contains(index) else { return false }
                if let id = echo.turnId { return turn.turnId == id }
                return pendingIDs.contains(echo.id) && matches(echo, turn)
            }
            if let index {
                consumedIndices.insert(index)
                result[index] = confirmed(echo, by: result[index])
                matched.insert(echo.id)
            }
        }
        result += echoes.filter { pendingIDs.contains($0.id) && !matched.contains($0.id) }.map { echo in
            var pending = echo; pending.replayPending = true; return pending
        }
        return result
    }

    /// A live `image_gen` event: ONE line per picture id, updated in place, so a
    /// replay of the same events (reconnect, mid-turn attach) never doubles the
    /// card, and `done` swaps the placeholder where it stands. A terminal state
    /// is never walked back by a late or replayed `started`.
    static func imageGen(_ lines: inout [TranscriptLine], id: Int, event: StreamEvent, now: Double) {
        guard let data = event.data, let cardId = data.id,
              let state = data.state.flatMap(ImageGenCard.State.init(rawValue:)) else { return }
        if let index = lines.lastIndex(where: { $0.imageGen?.id == cardId }) {
            var card = lines[index].imageGen!
            if card.state != .started, state == .started { return }
            card.state = state
            card.startedAt = data.startedAt ?? card.startedAt
            card.prompt = data.prompt ?? card.prompt
            card.ref = data.ref ?? card.ref
            card.error = data.error ?? card.error
            lines[index].imageGen = card
            return
        }
        var line = TranscriptLine(id: id, kind: .status, text: event.text ?? "", ts: data.startedAt ?? now,
                                  code: "image_gen")
        line.imageGen = ImageGenCard(id: cardId, state: state, startedAt: data.startedAt, firstSeen: now,
                                     prompt: data.prompt, ref: data.ref, error: data.error)
        appendWire(line, to: &lines)
    }

    /// The turn ended: a card still `started` will never hear `done`/`failed`
    /// (the turn was stopped), so it closes as failed instead of drawing forever.
    static func closeLiveImageGen(_ lines: inout [TranscriptLine]) {
        for index in lines.indices where lines[index].imageGen?.state == .started {
            lines[index].imageGen?.state = .failed
            if lines[index].imageGen?.error == nil { lines[index].imageGen?.error = "генерация прервана" }
        }
    }

    static func compaction(_ lines: inout [TranscriptLine], id: Int, event: StreamEvent) {
        guard let code = event.code else { return }
        let text = compactionWords(code: code, text: event.text ?? "")
        if code == "compact_started",
           let index = lines.lastIndex(where: { ["compact_started", "compact_done", "compact_failed"].contains($0.code ?? "") }),
           lines[index].code == "compact_started" {
            lines[index].text = text
            return
        }
        appendWire(TranscriptLine(id: id, kind: TranscriptLine.Kind(rawValue: event.kind.rawValue) ?? .status,
                                  text: text, code: code), to: &lines)
    }

    static func compactionWords(code: String, text: String) -> String {
        switch code {
        case "compact_started":
            return text.range(of: "queued", options: .caseInsensitive) != nil
                ? "Сжимаю контекст — после текущего хода…" : "Сжимаю контекст…"
        case "compact_done":
            let rest = text.replacingOccurrences(of: #"^context (?:auto-)?compacted:?\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
                .replacingOccurrences(of: #"\btokens\b"#, with: "токенов", options: [.regularExpression, .caseInsensitive])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return rest.rangeOfCharacter(from: .decimalDigits) != nil ? "контекст сжат: \(rest)" : "контекст сжат"
        default:
            let reason = text.replacingOccurrences(of: #"^⚠?\s*compaction failed:?\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return reason.isEmpty ? "Не удалось сжать контекст" : "Не удалось сжать контекст: \(reason)"
        }
    }
}
