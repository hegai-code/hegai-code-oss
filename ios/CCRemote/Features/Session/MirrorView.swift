import SwiftUI
import Observation
import CCRemoteKit

/// Owns the read-only mirror subscription lifecycle: open, dedupe by uuid,
/// auto-retry 5s after the live view dies. A reference type so the async
/// mirror callbacks mutate live state (a struct View's captured self wouldn't).
@MainActor
@Observable
final class MirrorModel {
    private(set) var messages: [HistoryMessage] = []
    private(set) var connected = false
    private(set) var dead = false
    private var tailRevision: String?
    private var confirmedTailID: String?
    /// mirror_data is chunked without an end marker. Only a separate fresh
    /// tail read can prove that the last chunk has actually reached this view.
    var confirmedRevision: String? {
        guard let confirmedTailID, messages.last?.uuid == confirmedTailID else { return nil }
        return tailRevision
    }

    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var seen = Set<String>()
    @ObservationIgnored private var handle: MirrorHandle?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private weak var client: CentralClient?
    @ObservationIgnored private var machineId = ""
    @ObservationIgnored private var sessionId = ""
    @ObservationIgnored private var cwd = ""
    @ObservationIgnored private var source: String?
    @ObservationIgnored private var confirmTail = false
    /// Ревизия, чей хвост надо подтвердить (nil — подтверждать нечего). Живёт отдельно от
    /// подписки: смена working/idle или mtime больше не переоткрывает зеркало, а лишь
    /// меняет это значение (`confirm(revision:)`).
    @ObservationIgnored private var wantedRevision: String?
    @ObservationIgnored private var confirming: (ticket: Int, revision: String)?
    /// Сколько последних сообщений читать для подтверждения: нужен только uuid последнего.
    private static let tailProbe = 20

    func start(client: CentralClient, machineId: String, sessionId: String, cwd: String, revision: String = "",
               source: String? = nil, confirmTail: Bool = false) {
        self.client = client; self.machineId = machineId; self.sessionId = sessionId; self.cwd = cwd
        self.source = source; self.confirmTail = confirmTail
        if confirmTail { wantedRevision = revision }
        stop(clearRetry: true)
        let ticket = generation
        guard !cwd.isEmpty, client.status == .open else { return }
        connected = false
        dead = false
        Task { [weak self] in
            guard let self else { return }
            do {
                let h = try await client.openMirror(
                    machineId: machineId, sessionId: sessionId, cwd: cwd,
                    onData: { [weak self] replace, msgs in
                        guard let self, self.generation == ticket else { return }
                        self.ingest(replace: replace, msgs)
                    },
                    onExit: { [weak self] in
                        guard let self, self.generation == ticket else { return }
                        self.onDead(revision: revision)
                    }
                )
                guard self.generation == ticket else { h.close(); return }
                self.handle = h
                await self.confirmWanted(ticket: ticket)
            } catch {
                guard self.generation == ticket else { return }
                self.onDead(revision: revision)
            }
        }
    }

    /// Подтвердить хвост для `revision` (nil — снять подтверждение) НЕ трогая подписку.
    /// Раньше ревизия входила в идентичность подписки: каждая смена working/idle и каждый
    /// сдвиг mtime в простое закрывали зеркало, открывали заново и тянули всю историю ради
    /// uuid последнего сообщения. Теперь подписка живёт, а хвост читается с `limit`.
    func confirm(revision: String?) {
        wantedRevision = revision
        confirmedTailID = nil
        tailRevision = nil
        // Подписки ещё нет — подтвердит `start` сразу после открытия.
        guard revision != nil, handle != nil else { return }
        let ticket = generation
        Task { [weak self] in await self?.confirmWanted(ticket: ticket) }
    }

    private func confirmWanted(ticket: Int) async {
        guard let revision = wantedRevision, let client, generation == ticket else { return }
        if let confirming, confirming.ticket == ticket, confirming.revision == revision { return }
        confirming = (ticket, revision)
        defer { if confirming?.ticket == ticket, confirming?.revision == revision { confirming = nil } }
        let page = try? await client.sessionMessagesPage(
            machineId: machineId, cwd: cwd, sessionId: sessionId, source: source, limit: Self.tailProbe)
        // Подписку или ревизию успели сменить — ответ про другой хвост.
        guard generation == ticket, wantedRevision == revision, let page, !page.stale else { return }
        confirmedTailID = page.messages.last?.uuid
        tailRevision = revision
    }

