import SwiftUI
import CCRemoteKit

/// Ворота перед `ChatView`. Хост перестраивается на чужие кадры (инвентарь, статистика) и
/// каждый раз отдаёт новые замыкания; сравнение их не видит. Экран не перерисовывается, пока
/// не изменились значения и наличие обработчиков. Его собственные подписки на `client`
/// (строки стрима, busy) работают независимо от этого сравнения.
///
/// **`==` живёт здесь, а не на `ChatView`, и это не косметика.** SwiftUI решает, заменять
/// ли замыкание `GeometryReader`/`ScrollViewReader`, сравнивая захваченное в нём, и для
/// захваченного `Equatable` зовёт его `==`. Будь `==` на самом `ChatView` (без @State в
/// сравнении), замыкание с захваченным `self` считалось бы тем же при любой смене его
/// @State: тело шло, а лента внутри оставалась на старом снимке состояния. Так с 24.10 по
/// 06.11.2026 «Показать более ранние» и стрелка «вниз» не срабатывали, пока ChatView
/// не получал новых значений от хоста (`TranscriptEarlierUITests`).
struct ChatViewGate: View, Equatable {
    let chat: ChatView

    static func == (x: ChatViewGate, y: ChatViewGate) -> Bool {
        let a = x.chat, b = y.chat
        return a.history == b.history && a.loadingHist == b.loadingHist && a.historyFailed == b.historyFailed
            && a.waitingForSession == b.waitingForSession && a.agent == b.agent
            && a.humanOverride == b.humanOverride && a.answerCompleted == b.answerCompleted
            && a.canLoadEarlier == b.canLoadEarlier && a.loadingEarlier == b.loadingEarlier
            && a.subagentScope == b.subagentScope
            && (a.onRetryHistory == nil) == (b.onRetryHistory == nil)
            && (a.onContinue == nil) == (b.onContinue == nil)
            && (a.onLoadEarlier == nil) == (b.onLoadEarlier == nil)
    }

    var body: some View { chat }
}

/// The chat transcript: history backlog (block-rendered) + the live streaming
/// tail, read as ONE document — same-speaker turns merge into paragraphs, days
/// are marked, every turn is timed (see `TranscriptGrouping.swift`). Ports the
/// render half of web/src/panels/Chat.tsx. The streaming assistant line renders
/// as plain `Text` (cheap, re-drawn per chunk); a finalized assistant line
/// renders as themed markdown.
struct ChatView: View {
    let history: [HistoryMessage]
    let loadingHist: Bool
    /// The read failed and nothing is shown: say so and offer to ask again.
    var historyFailed: Bool = false
    /// The session has not reached the machine's list yet; history follows.
    var waitingForSession: Bool = false
    var onRetryHistory: (() -> Void)? = nil
    /// Which runtime answers in this session — the name on its turns.
    var agent: String = "Claude"
    /// The reader's own name, overriding the profile. Only the DEBUG transcript
    /// fixture passes it; everything else reads `client.viewer`.
    var humanOverride: String? = nil
    // The suggestion strip is not here: since 13.10.2026 it is pinned above the
    // composer by the host (`EnrichStrip`, mounted next to `ComposerView`).
    var answerCompleted: Bool = false
    var onContinue: (() -> Void)? = nil
    /// Транскрипт показан не с начала — есть что догрузить сверху.
    var canLoadEarlier: Bool = false
    /// Догрузка идёт прямо сейчас.
    var loadingEarlier: Bool = false
    var onLoadEarlier: (() -> Void)? = nil
    /// Whose sub-agents these are and who may stop them. Nil = the followed
    /// run's, read-only and without a transcript to open (a new chat that has
    /// no session address yet).
    var subagentScope: SubagentScope? = nil
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @State private var subagentMemo = SubagentHistoryMemo()
    @State private var openAgent: SubagentTarget?
    /// Helpers a «Стоп» tap asked to stop, held until the person confirms: a
    /// stopped helper cannot be resumed, and a stray tap killed one on
    /// 23.10.2026. «Остановить все» fills it with every row in one go.
    @State private var pendingStops: [String] = []

    private let bottomAnchor = "chat-bottom"

    /// Following is explicit reader intent; layout changes cannot detach it.
    @State private var scroll = TranscriptScrollState()
    private var atBottom: Bool { scroll.atBottom }

