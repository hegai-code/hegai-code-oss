import Foundation
import CCRemoteKit

/// History and replay are overlapping views of one conversation. Keep the
/// durable history intact and remove only a proven spoken prefix of the replay.
/// Never delete a history suffix: the replay buffer can be shorter than it.
final class TranscriptReconciler {
    private struct Speech {
        let index: Int
        let human: Bool
        let text: String
        let images: Int
        let ts: Double?
        var confirmed = false
        var truncated = false
    }
    private var previous: [HistoryMessage] = []
    private var saved: [Speech] = []
    /// Refs of the pictures the history already holds, for `withoutPictured`.
    private var drawnRefs: [String] = []

    func reconcile(history: [HistoryMessage], lines: [TranscriptLine]) -> [TranscriptLine] {
        let rest = reconcileSpeech(history: history, lines: lines)
        return Self.withoutPictured(rest, refs: drawnRefs)
    }

    /// A live picture card whose picture the history now carries is the same
    /// picture: the history's copy stays, the card goes (no duplicate when the
    /// file catches up with the stream, or a replay repeats `done`).
    static func withoutPictured(_ lines: [TranscriptLine], refs: [String]) -> [TranscriptLine] {
        guard !refs.isEmpty, lines.contains(where: { $0.imageGen != nil }) else { return lines }
        return lines.filter { line in
            guard let card = line.imageGen else { return true }
            return !refs.contains { card.matches(historyRef: $0) }
        }
    }

    private func reconcileSpeech(history: [HistoryMessage], lines: [TranscriptLine]) -> [TranscriptLine] {
        // History may have thousands of messages; tokenize it only when the
        // array changes, not for every streaming delta.
        if history != previous {
            previous = history
            drawnRefs = history.flatMap { message in
                message.blocks.compactMap { block -> String? in
                    if case let .generatedImage(ref, _) = block { return ref }
                    return nil
                }
            }
            saved = history.enumerated().compactMap { index, message in
                guard message.role == .user || message.role == .assistant else { return nil }
                let blocks = cleanBlocks(message.blocks)
                let text = blocks.compactMap { block -> String? in
                    if case .text(let text) = block { return text }; return nil
                }.joined(separator: "\n\n").trimmingCharacters(in: .newlines)
                let images = blocks.filter { if case .image = $0 { return true }; return false }.count
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || images > 0 else { return nil }
                return Speech(index: index, human: message.role == .user,
                              text: text, images: images, ts: message.ts)
            }
        }
        let live = lines.enumerated().compactMap { index, line -> Speech? in
            guard line.kind == .user || line.kind == .assistant else { return nil }
            var text = stripHarnessNoise(line.text).trimmingCharacters(in: .newlines)
            let images = line.attachedImageCount ?? line.images.count
            if line.attachmentOnly, images > 0, line.files.isEmpty { text = "" }
            if line.truncated, text.hasSuffix("…") { text.removeLast() }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || images > 0 else { return nil }
            return Speech(index: index, human: line.kind == .user,
                          text: text, images: images, ts: line.ts,
                          confirmed: line.turnId != nil, truncated: line.truncated)
        }
        guard let head = live.first, !saved.isEmpty else { return lines }
        let lastHuman = saved.lastIndex(where: \.human)
        let candidates = saved.indices.filter { index in
            let speech = saved[index]
            if head.human {
                guard speech.human, sameHuman(speech, head) else { return false }
                // Optimistic user timestamps are send times, unlike assistant
                // receipt times. A later identical prompt is a NEW turn.
                return true
            }
            return !speech.human && index > (lastHuman ?? -1)
        }
        for start in candidates {
            if let replacements = overlap(start: start, lastHuman: lastHuman, live: live) {
                return lines.enumerated().compactMap { index, line in
                    guard let text = replacements[index] else { return line }
                    if text.isEmpty { return nil }
                    var remainder = line
                    remainder.text = text
                    return remainder
                }
            }
        }
        return lines
    }

