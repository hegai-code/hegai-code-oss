import Foundation
import CCRemoteKit

// The transcript as ONE document — port of `groupHistory` / `groupLive` in
// web/src/render/Blocks.tsx (518bbc7) with the day marks the web computes in a
// second pass (`dayMarks` in panels/Chat.tsx) folded into the same walk. Both
// the live ChatView and the read-only MirrorView regroup through here, so the
// two never disagree about what a turn is.
//
// Grouping preserves source order; transcriptRows attaches the accumulated
// machinery to the last spoken message of each human/assistant exchange.

// MARK: - Items

/// One row of the regrouped history.
enum TranscriptItem: Identifiable, Equatable {
    /// A calendar-day boundary («сегодня», «вчера», «14 авг», «14 авг 2025»).
    case dayDivider(id: String, label: String)
    /// A spoken turn. `cont` = the same speaker continuing on the same day: no
    /// header, no top rule — it reads as the next paragraph. It is NOT part of
    /// the identity, so a turn whose `cont` flips does not get recreated.
    case message(HistoryMessage, cont: Bool)
    /// Machinery between two pieces of prose, folded into one row however many
    /// messages it spanned.
    case toolRun(id: String, blocks: [RenderBlock])

    var id: String {
        switch self {
        case let .dayDivider(id, _): return "d-\(id)"
        case let .message(m, _): return "m-\(m.uuid)"
        case let .toolRun(id, _): return "r-\(id)"
        }
    }
}

/// One row of the regrouped live tail.
enum LiveTranscriptItem: Identifiable, Equatable {
    case line(TranscriptLine, cont: Bool)
    /// Identity must NOT include the line count: the tail group grows as the
    /// run works, and a changing identity would recreate the row and slam it
    /// shut while the user is reading the expanded list.
    case toolRun(id: Int, lines: [TranscriptLine], isTail: Bool)

    var id: String {
        switch self {
        case let .line(l, _): return "l-\(l.id)"
        case let .toolRun(id, _, _): return "lr-\(id)"
        }
    }
}

// MARK: - Speakers

/// The name shown on an agent's turns — Codex sessions are answered by Codex,
/// and labelling them «Claude» is simply wrong. Mirrors `agentName` in
/// web/src/lib.ts.
func agentName(_ source: String?) -> String {
    source == "codex" ? "Codex" : "Claude"
}

private enum Speaker { case user, assistant }

// MARK: - Block hygiene

/// Drop what renders as an empty box, and clean what renders as noise. Agents
/// strip harness plumbing at the source now, but the hub already holds months
/// of transcripts with it inline, so the reader still needs this guard — see
/// `stripHarnessNoise`.
func cleanBlocks(_ blocks: [RenderBlock]) -> [RenderBlock] {
    blocks.compactMap { block in
        switch block {
        case let .text(text):
            let clean = stripHarnessNoise(text)
            return clean.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : .text(clean)
        case let .thinking(text):
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : block
        case let .toolResult(_, text, isError):
            // An empty result that failed still matters — the error is the signal.
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isError ? nil : block
        default:
            return block
        }
    }
}

/// Tool calls, their results and thinking: the runtime talking, never a person.
func isMechanical(_ block: RenderBlock) -> Bool {
    switch block {
    case .toolUse, .toolResult, .thinking: return true
    default: return false
    }
}

/// A message that carries only machinery — a user message of tool results is
/// the runtime's output, not a human turn.
func isServiceOnly(_ blocks: [RenderBlock]) -> Bool {
    !blocks.isEmpty && blocks.allSatisfy(isMechanical)
}