    /// Regrouped history, recomputed only when the array actually changes.
    @State private var memo = TranscriptMemo()
    /// Rows of everything before the current turn, built once; see `TranscriptRowsMemo`.
    @State private var rowsMemo = TranscriptRowsMemo()
    @State private var reconciler = TranscriptReconciler()
    /// Bumped at local midnight so «сегодня» becomes «вчера» without a reload.
    @State private var dayTick = 0
    @State private var window = TranscriptWindow()
    /// Сколько раз для «оригинала» из ленты уже просили догрузить историю.
    @State private var anchorSteps = 0

    private struct BottomGapKey: PreferenceKey {
        static let defaultValue: CGFloat? = nil
        static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
            if let next = nextValue() { value = next }
        }
    }

    var body: some View {
        GeometryReader { viewport in
        ScrollViewReader { proxy in
            ScrollView {
                // Spacing is 0 on purpose: each row owns its vertical rhythm, so a
                // continued paragraph can sit tight under its predecessor while a
                // new entry keeps its seam. The column is capped at the reading
                // measure so a wide iPad doesn't stretch turns across the screen.
                VStack(alignment: .leading, spacing: 0) {
                    let _ = dayTick
                    if loadingHist {
                        statusText("loading history…").padding(.vertical, Theme.s2)
                    } else if historyFailed, history.isEmpty, client.lines.isEmpty {
                        HistoryFailedRow(onRetry: onRetryHistory)
                    } else if waitingForSession, history.isEmpty, client.lines.isEmpty {
                        statusText("Сессия ещё синхронизируется — история появится сама.")
                            .padding(.vertical, Theme.s2)
                            .accessibilityIdentifier("history.waiting")
                    }
                    let items = memo.items(for: history)
                    let lines = reconciler.reconcile(history: history, lines: client.lines)
                    let human = humanOverride ?? SpeakerName.human(client.viewer)
                    let live = groupLive(lines)
                    // A dropped socket clears `busy` but keeps the turn's progress
                    // (`suspendProgress`): the turn is not finished by a blink.
                    let rows = rowsMemo.rows(history: items, live: live,
                                             busy: client.busy || client.turnProgress != nil, recaps: true)
                    // One id pass per body: it fed four separate `rows.map(\.id)` before.
                    let ids = rows.map(\.id)
                    let first = window.startIndex(in: ids)
                    if first > 0 {
                        HistoryMoreButton(loading: false) {
                            scroll.detach()
                            let anchor = rows[first].id
                            window.revealEarlier(in: ids)
                            Task { @MainActor in
                                await Task.yield()
                                // По центру: в верхней половине экрана сразу видно то, что
                                // открылось. С `.top` экран выглядел как до нажатия.
                                proxy.scrollTo(anchor, anchor: .center)
                            }
                        }
                        .accessibilityIdentifier("history.earlierLocal")
                    } else if canLoadEarlier, let onLoadEarlier {
                        HistoryMoreButton(loading: loadingEarlier) {
                            scroll.detach()
                            onLoadEarlier()
                        }
                    }
                    let agents = subagentAgents
                    let _ = subagentMemo.update(history)
                    ForEach(Array(rows.dropFirst(first))) { row in
                        TranscriptRowView(row: row, agent: agent, human: human)
                            .equatable()
                            .id(row.id)
                    }
                    .environment(\.subagents, subagentsContext(agents))
                    .onChange(of: rows.first?.id, initial: true) { _, _ in
                        window.retainStart(in: ids)
                    }
                    // New rows arrived while the reader sits at the tail and follows it:
                    // the mounted window stops growing with the stream. The bottom
                    // anchor holds the view still, so nothing visible moves.
                    .onChange(of: rows.count) { _, _ in
                        if scroll.followsTail && scroll.atBottom { window.trimToTail(in: ids) }
                    }
                    // The turn ended but the job did not: the agent withholds
                    // `result` while a background task lives. Name the task and
                    // its own clock instead of 25 minutes of «работает…».
                    // `near` — карточки в смонтированном окне: фоновый помощник,
                    // чья карточка уехала выше окна, остаётся строкой панели.
                    let panel = SubagentPanelRow.rows(
                        background: subagentScope?.fixtureBackground ?? (helperRunActive ? client.background : []), agents: agents,
                        anchored: subagentMemo.calls.union(SubagentCall.from(lines: lines).compactMap(\.toolUseId)),
                        near: Set(rows.dropFirst(first).flatMap(\.agentCalls).compactMap(\.toolUseId)))
                    if !panel.isEmpty {
                        TurnRow(speaker: nil) { SubagentPanel(rows: panel) }
                            .environment(\.subagents, subagentsContext(agents))
                    }
                    if client.busy && !client.waitingOnBackground {
                        let activity = WorkActivity.of(client.lines)
                        let work = TurnWork.of(lines: client.lines, history: history, activity: activity)
                        // Ждёт помощника переднего плана — работает его карточка
                        // выше, не эта. Помощник кончился или ушёл в фон, а новых
                        // строк ещё нет — сессия думает, а не «Работает помощник».
                        let helperRuns = agents.contains { $0.status == .running && $0.background != true }
                        if !(work.waitsOnHelper && helperRuns) {
                            TurnRow(speaker: nil) {
                                WorkingIndicator(progress: client.turnProgress,
                                                 activity: work.waitsOnHelper ? WorkActivity.thinking : activity,
                                                 work: work, model: workModel)
                            }
                        }
                    }
                    if answerCompleted {
                        TurnRow(speaker: nil) { TurnCompletionRow(onContinue: onContinue) }
                    }
                    Color.clear.frame(height: 1).id(bottomAnchor)
                        // «Оригинал» из ленты: встать на сообщение, как только оно
                        // есть среди строк. Строки приезжают после истории, а
                        // догрузка сверху меняет их число — на оба случая один разбор.
                        .onChange(of: rows.count, initial: true) { _, _ in
                            resolveMessageAnchor(ids: ids, proxy: proxy)
                        }
                        .onChange(of: loadingEarlier) { _, now in
                            if !now { resolveMessageAnchor(ids: ids, proxy: proxy) }
                        }
                        .onChange(of: router.pendingMessageAnchor?.uuid) { _, _ in
                            anchorSteps = 0
                            resolveMessageAnchor(ids: ids, proxy: proxy)
                        }
                }
                .background {
                    GeometryReader { content in
                        Color.clear.preference(key: BottomGapKey.self,
                            value: content.frame(in: .global).maxY - viewport.frame(in: .global).maxY)
                    }
                }
                .padding(.horizontal, Theme.s3)
                .padding(.vertical, Theme.s3)
                .frame(maxWidth: Theme.readingWidth)
                .frame(maxWidth: .infinity)
            }
            // Exact heights within a growing history window, with one native
            // scroll anchor. Never seek an estimated lazy offset during layout.
            .transcriptAnchor(following: scroll.followsTail)
            .unifiedScrollEdges()
            .scrollClipDisabled()
            .accessibilityIdentifier("chat.transcript")
            .simultaneousGesture(DragGesture(minimumDistance: 4)
                .onChanged { scroll.drag(dx: $0.translation.width, dy: $0.translation.height) }
                .onEnded { _ in scroll.endDrag() })
            .scrollDismissesKeyboard(.interactively)
            .dismissKeyboardOnTap()
            .onPreferenceChange(BottomGapKey.self) { gap in
                guard let gap else { return }
                let atTail = gap <= 60
                if atTail != scroll.atBottom { scroll.moved(gap: atTail ? 0 : 61) }
            }
            // Explicit user navigation is the only imperative seek.
            .overlay(alignment: .bottom) {
                if !atBottom {
                    ScrollToBottomButton {
                        scroll.follow()
                        withAnimation(Theme.ease) { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
                    }
                    .padding(.bottom, Theme.s1)
                    .transition(.opacity)
                }
            }
        }
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
            memo.invalidate()
            dayTick += 1
        }
        .task { if let target = subagentScope?.fixtureOpen { openAgent = target } }
        .sheet(item: $openAgent) { target in
            SubagentTranscriptSheet(target: target, running: agentRunning(target),
                                    load: { try await loadAgent(target) },
                                    onClose: { openAgent = nil })
        }
        .confirmationDialog(pendingStops.count > 1 ? "Остановить все фоновые задачи (\(pendingStops.count))?" : "Остановить помощника?",
                            isPresented: Binding(get: { !pendingStops.isEmpty },
                                                 set: { if !$0 { pendingStops = [] } }),
                            titleVisibility: .visible, presenting: pendingStops) { ids in
            Button("Остановить", role: .destructive) { ids.forEach(stopAgent) }
            Button("Не останавливать", role: .cancel) {}
        } message: { _ in
            Text("Продолжить его потом не получится.")
        }
    }

    // MARK: Scroll to a message (`Router.pendingMessageAnchor`)

    /// Most history pages we will pull for one jump before giving up quietly.
    private static let anchorStepLimit = 5

    /// The row that carries `uuid`. A message's prose is split into
    /// `m-<uuid>-p<N>` rows by `TranscriptGrouping`, so match the id and its pieces.
    private static func rowID(for uuid: String, in ids: [String]) -> String? {
        let exact = "m-\(uuid)"
        let piece = exact + "-p"
        return ids.first { $0 == exact || $0.hasPrefix(piece) }
    }

    /// One step of the jump the router asked for (`Router.pendingMessageAnchor`):
    /// scroll to the row if it is loaded, otherwise load earlier history and
    /// come back when the rows change. Gives up silently after a bound; a jump
    /// is a courtesy, never a reason to hold the reader.
    private func resolveMessageAnchor(ids: [String], proxy: ScrollViewProxy) {
        guard let anchor = router.pendingMessageAnchor,
              anchor.sessionId == subagentScope?.sessionId else { return }
        if let target = Self.rowID(for: anchor.uuid, in: ids), let at = ids.firstIndex(of: target) {
            router.pendingMessageAnchor = nil
            anchorSteps = 0
            scroll.detach()
            // The row may sit above the mounted window: widen it first.
            while at < window.startIndex(in: ids) {
                let before = window.startIndex(in: ids)
                window.revealEarlier(in: ids)
                if window.startIndex(in: ids) == before { break }
            }
            Task { @MainActor in
                // One beat for the layout of the rows just revealed.
                try? await Task.sleep(nanoseconds: 150_000_000)
                proxy.scrollTo(target, anchor: .top)
            }
            return
        }
        // Not among the rows. Wait while history is still arriving or loading.
        if loadingHist || loadingEarlier || ids.isEmpty { return }
        if canLoadEarlier, let onLoadEarlier, anchorSteps < Self.anchorStepLimit {
            anchorSteps += 1
            scroll.detach()
            onLoadEarlier()
        } else {
            router.pendingMessageAnchor = nil
            anchorSteps = 0
        }
    }

    // MARK: Sub-agents

    /// «Sonnet 5.5» под заголовком карточки работы; пусто, пока модель не известна.
    private var workModel: String? {
        guard let settings = client.runSettings,
              let id = ModelLabel.explicit(settings.model) ?? ModelLabel.explicit(settings.activeModel) else { return nil }
        return ModelLabel.name(models: [], model: id)
    }

    /// The followed run is this chat's and can still finish what it started.
    /// An errored run keeps its run id (to be closed), and the hub may replay
    /// its last «running» level — that must not read as live work (web gates
    /// the same on `isActive`).
    private var helperRunActive: Bool {
        if subagentScope?.fixtureAgents != nil { return true }
        guard client.active?.runId != nil, client.activeState != .error else { return false }
        guard let scope = subagentScope else { return true }
        return client.active?.machineId == scope.machineId && client.active?.sessionId == scope.sessionId
    }

    /// The followed run's sub-agents, when that run is this chat's and alive.
    private var subagentAgents: [Subagent] {
        if let fixture = subagentScope?.fixtureAgents { return fixture }
        return helperRunActive ? client.subagents : []
    }

    private func subagentsContext(_ agents: [Subagent]) -> SubagentsContext {
        var live: [String: Subagent] = [:]
        for a in agents { if let call = a.toolUseId, live[call] == nil { live[call] = a } }
        let scope = subagentScope
        return SubagentsContext(
            live: live,
            notices: subagentMemo.notices,
            runAlive: helperRunActive,
            open: scope?.cwd != nil ? { openAgent = $0 } : nil,
            stop: scope?.canStop == true ? { id in if !pendingStops.contains(id) { pendingStops.append(id) } } : nil)
    }

    private func agentRunning(_ target: SubagentTarget) -> Bool {
        subagentAgents.first {
            (target.toolUseId != nil && $0.toolUseId == target.toolUseId) || (target.agentId != nil && $0.id == target.agentId)
        }?.status == .running
    }

    private func loadAgent(_ target: SubagentTarget) async throws -> [HistoryMessage] {
        guard let scope = subagentScope, let cwd = scope.cwd else { return [] }
        if let fixture = scope.fixtureTranscript { return fixture }
        let liveId = target.agentId ?? subagentAgents.first { $0.toolUseId != nil && $0.toolUseId == target.toolUseId }?.id
        return try await client.subagentMessages(machineId: scope.machineId, cwd: cwd, sessionId: scope.sessionId,
                                                 source: scope.source, toolUseId: target.toolUseId, id: liveId)
    }

    private func stopAgent(_ id: String) {
        guard let scope = subagentScope, scope.fixtureAgents == nil else { return }
        Task { @MainActor in
            do { try await client.stopSubagent(machineId: scope.machineId, sessionId: scope.sessionId, id: id) }
            catch { client.flashError(error.localizedDescription) }
        }
    }

    private func statusText(_ s: String) -> some View {
        Text(s).font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
            .frame(maxWidth: .infinity, alignment: .center)
    }

}