    func stop(clearRetry: Bool = true) {
        generation += 1
        connected = false
        confirmedTailID = nil
        tailRevision = nil
        confirming = nil
        handle?.close()
        handle = nil
        if clearRetry { retryTask?.cancel(); retryTask = nil }
    }

    private func ingest(replace: Bool, _ msgs: [HistoryMessage]) {
        connected = true
        dead = false
        if replace {
            seen = Set(msgs.map(\.uuid))
            messages = msgs
        } else {
            let fresh = msgs.filter { !seen.contains($0.uuid) }
            for m in fresh { seen.insert(m.uuid) }
            if !fresh.isEmpty { messages.append(contentsOf: fresh) }
        }
    }

    private func onDead(revision: String) {
        dead = true
        connected = false
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self, !Task.isCancelled, let client else { return }
            self.start(client: client, machineId: self.machineId, sessionId: self.sessionId, cwd: self.cwd, revision: revision,
                       source: self.source, confirmTail: self.confirmTail)
        }
    }
}

/// Read-only live view of an editor-held session + the two takeover paths.
/// Port of web/src/panels/Mirror.tsx.
struct MirrorView: View {
    let machineId: String
    let session: SessionSummary
    let takingOver: Bool
    /// Fallback for an externally-held Codex writer that cannot be taken over.
    var readOnly: Bool = false
    let onTakeOver: () -> Void
    let onForceTakeOver: () -> Void
    /// Typing and sending IS the takeover (web parity): the message force-takes the
    /// session and lands as the first turn. Without it a mirrored session is a
    /// dead end whenever the editor never releases it.
    let onSendTakeover: (String) -> Void

    @Environment(CentralClient.self) private var client
    @State private var model = MirrorModel()
    /// Regrouped transcript, recomputed only when the messages actually change.
    @State private var memo = TranscriptMemo()
    @State private var subagentMemo = SubagentHistoryMemo()
    @State private var dayTick = 0
    @State private var window = TranscriptWindow()

    /// Стоит ли читатель у живого конца. То же, что в `ChatView`, и ровно по
    /// той же причине — см. `transcript`.
    @State private var scroll = TranscriptScrollState()
    private var atBottom: Bool { scroll.atBottom }

