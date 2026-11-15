import SwiftUI
import CCRemoteKit

/// Presentation rows retain message identity while each run of machinery rides
/// the prose that frames it — a port of `attachRuns` / `attachLiveRuns` in
/// web/src/render/Blocks.tsx (009732c, 04.10.2026). History and the live tail
/// share one pass.
struct TranscriptRow: Identifiable, Equatable {
    enum Content: Equatable {
        case day(String)
        case history(HistoryMessage, Bool)
        case live(TranscriptLine, Bool)
        case progress
        case activity
        /// «Что сделано» — итог законченного хода, после его последней записи.
        case recap(TurnRecapData)
    }
    let id: String
    let content: Content
    var earlier: [TranscriptRow] = []
    var blocks: [RenderBlock] = []
    var lines: [TranscriptLine] = []
    var activityCount: Int {
        blocks.filter { if case .toolUse = $0 { return true }; return false }.count
            + lines.filter { $0.kind == .tool_use }.count
    }
    var hasActivity: Bool { !blocks.isEmpty || !lines.isEmpty }
}

/// Machinery belongs to the prose that frames it, not to the exchange as a
/// whole. «Запушено. Проверяю, что осталось…» ANNOUNCES the commands after it,
/// so a run folds onto the PRECEDING agent paragraph first; a run with nothing
/// of the agent's behind it (it opened the exchange) folds onto the FOLLOWING
/// paragraph; a run with agent prose on neither side stays a row of its own.
/// Either way the gear sits at the END of the paragraph — a paragraph carries
/// at most one, the runs it reports on and the run it announced together.
///
/// Until 06.10.2026 iOS hung every run of the exchange on its LAST paragraph,
/// so a finished answer ended in «⚙ 23» while the web showed none there: the
/// summary had run nothing, the paragraphs above it had.
///
/// The history/live seam is not a boundary: a history that ends in a run and a
/// tail that opens with one are the same stretch of work, so the two fold into
/// one gear instead of «⚙ 5» over «⚙ 11» (web d6d2646).
///
/// `recaps` — после каждого законченного хода с действиями встаёт строка «Что
/// сделано» (web c80e7c7f). Выключено по умолчанию: зеркало и лист помощника
/// её не показывают.
func transcriptRows(history: [TranscriptItem], live: [LiveTranscriptItem] = [], busy: Bool = false,
                    recaps: Bool = false) -> [TranscriptRow] {
    var seen = Set<String>()
    return buildTranscriptRows(history: history[...], live: live[...], busy: busy, recaps: recaps, seen: &seen)
}