/// Whose sub-agents a chat shows and what it may do with them.
struct SubagentScope: Equatable {
    let machineId: String
    let sessionId: String
    /// Needed to read a helper's transcript; nil hides «Что он делал».
    var cwd: String?
    var source: String?
    /// Whoever may drive the run may stop its helpers.
    var canStop: Bool
    /// DEBUG stand only: a fixed level instead of the client's.
    var fixtureAgents: [Subagent]? = nil
    var fixtureBackground: [RunBackgroundTask]? = nil
    var fixtureTranscript: [HistoryMessage]? = nil
    var fixtureOpen: SubagentTarget? = nil
}

/// «Показать более ранние» — вход в то, что хаб отрезал.
///
/// **Зачем он вообще.** `session.messages` без лимита не означает «всё»: хаб
/// отвечает хвостом в тысячу ходов. До 22.09 приложение об этом не знало
/// ничего — ни кода, ни надписи, — а `CCRemoteKit` считал такой ответ полным и
/// клал его в кэш под текущий mtime. Дальше `hasFreshCache` отвечал «копия
/// свежая», и сессия длиннее тысячи ходов теряла своё начало НАВСЕГДА, молча и
/// без единого признака на экране.
///
/// Кнопка — вторая половина починки, и без неё первая бессмысленна: заметить
/// обрез и не дать до него дойти — это то же самое, что не заметить.
/// «История не загрузилась» with a retry — the iOS twin of the web's
/// `.hist-fail` (web/src/panels/Chat.tsx).
struct HistoryFailedRow: View {
    var onRetry: (() -> Void)?

