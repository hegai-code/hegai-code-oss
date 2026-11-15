import Foundation
import CCRemoteKit

/// Codex `:codex-file-citation{…path="…"…}` markers (web `stripCitations`):
/// collapsed to the file's basename in backticks so they never become a
/// button label or a highlighted "decision".
func stripCitations(_ text: String) -> String {
    guard text.contains("codex-file-citation"),
          let re = try? NSRegularExpression(
            pattern: ":?:codex-file-citation\\{[^{}]*?path=\"([^\"]+)\"[^{}]*\\}\\.?")
    else { return text }
    let ns = text as NSString
    var out = text
    for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
        let path = ns.substring(with: m.range(at: 1))
        out = (out as NSString).replacingCharacters(in: m.range, with: "`\((path as NSString).lastPathComponent)`")
    }
    return out
}

/// The transcript's tail assistant turn as the enrichment layer sees it.
struct EnrichTail: Equatable {
    let uuid: String
    let text: String
    /// Keyed on the TEXT, not the uuid. When a turn ends the tail flips from
    /// the live line to the history uuid with identical text; a uuid key would
    /// fire a second request — and a second LLM call, because the hub's cache
    /// key includes the uuid too.
    /// Считается один раз при создании: хеш по всему тексту хвоста спрашивали по
    /// шесть раз за проход экрана.
    let key: String

    init(uuid: String, text: String) {
        self.uuid = uuid
        self.text = text
        self.key = EnrichTail.digest(text)
    }

    static func digest(_ s: String) -> String {
        var h: UInt64 = 5381
        for b in s.utf8 { h = (h &* 33) &+ UInt64(b) }
        return String(h, radix: 16)
    }
}

/// Finds the turn worth enriching — the mirror of web `Chat.tsx`/`Mirror.tsx`.
enum EnrichTailFinder {
    /// Nothing while the run is busy (the answer is still being written). The
    /// newest live assistant line wins; a live user or error line at the tail
    /// means nothing is pending; otherwise the last assistant history turn with
    /// prose, skipping machinery. A human history turn at the tail → nil.
    static func tail(history: [HistoryMessage], lines: [TranscriptLine], busy: Bool) -> EnrichTail? {
        if busy { return nil }
        for line in lines.reversed() {
            switch line.kind {
            case .assistant:
                let text = clean(line.text)
                return text.isEmpty ? nil : EnrichTail(uuid: "live-\(line.id)", text: text)
            case .user, .error:
                return nil
            default:
                continue
            }
        }
        return tail(mirror: history)
    }

    /// The history half only — what the mirror has.
    static func tail(mirror history: [HistoryMessage]) -> EnrichTail? {
        for msg in history.reversed() {
            if msg.role == .system { continue }
            let cleaned = cleanedBlocks(msg.blocks)
            if cleaned.isEmpty { continue }
            let machineryOnly = cleaned.allSatisfy(isMachinery)
            switch msg.role {
            case .user:
                if machineryOnly { continue }
                return nil
            case .assistant:
                let prose = cleaned.compactMap { block -> String? in
                    if case let .text(t) = block { return t }
                    return nil
                }.joined(separator: "\n")
                let text = clean(prose)
                if text.isEmpty { continue }
                return EnrichTail(uuid: msg.uuid, text: text)
            default:
                return nil
            }
        }
        return nil
    }

    /// The user turn that prompted the tail — context for the hub's pass.
    static func echoedUserText(history: [HistoryMessage], lines: [TranscriptLine]) -> String? {
        if let live = lines.last(where: { $0.kind == .user }) {
            let t = live.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        for msg in history.reversed() where msg.role == .user {
            let cleaned = cleanedBlocks(msg.blocks)
            if cleaned.allSatisfy(isMachinery) { continue }
            let text = cleaned.compactMap { block -> String? in
                if case let .text(t) = block { return t }
                return nil
            }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
        return nil
    }

    /// The newest turn worth reading, whoever said it.
    ///
    /// Distinct from `tail(mirror:)` above on purpose: that one answers "is there
    /// an assistant turn to enrich" and deliberately gives up when a human spoke
    /// last. A list preview wants the opposite — the last thing that happened,
    /// so a session you just sent a question to shows the question rather than
    /// the answer before it.
    ///
    /// Machinery-only turns (a tool call and its result, nothing said) are
    /// skipped: they are the bulk of a transcript and none of its meaning.
    static func lastTurn(history: [HistoryMessage]) -> (role: MessageRole, text: String)? {
        for msg in history.reversed() {
            if msg.role == .system { continue }
            let cleaned = cleanedBlocks(msg.blocks)
            if cleaned.isEmpty || cleaned.allSatisfy(isMachinery) { continue }
            let prose = cleaned.compactMap { block -> String? in
                if case let .text(t) = block { return t }
                return nil
            }.joined(separator: "\n")
            let text = clean(prose)
            if text.isEmpty { continue }
            return (msg.role, text)
        }
        return nil
    }

    // MARK: Pieces

    static func clean(_ text: String) -> String {
        stripCitations(stripHarnessNoise(text)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func cleanedBlocks(_ blocks: [RenderBlock]) -> [RenderBlock] {
        blocks.compactMap { block in
            if case let .text(t) = block {
                let c = stripHarnessNoise(t)
                return c.isEmpty ? nil : .text(c)
            }
            return block
        }
    }

    private static func isMachinery(_ block: RenderBlock) -> Bool {
        if case .toolUse = block { return true }
        if case .toolResult = block { return true }
        return false
    }
}

/// `EnrichTailFinder.tail` с памятью на последний вход: экран спрашивает хвост по
/// пять раз за проход, а вход (история и живые строки) между проходами чаще всего тот же.
///
/// `lines` — замыкание, и это нарочно: пока ран занят, хвоста нет, и живые строки не
/// читаются, а значит экран, звавший это из body, не подписывается на каждую дельту стрима.
/// Ссылочный тип в `@State`: переживает пересчёт body, сам за собой SwiftUI не следит.
final class EnrichTailMemo {
    private var history: [HistoryMessage] = []
    private var lines: [TranscriptLine] = []
    private var value: EnrichTail?
    private var valid = false

    func tail(history: [HistoryMessage], busy: Bool, lines readLines: () -> [TranscriptLine]) -> EnrichTail? {
        if busy { return nil }
        let current = readLines()
        if valid, history == self.history, current == lines { return value }
        let found = EnrichTailFinder.tail(history: history, lines: current, busy: false)
        self.history = history
        lines = current
        value = found
        valid = true
        return found
    }
}