/// Один проход `transcriptRows` по срезу. `seen` — id вызовов, уже учтённых «Что сделано»
/// (вызов, который держит и история, и переигровка, — один шаг): приходит от предыдущего
/// куска и уходит со своим пополнением. Срез должен начинаться на границе хода
/// (сообщение человека) или быть всем транскриптом — так же его режет `TranscriptRowsMemo`.
private func buildTranscriptRows(history: ArraySlice<TranscriptItem>, live: ArraySlice<LiveTranscriptItem>,
                                 busy: Bool, recaps: Bool, seen: inout Set<String>) -> [TranscriptRow] {
    enum Entry {
        case row(TranscriptRow)
        case run(id: String, blocks: [RenderBlock], lines: [TranscriptLine])
    }
    var entries: [Entry] = []
    func addRun(_ id: String, blocks: [RenderBlock] = [], lines: [TranscriptLine] = []) {
        if case let .run(prevId, prevBlocks, prevLines)? = entries.last {
            entries[entries.count - 1] = .run(id: prevId, blocks: prevBlocks + blocks, lines: prevLines + lines)
        } else {
            entries.append(.run(id: id, blocks: blocks, lines: lines))
        }
    }
    for item in history {
        switch item {
        case let .dayDivider(_, label):
            entries.append(.row(TranscriptRow(id: item.id, content: .day(label))))
        case let .message(message, cont):
            entries.append(.row(TranscriptRow(id: item.id, content: .history(message, cont))))
        case let .toolRun(_, run):
            addRun(item.id, blocks: run)
        }
    }
    for item in live {
        switch item {
        case let .line(line, cont):
            entries.append(.row(TranscriptRow(id: item.id, content: .live(line, cont))))
        case let .toolRun(_, run, _):
            addRun(item.id, lines: run)
        }
    }

    func speaks(_ row: TranscriptRow) -> Bool {
        switch row.content {
        case let .history(m, _): return m.role == .assistant && !isPicture(m)
        case let .live(l, _): return l.kind == .assistant
        default: return false
        }
    }
    // Consecutive runs were merged above, so a row can take at most one run
    // from each side — the web's `runAfter` / `runBefore` slots — without
    // having to track which slot is already full.
    var rows: [TranscriptRow] = []
    var pendingBefore: (blocks: [RenderBlock], lines: [TranscriptLine])?
    // Какая строка несёт каждую запись: итог хода встаёт после неё.
    var carriers: [String?] = Array(repeating: nil, count: entries.count)
    for (i, entry) in entries.enumerated() {
        switch entry {
        case var .row(row):
            if let before = pendingBefore {
                row.blocks = before.blocks + row.blocks
                row.lines = before.lines + row.lines
                pendingBefore = nil
            }
            rows.append(row)
            carriers[i] = row.id
        case let .run(id, blocks, lines):
            if let last = rows.indices.last, speaks(rows[last]) {
                rows[last].blocks += blocks
                rows[last].lines += lines
                carriers[i] = rows[last].id
                continue
            }
            if i + 1 < entries.count, case let .row(next) = entries[i + 1], speaks(next) {
                pendingBefore = (blocks, lines)
                carriers[i] = next.id
                continue
            }
            // A truncated transcript can hold tools and no prose; a run can
            // follow a human turn the agent has not answered yet. Keep it
            // reachable as its own row until prose arrives to carry it.
            rows.append(TranscriptRow(id: id, content: .activity, blocks: blocks, lines: lines))
            carriers[i] = id
        }
    }
    let folded = foldProgress(rows, busy: busy)
    guard recaps else { return folded }
    // A call the history holds and the live replay repeats (mid-turn attach)
    // is one step, not two: keyed by its tool-use id.
    var seenCalls = seen
    let out = withRecaps(folded, entries: entries.enumerated().compactMap { i, entry -> (id: String, item: RecapItem)? in
        guard let id = carriers[i] else { return nil }
        switch entry {
        case let .row(row): return recapItem(row).map { (id: id, item: $0) }
        case let .run(_, blocks, lines): return (id: id, item: .run(calls: recapCalls(blocks: blocks, lines: lines, seen: &seenCalls)))
        }
    }, busy: busy)
    seen = seenCalls
    return out
}

/// `transcriptRows` для экрана, который пересобирает строки на каждую дельту стрима.
///
/// Ход, оканчивающийся сообщением человека, больше не меняется: «Ход работы»,
/// «Что сделано», склейка механики с прозой считаются внутри хода и не смотрят
/// через границу. Поэтому всё ДО последнего сообщения человека (история и, если там
/// есть, старые живые строки) собирается один раз и лежит, пока те же входы; на каждую
/// дельту пересобирается только текущий ход с настоящим `busy`. Результат совпадает с
/// `transcriptRows` на тех же входах (`TranscriptRowsMemoTests`).
///
/// Ссылочный тип в `@State`: переживает пересчёт body, сам за собой SwiftUI не следит.
final class TranscriptRowsMemo {
    private struct Prefix {
        let history: [TranscriptItem]
        let live: [LiveTranscriptItem]
        let historyCut: Int
        let recaps: Bool
        let rows: [TranscriptRow]
        let seen: Set<String>
    }
    private var prefix: Prefix?

    func rows(history: [TranscriptItem], live: [LiveTranscriptItem], busy: Bool, recaps: Bool) -> [TranscriptRow] {
        guard let cut = Self.cut(history: history, live: live) else {
            prefix = nil
            return transcriptRows(history: history, live: live, busy: busy, recaps: recaps)
        }
        let liveHead = Array(live[..<cut.live])
        let kept: Prefix
        if let cached = prefix, cached.recaps == recaps, cached.historyCut == cut.history,
           cached.history == history, cached.live == liveHead {
            kept = cached
        } else {
            var seen = Set<String>()
            // Не хвост: за этим ходом идёт сообщение человека, он закончен — `busy: false`.
            let rows = buildTranscriptRows(history: history[..<cut.history], live: live[..<cut.live],
                                           busy: false, recaps: recaps, seen: &seen)
            kept = Prefix(history: history, live: liveHead, historyCut: cut.history,
                          recaps: recaps, rows: rows, seen: seen)
            prefix = kept
        }
        var seen = kept.seen
        return kept.rows + buildTranscriptRows(history: history[cut.history...], live: live[cut.live...],
                                               busy: busy, recaps: recaps, seen: &seen)
    }