/// A live line is machinery when it is a tool call, or the long stdout echo
/// Codex writes through the `status` channel after every command. Without the
/// second half, that echo split every run of commands apart and printed itself
/// in full — a screen of grep output between two sentences. Actionable short
/// statuses stay visible; routine resume notices are removed by groupLive.
func isMachineryLine(_ l: TranscriptLine) -> Bool {
    // A picture being drawn is what the person asked for, not backstage.
    if l.imageGen != nil { return false }
    if l.kind == .tool_use { return true }
    // The run's backstage, not the reading (web BACKSTAGE_CODES, 04.10.2026):
    // a tool the CLI refused («Bash не выполнен — запрещено правилом…»), the
    // CLI's own notices, its stderr and command echoes — and a Codex reasoning
    // summary, short or long. They open inside the gear; what needs the
    // person (rate limit, failed turn, «остановлено») stays a line.
    if l.kind == .status, let code = l.code, backstageCodes.contains(code) { return true }
    if l.kind == .status, l.text.hasPrefix("💭") { return true }
    if l.kind == .status || l.kind == .result {
        let last = l.text.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n").last ?? ""
        if last == "→ completed" || last == "→ failed" || last == "→ interrupted" { return true }
    }
    return (l.kind == .status || l.kind == .result) && statusFolds(l.text)
}

/// Status codes that are machinery wherever they appear — see `isMachineryLine`.
let backstageCodes: Set<String> = ["stderr", "command_output", "permission_denied", "notification"]

// MARK: - History

/// The transcript regrouped at BLOCK level: the answer's prose is what the
/// reader came for, so between any two pieces of prose EVERYTHING mechanical —
/// tool calls embedded in mixed assistant turns, whole tool-result messages,
/// thinking — folds into exactly ONE service row, however many messages it
/// spans. (Message-level grouping fragmented the moment a turn carried text +
/// tools: every turn drew its own capsule.)
///
/// Consecutive same-speaker turns CONTINUE each other: the second drops its
/// header and top rule and reads as the next paragraph. A run never breaks a
/// merge (machinery between two paragraphs is still the same person talking);
/// a change of speaker or of calendar day does — and the day change is also
/// where the divider goes, so a divider never sits above a continued turn.
/// A turn without a timestamp neither moves the day nor forgets it; a history
/// with no timestamps at all degrades to speaker-only merging and no dividers.
func groupHistory(_ history: [HistoryMessage],
                  now: Date = Date(),
                  calendar: Calendar = .current) -> [TranscriptItem] {
    var out: [TranscriptItem] = []
    var run: [RenderBlock] = []
    var runId = ""
    var runSeq = 0
    var lastSpeaker: Speaker?
    /// Calendar day of the last timed turn — the day the reader is "in".
    var day: Int?

    func flushRun() {
        guard !run.isEmpty else { return }
        out.append(.toolRun(id: runId, blocks: run))
        run = []
    }
    func push(_ msg: HistoryMessage, as speaker: Speaker) {
        var newDay = false
        if let ts = msg.ts {
            let key = TurnTime.dayKey(ts, calendar: calendar)
            if key != day {
                day = key
                newDay = true
                out.append(.dayDivider(id: msg.uuid,
                                       label: TurnTime.dayLabel(ts, now: now, calendar: calendar)))
            }
        }
        out.append(.message(msg, cont: speaker == lastSpeaker && !newDay))
        lastSpeaker = speaker
    }

    for msg in history {
        // `system` turns are hook output and CLI caveats, not conversation.
        if msg.role == .system { continue }
        let blocks = cleanBlocks(msg.blocks)
        // A turn left with nothing after the cleanup is skipped outright — and,
        // having said nothing, it does not break the chain around it either.
        if blocks.isEmpty { continue }
        // A human turn renders whole (text + attachments) and hard-flushes; a
        // user message carrying only machinery is the runtime talking.
        if msg.role == .user && !blocks.allSatisfy(isMechanical) {
            flushRun()
            push(HistoryMessage(role: msg.role, uuid: msg.uuid, blocks: blocks, ts: msg.ts), as: .user)
            continue
        }
        var prose: [RenderBlock] = []
        var proseIdx = 0
        var pictureIdx = 0
        func flushProse() {
            guard !prose.isEmpty else { return }
            // Prose reaching this loop is always assistant-authored: a user
            // message with a text block took the branch above. The split pieces
            // keep the message's own timestamp — the second paragraph of one
            // answer was written when the answer was.
            push(HistoryMessage(role: msg.role, uuid: "\(msg.uuid)-p\(proseIdx)", blocks: prose, ts: msg.ts),
                 as: .assistant)
            proseIdx += 1
            prose = []
        }
        for block in blocks {
            if case .generatedImage = block {
                // A picture the agent drew is a turn of its own, in place: not
                // machinery for the step list, not a paragraph to merge.
                flushProse()
                flushRun()
                push(HistoryMessage(role: msg.role, uuid: "\(msg.uuid)-g\(pictureIdx)", blocks: [block], ts: msg.ts),
                     as: .assistant)
                pictureIdx += 1
            } else if case .text = block {
                flushRun()
                prose.append(block)
            } else {
                flushProse()
                // A run id stays unique even when one message opens two runs
                // (tools → text → tools), so it carries a sequence.
                if run.isEmpty { runId = "\(msg.uuid)-\(runSeq)"; runSeq += 1 }
                run.append(block)
            }
        }
        flushProse()
    }
    flushRun()
    return out
}