    private func overlap(start: Int, lastHuman: Int?, live: [Speech]) -> [Int: String]? {
        var h = start, l = 0
        var historyText = saved[start].text
        var liveText = live[0].text
        var replacements: [Int: String] = [:]
        var assistantMatched = false
        var humansDated = true
        while h < saved.count && l < live.count {
            let a = saved[h], b = live[l]
            guard a.human == b.human, a.images == b.images else { return nil }
            if a.human {
                guard sameHuman(a, b) else { return nil }
                if !b.confirmed || b.truncated || a.ts == nil || b.ts == nil { humansDated = false }
                if a.ts != nil, let y = b.ts {
                    // Even an immediate repeated question is a new turn if
                    // the stored answer predates this optimistic send.
                    let end = saved[(h + 1)...].firstIndex(where: \.human) ?? saved.endIndex
                    if let answerTime = saved[(h + 1)..<end].compactMap(\.ts).max(), answerTime < y {
                        return nil
                    }
                }
            } else {
                guard !historyText.isEmpty, !liveText.isEmpty else { return nil }
            }
            if a.human || historyText == liveText {
                if !a.human { assistantMatched = true }
                replacements[b.index] = ""
                h += 1; l += 1
                if h < saved.count { historyText = saved[h].text }
                if l < live.count { liveText = live[l].text }
            } else if !a.human, liveText.hasPrefix(historyText) {
                assistantMatched = true
                liveText = String(liveText.dropFirst(historyText.count))
                    .trimmingCharacters(in: .newlines)
                replacements[b.index] = liveText
                h += 1
                if h < saved.count { historyText = saved[h].text }
            } else if !a.human, historyText.hasPrefix(liveText) {
                assistantMatched = true
                historyText = String(historyText.dropFirst(liveText.count))
                    .trimmingCharacters(in: .newlines)
                replacements[b.index] = ""
                l += 1
                if l < live.count { liveText = live[l].text }
            } else {
                return nil
            }
        }
        // A confirmed, fully matching, dated head can already be in the file
        // while the agent has only called tools. Waiting for assistant prose
        // drew the same question twice for the whole tool-only part of a turn.
        // Keep the forward-only runtime window from sameHuman; an older prompt,
        // an unconfirmed echo or a truncated shared prefix is not proof.
        // The same holds for a run of such questions: a message sent while
        // the agent was still only calling tools (16.10.2026) made the turn
        // two questions with no prose, and the whole live turn was drawn again
        // under the saved one. Every question in the run must be confirmed and
        // dated, and the run must reach the latest saved question.
        let datedConfirmedRun = live[0].human && humansDated && lastHuman.map { h > $0 } == true
        guard assistantMatched || datedConfirmedRun else { return nil }
        // An earlier matching exchange is not the current replay unless the
        // match also reaches the latest human turn in the saved transcript.
        if live[0].human, let lastHuman, h <= lastHuman { return nil }
        // Machinery is not text-identifiable: keep its details rather than
        // guessing that two identical commands were the same invocation.
        return replacements
    }

    private func sameHuman(_ saved: Speech, _ live: Speech) -> Bool {
        guard saved.images == live.images else { return false }
        if live.truncated {
            guard !live.text.isEmpty, saved.text.hasPrefix(live.text) else { return false }
        } else if saved.text != live.text { return false }
        if let fileTime = saved.ts, let sentTime = live.ts {
            if live.confirmed {
                // The runtime can persist AFTER hub delivery (notably Codex).
                // An older same-word prompt may be a different turn/steer;
                // don't widen backwards and erase that new turn on a guess.
                guard fileTime >= sentTime, fileTime - sentTime <= 30_000 else { return false }
            } else if abs(fileTime - sentTime) > 5_000 { return false }
        } else if live.truncated {
            // A shared 16 KiB prefix alone never proves turn identity.
            return false
        }
        return true
    }
}