    /// Сколько записей истории и живых строк лежит ДО последнего сообщения человека.
    /// nil — человека нет или он первый: резать нечего.
    private static func cut(history: [TranscriptItem], live: [LiveTranscriptItem]) -> (history: Int, live: Int)? {
        if let j = live.lastIndex(where: { item in
            if case let .line(line, _) = item { return line.kind == .user }
            return false
        }) {
            return (history.count, j)
        }
        if let i = history.lastIndex(where: { item in
            if case let .message(message, _) = item { return message.role == .user }
            return false
        }), i > 0 {
            return (i, 0)
        }
        return nil
    }
}

/// A message that is only a picture the agent drew (`groupHistory` makes one per picture).
private func isPicture(_ message: HistoryMessage) -> Bool {
    guard message.blocks.count == 1, case .generatedImage = message.blocks[0] else { return false }
    return true
}

private func recapItem(_ row: TranscriptRow) -> RecapItem? {
    switch row.content {
    case let .history(m, _): return m.role == .user ? .human(ts: m.ts) : .speech(ts: m.ts)
    case let .live(l, _): return l.kind == .user ? .human(ts: l.ts) : .speech(ts: l.ts)
    default: return nil
    }
}

private func recapCalls(blocks: [RenderBlock], lines: [TranscriptLine], seen: inout Set<String>) -> [RecapCall] {
    var calls: [RecapCall] = []
    for block in blocks {
        if case let .toolUse(id, name, input) = block {
            if !id.isEmpty, !seen.insert(id).inserted { continue }
            calls.append(.block(name: name, input: input))
        }
    }
    for line in lines where line.kind == .tool_use {
        if let id = line.toolUseId, !id.isEmpty, !seen.insert(id).inserted { continue }
        calls.append(.line(line.text))
    }
    return calls
}

/// Строка «Что сделано» — сразу после последней записи своего хода.
private func withRecaps(_ rows: [TranscriptRow], entries: [(id: String, item: RecapItem)], busy: Bool) -> [TranscriptRow] {
    let done = turnRecaps(entries, busy: busy)
    if done.isEmpty { return rows }
    var out: [TranscriptRow] = []
    for row in rows {
        out.append(row)
        if let data = done[row.id] {
            out.append(TranscriptRow(id: "recap-" + row.id, content: .recap(data)))
        }
    }
    return out
}

/// Only completed work with several updates and actual tool activity folds.
/// A plain multi-message answer remains fully visible, as does a running tail.
private func foldProgress(_ rows: [TranscriptRow], busy: Bool) -> [TranscriptRow] {
    var result: [TranscriptRow] = []
    var turn: [TranscriptRow] = []
    // A drawn picture is the answer itself: never folded into «Ход работы»,
    // never counted as one of its paragraphs.
    func assistant(_ row: TranscriptRow) -> Bool {
        switch row.content {
        case let .history(m, _): return m.role == .assistant && !isPicture(m)
        case let .live(l, _): return l.kind == .assistant
        default: return false
        }
    }
    func flush(tail: Bool) {
        let prose = turn.indices.filter { assistant(turn[$0]) }
        // Each paragraph carries its own run now, so the turn did work when ANY
        // of it did — the summary at the end usually ran nothing itself.
        if (!tail || !busy), prose.count >= 3,
           let last = prose.last, turn.contains(where: \.hasActivity) {
            let hidden = Array(turn[..<last]).filter(assistant)
            let hiddenIds = Set(hidden.map(\.id))
            var emitted = false
            for row in turn {
                if hiddenIds.contains(row.id) {
                    if !emitted {
                        result.append(TranscriptRow(id: "progress-" + hidden[0].id,
                                                    content: .progress, earlier: hidden))
                        emitted = true
                    }
                } else { result.append(row) }
            }
        } else { result.append(contentsOf: turn) }
        turn = []
    }
    for row in rows {
        let boundary: Bool
        switch row.content {
        case .day: boundary = true
        case let .history(m, _): boundary = m.role == .user
        case let .live(l, _): boundary = l.kind == .user || l.kind == .error
        default: boundary = false
        }
        if boundary { flush(tail: false); result.append(row) }
        else { turn.append(row) }
    }
    flush(tail: true)
    return result
}