    private struct BottomGapKey: PreferenceKey {
        static let defaultValue: CGFloat? = nil
        static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
            if let next = nextValue() { value = next }
        }
    }

    @State private var showForceConfirm = false
    @State private var draft = ""
    @State private var sending = false
    @FocusState private var composerFocused: Bool

    // Turn enrichment (see EnrichTail.swift): the same strip as the live chat,
    // except that a tap here IS a force takeover — the hint under the buttons
    // says so, since a phone has no tooltip.
    // Like the chat: nothing while the model's pass is pending, the heuristic only
    // when it failed or cannot be asked, and no ideas (a tap here takes the
    // session over — a heavy price for a tangent).
    @State private var llmEnrich: LlmEnrich?
    /// The tail whose strip the person dismissed with ✕.
    @State private var dismissedKey: String?
    private struct LlmEnrich: Equatable { let key: String; let state: EnrichState }
    private struct EnrichKey: Equatable { let tail: String?; let gate: Bool }

    private var enrichTail: EnrichTail? { EnrichTailFinder.tail(mirror: model.messages) }
    private var editorState: AttentionState? {
        session.activityState(run: client.runFor(machineId: machineId, sessionId: session.sessionId))
    }
    private var editorWorking: Bool {
        editorState == .working || editorState == .needs_attention
    }
    private var mirrorRevision: String {
        "\(session.sessionId):\(client.connectionEpoch):\(editorState?.rawValue ?? "unknown"):\(editorState == .idle ? session.lastModified : 0)"
    }
    private var enrichGate: Bool { !readOnly && !sending && !editorWorking }
    private var enrichment: Enrichment? {
        guard let tail = enrichTail, tail.key != dismissedKey else { return nil }
        var state = EnrichState.pending
        if let stored = llmEnrich, stored.key == tail.key { state = stored.state }
        return Enrichment.shown(state: state, heuristic: EnrichHeuristics.enrichment(for: tail.text), allowIdeas: false)
    }
    private var showEnrich: Bool { enrichment != nil && model.connected && enrichGate }

    private var editor: String { session.entrypoint ?? "the editor" }

    var body: some View {
        VStack(spacing: 0) {
            banner
            // Same reason as SessionDetailView: stacked under the transcript, the
            // composer is what the keyboard covers, because this screen hides the
            // tab bar inside a NavigationStack pushed from a TabView and keyboard
            // avoidance insets against a safe area that still counts it. As a
            // bottom safe-area inset it stays above the keys, and the transcript
            // insets its content by it instead of being overlapped.
            transcript
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 0) {
                        if takingOver { waitBanner }
                        // Pinned with the composer, as in the chat.
                        if showEnrich, let enrichment {
                            EnrichStrip(enrichment: enrichment, onReply: quickReply,
                                        onDismiss: { dismissedKey = enrichTail?.key },
                                        replyHint: "Ответ принудительно перехватит сессию у \(editor)")
                        }
                        if !readOnly { composer } else { lockedNote }
                    }
                    .background(Theme.bg)
                }
        }
        // Подписка держится, пока та же сессия, тот же сокет и cwd. Работает редактор или
        // простаивает — это уже не повод её переоткрывать (см. `MirrorModel.confirm`).
        // Исключение — возврат из фона на том же сокете (`resumeCount`): пока сокет был на
        // паузе, хаб отбрасывал `mirror_data`, и в транскрипте зеркала дыра, которую
        // следующие кадры не заполнят. Переоткрытие присылает `replace`-снимок целиком.
        .task(id: TaskKey(session: session.sessionId, cwd: session.cwd ?? "", open: client.status == .open,
                          epoch: client.connectionEpoch, resume: client.resumeCount)) {
            guard !Task.isCancelled else { return }
            model.start(client: client, machineId: machineId, sessionId: session.sessionId, cwd: session.cwd ?? "",
                        source: session.source)
        }
        // Хвост подтверждается только в простое и по каждой новой ревизии.
        .task(id: mirrorRevision) {
            model.confirm(revision: editorState == .idle ? mirrorRevision : nil)
        }
        .onDisappear { model.stop() }
        .task(id: EnrichKey(tail: enrichTail?.key, gate: enrichGate)) { await requestEnrichment() }
        // The editor starting a new turn ends this one's strip: the cached
        // answer and the dismissal are keyed on the tail's text, and a turn
        // that ends with the same words must not inherit either.
        .onChange(of: editorWorking) { was, now in
            if !was, now {
                llmEnrich = nil
                dismissedKey = nil
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
            memo.invalidate()
            dayTick += 1
        }
        .confirmationDialog("Перехватить принудительно?", isPresented: $showForceConfirm, titleVisibility: .visible) {
            Button("Перехватить", role: .destructive) { onForceTakeOver() }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Писатель в \(editor) на машине будет завершён, а сессия продолжится здесь.")
        }
    }

    private struct TaskKey: Equatable { let session: String; let cwd: String; let open: Bool; let epoch: Int; let resume: Int }

    @ViewBuilder private var banner: some View {
        if readOnly {
            // Externally-held Codex writers cannot be force-taken over here.
            HStack(spacing: Theme.s2) {
                RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                    .fill(Theme.tealDark).frame(width: Theme.statusDot, height: Theme.statusDot)
                Image(systemName: "eye").font(.system(size: 13)).foregroundStyle(Theme.textMuted)  // бокс глифа
                Text("Codex активен в другом клиенте — закройте его там, чтобы продолжить")
                    .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
                Spacer()
            }
            .padding(Theme.s3)
            .background(Theme.surface)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
        } else {
            VStack(spacing: Theme.s2) {
                HStack(spacing: Theme.s2) {
                    RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                        .fill(Theme.red).frame(width: Theme.statusDot, height: Theme.statusDot)
                    Image(systemName: "eye").font(.system(size: 13)).foregroundStyle(Theme.textMuted)  // бокс глифа
                    Text("Зеркало живой сессии в \(editor) — только чтение")
                        .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
                    Spacer()
                }
                HStack(spacing: Theme.s2) {
                    Button(action: onTakeOver) {
                        Label(takingOver ? "Жду редактор…" : "Перехватить", systemImage: "hand.raised")
                            .font(.ui(Theme.sizeMeta, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .disabled(takingOver)

                    Button { showForceConfirm = true } label: {
                        Text("Принудительно").font(.ui(Theme.sizeMeta, weight: .medium))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.red)
                    .disabled(client.busy)
                    Spacer()
                }
            }
            .padding(Theme.s3)
            .background(Theme.surface)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
        }
    }

    /// Тот же документ, что читает `ChatView`: слитые абзацы, метки дней,
    /// сторона говорящего — зеркало не имеет права группировать иначе, чем
    /// живой вид.
    ///
    /// И следовать за хвостом иначе — тоже. Здесь стоял безусловный
    /// `scrollTo` на каждое сообщение: читатель, отлиставший назад посмотреть,
    /// с чего чужая работа началась, улетал в конец на каждой строке, которую
    /// агент в этот момент дописывал, — то есть ровно в зеркале, куда только
    /// читать и ходят. `ChatView` это уже прошёл и записал: ворота —
    /// `atBottom`, мерянный расстоянием от нижней метки до кромки окна, и
    /// кнопка «Вниз» для того, кто НЕ внизу. Ворота и кнопка — одна вещь:
    /// без кнопки читатель, оторвавшийся от конца, остаётся без дороги назад.
    private var transcript: some View {
        GeometryReader { viewport in
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    let _ = dayTick
                    if model.dead {
                        Text("живой просмотр отключился — агент офлайн (пробую снова…)")
                            .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.negative)
                            .padding(.vertical, Theme.s2)
                    } else if !model.connected {
                        Text("подключаюсь к живой сессии…").font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                            .padding(.vertical, Theme.s2)
                    }
                    let items = memo.items(for: model.messages)
                    let agent = agentName(session.source)
                    // Зеркало смотрит на ЧУЖУЮ работу, но человек в ней тот же:
                    // это транскрипт одного рабочего пространства, и имя в
                    // колонке приходит из того же профиля тем же вызовом.
                    let human = SpeakerName.human(client.viewer)
                    let rows = transcriptRows(history: items, busy: editorWorking)
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
                    }
                    let _ = subagentMemo.update(model.messages)
                    ForEach(Array(rows.dropFirst(first))) { row in
                        TranscriptRowView(row: row, agent: agent, human: human)
                            .id(row.id)
                    }
                    // Чужой ран живых фактов о помощниках не шлёт: карточка
                    // говорит только то, что записано в самой истории.
                    .environment(\.subagents, SubagentsContext(notices: subagentMemo.notices))
                    .onChange(of: rows.first?.id, initial: true) { _, _ in
                        window.retainStart(in: ids)
                    }
                    if model.connected && model.messages.isEmpty {
                        Text("сообщений пока нет — жду активности…").font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                            .padding(.vertical, Theme.s2)
                    }
                    if TurnCompletion.isComplete(history: model.messages, lines: [], busy: editorWorking,
                        connected: model.connected && model.confirmedRevision == mirrorRevision && client.status == .open && !client.pendingCatchUp,
                        state: editorState) {
                        TurnRow(speaker: nil) { TurnCompletionRow() }
                    }
                    Color.clear.frame(height: 1).id("mirror-bottom")
                }
                .background {
                    GeometryReader { content in
                        Color.clear.preference(key: BottomGapKey.self,
                            value: content.frame(in: .global).maxY - viewport.frame(in: .global).maxY)
                    }
                }
                .padding(Theme.s3)
                .frame(maxWidth: Theme.readingWidth)
                .frame(maxWidth: .infinity)
            }
            .transcriptAnchor(following: scroll.followsTail)
            .unifiedScrollEdges()
            .scrollClipDisabled()
            .dismissKeyboardOnTap()
            .simultaneousGesture(DragGesture(minimumDistance: 4)
                .onChanged { scroll.drag(dx: $0.translation.width, dy: $0.translation.height) }
                .onEnded { _ in scroll.endDrag() })
            .onPreferenceChange(BottomGapKey.self) { gap in
                guard let gap else { return }
                let atTail = gap <= 60
                if atTail != scroll.atBottom { scroll.moved(gap: atTail ? 0 : 61) }
            }
            // «Вниз» — единственная прокрутка, которая НЕ спрашивает `atBottom`:
            // кнопка существует ровно тогда, когда ответ «нет».
            .overlay(alignment: .bottom) {
                if !atBottom {
                    ScrollToBottomButton {
                        scroll.follow()
                        withAnimation(Theme.ease) { proxy.scrollTo("mirror-bottom", anchor: .bottom) }
                    }
                    .padding(.bottom, Theme.s1)
                    .transition(.opacity)
                }
            }
        }
        }
    }

    /// Composer whose send force-takes the session over (port of the web Mirror).
    private var composer: some View {
        VStack(spacing: Theme.s2) {
            HStack(alignment: .bottom, spacing: 6) {
                TextField(sending ? "Перехватываю сессию…" : "Сообщение — перехватит сессию…",
                          text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    // Композер зеркала печатает то же, что композер сессии, —
                    // и той же ступенью.
                    .font(.ui(Theme.sizeBody))
                    .foregroundStyle(Theme.text)
                    .focused($composerFocused)
                    .lineLimit(1...5)
                    .disabled(sending)
                    .padding(.leading, Theme.s2)
                    .padding(.vertical, Theme.s2)
                // The same send square as the live composer — a circle here
                // was the last one in the transcript chrome.
                SendCircle(enabled: canSend, size: 36) { submit() }
            }
            .padding(.trailing, 6)
            .padding(.vertical, 4)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radiusLg))
            .overlay(
                // Тот же композерный фокус, что и в `ComposerView`: цвет
                // действия, не ember. См. комментарий там.
                RoundedRectangle(cornerRadius: Theme.radiusLg)
                    .stroke(composerFocused ? Theme.action : Theme.border,
                            lineWidth: composerFocused ? 1.5 : 1)
            )
            Text(sending
                 ? "Перехватываю у \(editor)…"
                 : "Отправка принудительно перехватит сессию у \(editor)")
                .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Theme.s3)
        .background(Theme.surface)
    }

    private var lockedNote: some View {
        Text("Ввод заблокирован — сессия открыта в другом клиенте")
            .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.s3)
            .background(Theme.surface)
    }

    private var canSend: Bool {
        !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        draft = ""
        onSendTakeover(text)
        Haptics.rigid()
    }

    /// A quick reply from the strip goes out exactly like a typed one: it
    /// force-takes the session over and lands as the first turn.
    private func quickReply(_ reply: Enrichment.QuickReply) {
        guard !sending else { return }
        sending = true
        onSendTakeover(reply.send)
        Haptics.rigid()
    }

    private func requestEnrichment() async {
        // No stored answer for this tail yet (a cancelled pass stores nothing).
        guard let tail = enrichTail, enrichGate, llmEnrich?.key != tail.key else { return }
        let digest = EnrichDigest.build(history: model.messages, live: [], cwd: session.cwd,
                                        clean: EnrichTailFinder.clean)
        let state = await client.enrichState(
            machineId: machineId, sessionId: session.sessionId, source: session.source,
            uuid: tail.uuid, text: String(tail.text.suffix(6000)), digest: digest)
        guard !Task.isCancelled else { return }
        llmEnrich = LlmEnrich(key: tail.key, state: state)
    }

    private var waitBanner: some View {
        Text("Закройте сессию в \(editor) — я подхвачу её здесь автоматически.")
            .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.orangeText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.s3)
            .background(Theme.orange.opacity(0.12))
    }
}