// MARK: - Live tail

/// The live twin of `groupHistory`: consecutive machinery folds into one row,
/// `system` lines (init/model noise) drop outright. Continuation mirrors
/// history: an assistant line straight after another assistant line —
/// machinery in between never breaks it, any other spoken line does — merges
/// into the same flowing turn. A user line never continues anything. There are
/// no day dividers here: the tail is written now, and the «продолжение» seam
/// above it already says where the file ends and the stream begins.
func groupLive(_ lines: [TranscriptLine]) -> [LiveTranscriptItem] {
    var out: [LiveTranscriptItem] = []
    var run: [TranscriptLine] = []
    var lastSpeech: TranscriptLine.Kind?
    func flush(isTail: Bool) {
        guard !run.isEmpty else { return }
        out.append(.toolRun(id: run[0].id, lines: run, isTail: isTail))
        run = []
    }
    for raw in lines {
        if raw.kind == .system { continue }
        // The client adds this on every resume. It is transport bookkeeping,
        // including in restored tails, rather than another conversation turn.
        if raw.kind == .status,
           raw.text.trimmingCharacters(in: .whitespacesAndNewlines) == "session resumed" { continue }
        var l = raw
        let machinery = isMachineryLine(l)
        if l.kind == .status || l.kind == .result {
            let value = l.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if ["→ completed", "completed", "done"].contains(value) { continue }
            if value.hasSuffix("\n→ completed") {
                l.text = String(value.dropLast("\n→ completed".count))
            }
        }
        // Empty stream boundaries are not messages. Like history, strip harness
        // noise before grouping so invisible prose cannot split tool activity.
        if l.kind == .assistant || l.kind == .user {
            l.text = stripHarnessNoise(l.text)
        }
        if l.kind != .tool_use, l.imageGen == nil,
           l.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           l.images.isEmpty { continue }
        if machinery {
            run.append(l)
        } else {
            flush(isTail: false)
            out.append(.line(l, cont: l.kind == .assistant && lastSpeech == .assistant))
            lastSpeech = l.kind
        }
    }
    flush(isTail: true)
    return out
}

// MARK: - Memo

/// Regrouping is a full walk over the transcript; a view's body runs on every
/// streamed token. This caches the last result and hands it back for as long
/// as the input is the same array — `Array ==` short-circuits on shared storage,
/// so the common case is a pointer compare, not two thousand messages.
///
/// A reference type held in `@State` on purpose: it must survive body
/// re-evaluation without itself being state SwiftUI watches.
final class TranscriptMemo {
    private var input: [HistoryMessage] = []
    private var output: [TranscriptItem] = []
    private var valid = false

    func items(for history: [HistoryMessage],
               now: Date = Date(),
               calendar: Calendar = .current) -> [TranscriptItem] {
        if valid && history == input { return output }
        input = history
        output = groupHistory(history, now: now, calendar: calendar)
        valid = true
        return output
    }

    /// Force the next `items(for:)` to recompute — the day labels are relative
    /// («сегодня» becomes «вчера» at midnight) even when the messages are not.
    func invalidate() { valid = false }
}