    var body: some View {
        VStack(spacing: Theme.s2) {
            Text("История не загрузилась — машина занята или недоступна.")
                .font(.ui(Theme.sizeMicro))
                .foregroundStyle(Theme.textFaint)
                .multilineTextAlignment(.center)
            if let onRetry {
                Button("Повторить", action: onRetry)
                    .font(.ui(Theme.sizeMicro).weight(.semibold))
                    .accessibilityIdentifier("history.retry")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.s3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("history.failed")
    }
}

struct HistoryMoreButton: View {
    var loading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.s2) {
                if loading { ProgressView().controlSize(.mini).tint(Theme.textMuted) }
                Text(loading ? "Загружаю…" : "Показать более ранние")
                    .font(.mono(Theme.sizeMicro, weight: .medium))
                    .tracking(Theme.track(Theme.lsCaps, Theme.sizeMicro))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(.horizontal, Theme.s4)
            .frame(minHeight: Theme.tapTarget)
            .background(Theme.surface,
                        in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous)
                    .stroke(Theme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

/// Whether a status line is machinery worth folding. Plans (`✓ / ○` steps) never
/// fold: those are the signal. Mirrors `statusFolds` in web/src/render/Blocks.tsx.
func statusFolds(_ text: String) -> Bool {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    let allSteps = lines.allSatisfy { l in
        let t = l.trimmingCharacters(in: .whitespaces)
        return t.isEmpty || t.hasPrefix("✓") || t.hasPrefix("○")
    }
    if allSteps { return false }
    return text.count > 200 || lines.count > 3
}

/// «N строк» с правильной русской формой.
private func lineCount(_ n: Int) -> String {
    let mod100 = n % 100, mod10 = n % 10
    let word: String
    if (11...14).contains(mod100) { word = "строк" }
    else if mod10 == 1 { word = "строка" }
    else if (2...4).contains(mod10) { word = "строки" }
    else { word = "строк" }
    return "\(n) \(word)"
}

/// A long status line — a command's whole stdout, or a reasoning summary —
/// folded into the same service capsule the rest of the machinery uses.
struct FoldedOutput: View {
    let text: String

    private var isThought: Bool { text.hasPrefix("💭") }

    private var label: String {
        if isThought { return "размышление" }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        // Codex closes a command echo with "→ completed"; that verdict is the
        // one part of the wall worth keeping in the collapsed label.
        let tail = lines.last.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        let verdict = tail.hasPrefix("→") ? " \(tail)" : ""
        return "вывод · \(lineCount(lines.count - (verdict.isEmpty ? 0 : 1)))\(verdict)"
    }

    var body: some View {
        // Вызовов тут нет — эхо команды это не действие, а его отпечаток.
        // Поэтому `mark: 0`: голая шестерёнка без числа, как у вебовского
        // прогона «только результаты».
        CollapsibleRow(mark: 0) {
            ToolRunIcon()
        } label: {
            Text(label)
                .font(.mono(Theme.sizeMeta))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        } content: {
            CodeBlock(text: isThought ? String(text.dropFirst(2)).trimmingCharacters(in: .whitespaces) : text)
        }
    }
}

/// Строка живого потока — на том же языке, что и история: та же `TurnRow`, та
/// же `HumanPlate`, та же сторона. Шов между подгруженной историей и живым
/// хвостом поэтому не виден.
///
/// «Та же» — несущее слово, а не украшение. В вебе этих рендереров было два, и
/// колонку вырастили только в одном: живой поток полгода звал человека `you`, и
/// никто этого не видел, потому что обе половины не оказываются на экране
/// одновременно, пока сессия не станет длинной. Редизайн 22.09 прошёл по обоим
/// вызывающим по той же причине.
struct LiveLineView: View {
    let line: TranscriptLine
    /// Continues the previous assistant line (see `groupLive`).
    var cont: Bool = false
    var agent: String = "Claude"
    /// The reader's own name — the SAME string history gets, from the same call.
    var human: String = SpeakerName.unknown
    var activityURL: URL? = nil
    var activityCount: Int = 0

    /// A streamed `tool_use` line arrives as "ToolName {json}" (see the agent's
    /// claude-session emit). Split it back into name + input so it renders through
    /// the same collapsed service pill as history instead of dumping raw JSON into
    /// the conversation — the web does exactly this in `parseToolLine`.
    private static func parseTool(_ text: String) -> (name: String, input: JSONValue) {
        // Codex streams a shell call as "$ <command>". Splitting that on the
        // first space named every pill "$" and threw the command away, so a
        // Codex session read as a column of identical dollar signs.
        if text.hasPrefix("$ ") {
            return ("$", .object(["command": .string(String(text.dropFirst(2)))]))
        }
        guard let sp = text.firstIndex(of: " ") else { return (text, .object([:])) }
        let name = String(text[text.startIndex..<sp])
        let rest = String(text[text.index(after: sp)...])
        if let data = rest.data(using: .utf8),
           let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
            return (name, value)
        }
        return (name, .string(rest))
    }

    var body: some View {
        switch line.kind {
        case .tool_use:
            let parsed = Self.parseTool(line.text)
            TurnRow(speaker: nil) { ToolUseView(name: parsed.name, input: parsed.input) }
        case .user:
            // A user line never continues anything: an instruction is always a
            // new entry, even two of them in a row.
            TurnRow(speaker: TurnSpeaker(name: human, isHuman: true, ts: line.ts)) {
                // Картинки — над плашкой у правого края, как в истории
                // (`HumanTurnBody`) и в ChatGPT, а не внутри плашки слева.
                VStack(alignment: .trailing, spacing: Theme.s2) {
                    if !line.images.isEmpty {
                        HStack(spacing: 0) { Spacer(minLength: Theme.s6 * 2); attachments }
                    }
                    if !line.text.isEmpty {
                        HumanPlate(ts: line.ts) {
                            UserText(text: line.text, activityURL: activityURL, activityCount: activityCount)
                        }
                    } else if let activityURL {
                        MarkdownText(text: "", activityURL: activityURL, activityCount: activityCount)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        case .assistant:
            TurnRow(speaker: TurnSpeaker(name: agent, isHuman: false, ts: line.ts), cont: cont) {
                Group {
                    if line.streaming {
                        StreamingMarkdownText(text: line.text, activityURL: activityURL, activityCount: activityCount)
                    } else {
                        VStack(alignment: .leading, spacing: 0) {
                            MarkdownText(text: line.text, activityURL: activityURL, activityCount: activityCount)
                            // Дописанный ответ — не стрим: путь в нём уже целый.
                            FilePreviewStrip(text: line.text)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .error:
            // Третий смысловой цвет машинной строки. Слева на той же мере, как
            // и остальные: ошибка — это событие разговора, а не тост.
            TurnRow(speaker: nil) {
                Text(line.text)
                    .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.negative)
                    .padding(.horizontal, Theme.s2).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.red.opacity(0.12),
                                in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
            }
        default:
            if let card = line.imageGen {
                TurnRow(speaker: TurnSpeaker(name: agent, isHuman: false, ts: line.ts)) { ImageGenCardView(card: card) }
            } else if statusFolds(line.text) {
                TurnRow(speaker: nil) { FoldedOutput(text: line.text) }
            } else {
                TurnRow(speaker: nil) {
                    Text(line.text)
                        .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var attachments: some View {
        HStack(spacing: 6) {
            ForEach(line.images) { att in
                if let img = AttachmentImageCache.image(for: att) {
                    Image(platformImage: img)
                        .resizable().scaledToFill()
                        .frame(width: line.images.count == 1 ? 160 : 96,
                               height: line.images.count == 1 ? 200 : 96)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                }
            }
        }
    }

}

/// Картинки живых вложений, уже декодированные: `PlatformImage(data:)` в body
/// разбирал JPEG/PNG заново на каждую дельту стрима, пока строка человека на экране.
/// Ключ — id вложения; NSCache сам вытесняет под нагрузкой памяти.
private enum AttachmentImageCache {
    private static let cache: NSCache<NSUUID, PlatformImage> = {
        let cache = NSCache<NSUUID, PlatformImage>()
        cache.countLimit = 24
        return cache
    }()

    static func image(for attachment: ImageAttachment) -> PlatformImage? {
        let key = attachment.id as NSUUID
        if let hit = cache.object(forKey: key) { return hit }
        guard let made = PlatformImage(data: attachment.data) else { return nil }
        cache.setObject(made, forKey: key)
        return made
    }
}

// MARK: - Collapsed tool runs

/// «N действий» с правильной русской формой.
func actionCount(_ n: Int) -> String {
    let mod100 = n % 100, mod10 = n % 10
    let word: String
    if (11...14).contains(mod100) { word = "действий" }
    else if mod10 == 1 { word = "действие" }
    else if (2...4).contains(mod10) { word = "действия" }
    else { word = "действий" }
    return "\(n) \(word)"
}

/// Бесцветная метка свёрнутого прогона — служебная механика.
///
/// Один в один с вебовским `ToolRunIcon` (`web/src/render/Blocks.tsx`): голая
/// шестерёнка в самом бледном тоне текста, без плашки и без заливки.
///
/// **Здесь стоял 18×18 цветной квадрат, и это ОТМЕНЕНО.** Довод за цвет был
/// такой: свёрнутый прогон — то, что читатель и видит, поэтому тон должен
/// отвечать на «изменило ли это что-нибудь». Довод проиграл более сильному:
/// свёрнутый прогон не читают вовсе, его ПРОЛИСТЫВАЮТ, и двадцать цветных
/// квадратов вниз по ленте — это не двадцать ответов, а рябь. Три
/// семантических цвета остались там, где на них смотрят: на пилюлях внутри
/// раскрытого прогона.
private struct ToolRunIcon: View {
    var body: some View {
        Image(systemName: "gearshape")
            .font(.system(size: 10, weight: .regular))  // бокс глифа
            .foregroundStyle(Theme.textFaint)
    }
}