struct TranscriptRowView: View, Equatable {
    let row: TranscriptRow
    let agent: String
    let human: String
    @State private var expanded = false
    @State private var showActivity = false
    @Environment(\.openURL) private var openURL

    /// Строка перерисовывается, только когда изменилась она сама, агент или имя
    /// читателя: `.equatable()` в `ChatView` не даёт дельте стрима перестраивать
    /// body каждой смонтированной строки. @State (раскрыто, лист действий)
    /// инвалидирует body независимо от этого сравнения.
    static func == (a: TranscriptRowView, b: TranscriptRowView) -> Bool {
        a.row == b.row && a.agent == b.agent && a.human == b.human
    }

    /// Ссылка «⚙ N» этой строки. Выводится из id строки, а не из `UUID()` в
    /// инициализаторе @State: тот выполнялся на каждый init каждой строки при каждой
    /// дельте стрима, а устойчивая ссылка ещё и не даёт `MessageView ==` видеть «новый» URL.
    private var activityURL: URL {
        let id = row.id.addingPercentEncoding(
            withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? "row"
        return URL(string: "ccremote-activity://details/\(id)") ?? URL(string: "ccremote-activity://details/row")!
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
            // Помощники, которых запустила механика этого абзаца, — под ним,
            // там же, где его шестерёнка (веб: `SubagentCards` в `run-row-wrap`).
            let calls = row.agentCalls
            if !calls.isEmpty {
                SubagentCards(calls: calls).padding(.bottom, Theme.s1)
            }
        }
            .environment(\.openURL, OpenURLAction { url in
                guard row.hasActivity, url == activityURL else {
                    openURL(url)
                    return .handled
                }
                showActivity = true
                return .handled
            })
            .sheet(isPresented: $showActivity) {
                NavigationStack {
                    ScrollView { activityDetails.padding(Theme.s4) }
                        .background(Theme.bg)
                        .navigationTitle("Действия")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                SheetCloseButton { showActivity = false }
                                    .accessibilityIdentifier("toolActivity.done")
                            }
                        }
                }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
    }

    @ViewBuilder private var content: some View {
        switch row.content {
        case let .day(label): TranscriptDivider(label: label)
        case let .history(message, cont):
            MessageView(msg: message, cont: cont, agent: agent, human: human,
                        activityURL: row.hasActivity ? activityURL : nil, activityCount: row.activityCount).equatable()
        case let .live(line, cont):
            LiveLineView(line: line, cont: cont, agent: agent, human: human,
                         activityURL: row.hasActivity ? activityURL : nil, activityCount: row.activityCount)
        case .progress:
            VStack(alignment: .leading, spacing: 0) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        Text("Ход работы · \(row.earlier.count)")
                    }
                    .font(.system(size: 13)).foregroundStyle(Theme.textMuted)
                    .frame(minHeight: 32).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("transcript.progress")
                if expanded {
                    ForEach(row.earlier) { earlier in
                        // Type erasure ends the recursive SwiftUI body type.
                        AnyView(TranscriptRowView(row: earlier, agent: agent, human: human))
                    }
                }
            }
            .padding(.top, Theme.s3)
        case .activity:
            activity.frame(maxWidth: .infinity, alignment: .trailing)
        case let .recap(data):
            TurnRecapView(data: data)
        }
    }

    private var activity: some View {
        let count = row.activityCount
        return CollapsibleRow(mark: count) {
            Image(systemName: "gearshape")
                .font(.system(size: 12)).foregroundStyle(Theme.textFaint)
        } label: {
            Text(count > 0 ? actionCount(count) : "Действия")
                .font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.textMuted)
        } content: {
            activityDetails
        }
    }

    private var activityDetails: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            let count = row.activityCount
            Text(count > 0 ? actionCount(count) : "Действия")
                .font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.textMuted)
            ForEach(Array(row.blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
            ForEach(row.lines) { line in LiveLineView(line: line) }
        }
    }
}
