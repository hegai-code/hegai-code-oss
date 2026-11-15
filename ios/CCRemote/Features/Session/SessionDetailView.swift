import SwiftUI
import CCRemoteKit

/// Что экран сессии берёт из инвентаря, одной сравнимой проекцией: сама сессия и
/// то, что про неё решает машина. `client.machines` меняется на каждый кадр
/// инвентаря, usage и статистики любой машины; экран, читавший его в своём body
/// шесть раз, перестраивался целиком (с композером и чатом) на каждый из них.
struct SessionFacts: Equatable {
    var session: SessionSummary?
    var machineName: String?
    var online = false
    var canDrive = true
    var canStartHere = false
    var canEdit = false

    /// Один проход по инвентарю. Машины нет в списке — значения по умолчанию
    /// те же, что давали прежние `?? …` у каждого свойства.
    @MainActor
    static func read(_ client: CentralClient, machineId: String, sessionId: String) -> SessionFacts {
        guard let snap = client.machines.first(where: { $0.machine.machineId == machineId }) else { return SessionFacts() }
        let owner = snap.owner?.userId
        return SessionFacts(
            session: snap.sessions.first { $0.sessionId == sessionId },
            machineName: snap.machine.name,
            online: snap.online,
            canDrive: snap.canDrive,
            canStartHere: snap.canStartHere,
            canEdit: snap.hasControl || (owner != nil && owner == client.viewer?.userId))
    }
}

/// Session workspace — chat only. A read-only Mirror is shown when the session is
/// live in an editor and we don't own it (with cooperative + force takeover);
/// otherwise the live Chat + composer. No Files/Git/Term or technical chrome —
/// just the conversation.
///
/// Тонкая оболочка: читает инвентарь (`SessionFacts`) и отдаёт экрану
/// `SessionDetailBody`, который `.equatable()` не пересобирает, пока проекция та же.
struct SessionDetailView: View {
    let machineId: String
    let sessionId: String

    @Environment(CentralClient.self) private var client

    var body: some View {
        SessionDetailBody(machineId: machineId, sessionId: sessionId,
                          facts: SessionFacts.read(client, machineId: machineId, sessionId: sessionId))
            .equatable()
    }
}

/// Последние факты экрана для замыканий и асинхронных функций. `ChatViewGate`
/// не заменяет свои замыкания, пока значения те же, поэтому замыкание, захватившее
/// СТРУКТУРУ экрана с `facts` по значению, увидело бы устаревшую сессию (cwd, mtime —
/// от него зависит свежесть кэша истории). Ссылочный ящик отдаёт то, что записал
/// последний body, как раньше отдавал живой `client.machines`.
final class SessionFactsBox {
    private(set) var facts = SessionFacts()
    func set(_ facts: SessionFacts) { self.facts = facts }
}

/// Сам экран сессии. Остальные подписки на `client` (строки стрима, busy, ран) он держит
/// сам и перестраивается по ним, но не по чужим кадрам инвентаря.
private struct SessionDetailBody: View, Equatable {
    let machineId: String
    let sessionId: String
    /// Только для сравнения и для записи в `factsBox`; читать — через `factsBox.facts`.
    let facts: SessionFacts
    @State private var factsBox = SessionFactsBox()

    static func == (a: SessionDetailBody, b: SessionDetailBody) -> Bool {
        a.machineId == b.machineId && a.sessionId == b.sessionId && a.facts == b.facts
    }

    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss

    /// Kept across leaving and reopening the session (`SessionHistoryShelf`).
    private var historyState: SessionHistory { SessionHistoryShelf.shared.history(for: historyIdentity) }
    private var historyIdentity: String { "\(client.storageScope)::\(machineId)::\(sessionId)" }
    @State private var historyConnectionEpoch: Int?
    @State private var shownSessionId = ""
    @State private var pendingConverge = false
    @State private var convergenceTask: Task<Void, Never>?
    private var history: [HistoryMessage] { historyState.messages }
    private var loadingHist: Bool { historyState.loading }
    /// The session is not in the machine's list yet (no cwd to read with): a
    /// session opened from a push or a link moments after it was created, or
    /// one the hub has not been told about. Its history is read the moment the
    /// summary arrives (`.onChange(of: session?.cwd)`).
    private var waitingForSession: Bool { session?.cwd == nil && history.isEmpty }
    private var loadingEarlier: Bool { historyState.loadingEarlier }
    private var canLoadEarlier: Bool { !showMirror && historyState.canLoadEarlier }
    @State private var presentedTool: ToolRequest?

    @State private var models: [ModelInfoLite] = DEFAULT_MODELS
    @State private var selectedModel = ""
    @State private var permissionMode: PermissionMode = .default
    @State private var effort: EffortChoice = .high

    @State private var takingOver = false
    @State private var takeoverTask: Task<Void, Never>?

    @State private var showInfo = false
    @State private var headerWidth: CGFloat = 375

    // Turn enrichment — the strip of takeaways and one-tap replies under the
    // tail turn (see EnrichTail.swift / EnrichStrip.swift).
    /// Where the model's pass stands, tied to the tail it was asked about. No
    /// entry for the current tail = still pending (not asked, or in flight): the
    /// strip shows NOTHING then — a Да/Нет that the verdict then removes is worse
    /// than a strip that appears once, right (13.10.2026).
    @State private var llmEnrich: LlmEnrich?
    /// The tail the user already replied to — or dismissed with ✕ — from the
    /// strip: hidden at once.
    @State private var answeredKey: String?
    /// Ideas already dropped into the composer, `tail.key|text`: a second tap
    /// would append the same sentence again.
    @State private var draftedIdeas: Set<String> = []
    /// An idea on its way into the composer (see `ComposerView.seed`).
    @State private var ideaSeed: ComposerSeed?
    /// A quick reply that went out as a resume; if the hub refuses, the text
    /// lands in the composer draft instead of vanishing.
    @State private var pendingResume: String?
    @State private var draftReload = 0

    private struct LlmEnrich: Equatable { let key: String; let state: EnrichState }
    private struct EnrichKey: Equatable { let tail: String?; let gate: Bool }

    private var draftKey: String { "\(machineId)::\(sessionId)" }

    /// Один поиск хвоста на вход (`EnrichTailMemo`), а не по разу на каждое из пяти
    /// обращений за проход. Пока ран занят, хвоста нет, и живые строки не читаются:
    /// иначе экран подписывался бы на каждую дельту стрима.
    @State private var enrichMemo = EnrichTailMemo()
    private var enrichTail: EnrichTail? {
        enrichMemo.tail(history: history, busy: client.busy) { client.lines }
    }
    /// When a reply from the strip would actually be accepted. The last two are
    /// the states where the composer gives way to a recovery banner.
    private var enrichGate: Bool {
        canDrive && !client.isChangingModel && !takingOver && machineOnline && erroredRun == nil && !isBlocked
            && session?.isArchived != true
    }
    private var enrichment: Enrichment? {
        guard let tail = enrichTail, tail.key != answeredKey else { return nil }
        var state = EnrichState.pending
        if let stored = llmEnrich, stored.key == tail.key { state = stored.state }
        guard var shown = Enrichment.shown(state: state, heuristic: EnrichHeuristics.enrichment(for: tail.text)) else { return nil }
        shown.quickReplies = shown.quickReplies?.filter { !draftedIdeas.contains("\(tail.key)|\($0.send.trimmingCharacters(in: .whitespacesAndNewlines))") }
        return shown.quickReplies?.isEmpty == false ? shown : nil
    }
    /// A job with a task still in the background is not over whatever the
    /// turn says — the CLI will wake on it (web `turnOver`).
    private var showEnrichGate: Bool { !client.busy && client.background.isEmpty && enrichGate }

    private var answerCompleted: Bool {
        // `!client.busy` первым: `isComplete` при busy и так отвечает «нет», а дальше по цепочке
        // читаются живые строки, то есть экран перестраивался бы на каждую дельту стрима.
        ownsFocus && !client.busy && !loadingHist && !client.pendingCatchUp && queued.isEmpty && !isBlocked
            && client.toolReq == nil && client.background.isEmpty && TurnCompletion.isComplete(
            history: history, lines: client.lines, busy: client.busy,
            connected: client.status == .open && machineOnline,
            state: sessionActivity,
            completedAt: client.completionReads.completed[draftKey]?.at,
            lastModified: session?.lastModified,
            historyConfirmed: historyState.confirmedCurrent && historyConnectionEpoch == client.connectionEpoch,
            linesConfirmed: client.hasCurrentAssistantLines)
    }

    private var session: SessionSummary? { factsBox.facts.session }
    private var sessionActivity: AttentionState? {
        let run = client.runFor(machineId: machineId, sessionId: sessionId)
        return session?.activityState(run: run) ?? run?.state
    }
    /// Where «Новый чат» from this session starts — its own project, under
    /// the same rule the drawer's «+» uses.
    private var newChatTarget: ProjectTarget? {
        guard let session, let cwd = session.cwd, !cwd.isEmpty, !ProjectShelf.isRootish(cwd),
              let machineName = factsBox.facts.machineName,
              factsBox.facts.online, factsBox.facts.canStartHere else { return nil }
        return ProjectTarget(machineId: machineId, machineName: machineName, cwd: cwd,
                             label: DrawerModel.projectName(session), lastModified: session.lastModified,
                             mine: true)
    }
    private var machineName: String? { factsBox.facts.machineName }
    private var machineOnline: Bool { factsBox.facts.online }
    /// A shared session a member may watch but not drive: no composer, no
    /// transcript actions. The hub enforces this too — the UI just stops
    /// offering what would be refused.
    private var canDrive: Bool { factsBox.facts.canDrive }
    private var canStartHere: Bool { factsBox.facts.canStartHere }
    private var canEdit: Bool { factsBox.facts.canEdit }
    /// Driveable = a run we own that can still take input. A run in `error` is
    /// attached (so it can be closed) but must not present a composer.
    private var isActive: Bool {
        client.active?.machineId == machineId && client.active?.sessionId == sessionId && client.active?.runId != nil
            && client.activeState != .error
    }
    /// A run for THIS session that ended in error. It keeps the hub's single-writer
    /// lock until closed, so the screen offers that instead of a composer.
    private var erroredRun: ActiveRunInfo? {
        client.runFor(machineId: machineId, sessionId: sessionId).flatMap { $0.state == .error ? $0 : nil }
    }
    /// The hub refused `open` because a run we cannot see still holds the session.
    private var isBlocked: Bool {
        client.blockedSession == SessionRef(machineId: machineId, sessionId: sessionId)
    }
    private var isCodex: Bool { session?.isCodex ?? false }
    /// OpenCode Go: the hub's `provider` on the summary, or the live run's Go model.
    private var isOpenCode: Bool {
        guard isCodex else { return false }
        if session?.isOpenCode == true { return true }
        guard client.active?.machineId == machineId, client.active?.sessionId == sessionId else { return false }
        return AgentModels.isGoModel(ModelLabel.explicit(client.runSettings?.model)
                                     ?? ModelLabel.explicit(client.runSettings?.activeModel))
    }
    /// The read-only Mirror is only for editor-held (livePid) sessions we don't own.
    /// Codex is resumable via the agent's Codex runtime, so it uses the live Chat +
    /// composer like Claude. Codex exposes its plan/default collaboration mode;
    /// Claude-only model/effort and transcript actions stay hidden.
    private var showMirror: Bool { machineOnline && (session?.isLive ?? false) && !isActive }
    /// The header as a row INSIDE the view rather than a toolbar item. Only on
    /// macOS: a window toolbar is translucent and the transcript scrolled under
    /// it, and the window already has a title of its own. On the phone the
    /// navigation bar carries it — there is one page, and nothing to share the
    /// `.principal` slot with since «Колонки» went away.
    private var showsInlineHeader: Bool {
        #if os(macOS)
        true
        #else
        false
        #endif
    }

    var body: some View {
        // Корпус экрана и его ПРЕДЪЯВЛЕНИЯ (листы, алерт, подтверждение) —
        // два выражения, а не одно. Не стилистика: одной цепочкой это перестало
        // проверяться по типам «за разумное время» ровно в тот момент, когда к
        // ней прибавился один модификатор. Разрезать по шву «экран / то, что
        // над экраном» — самый честный шов, который здесь есть.
        // Ящик обновляется до чтения чего-либо ниже: тот же проход body.
        let _ = factsBox.set(facts)
        presentations(core)
            .environment(\.transcriptImageSource, TranscriptImageSource(machineId: machineId, sessionId: sessionId,
                                                                      source: isCodex ? "codex" : "claude"))
            // Папка сессии — от неё читаются файлы, которые назвал ответ.
            .environment(\.filePreviewSource, session?.cwd.map { FilePreviewSource(machineId: machineId, cwd: $0) })
    }

    private var core: some View {
        VStack(spacing: 0) {
            // Здесь стояла `SessionSwitcherBar` — ряд чипов «твои сессии на
            // ходу», приколотый под шапкой чата. Её роль забрал drawer фазы 2:
            // список сессий живёт ровно в одном месте, открывается ☰ и свайпом
            // поверх разговора, и показывает не восемь последних, а все. Два
            // переключателя сессий на одном экране — это не запас, а вопрос
            // «какой из них настоящий» на каждом открытии.
            if showsInlineHeader {
                sessionHeader
                Divider()
            }
            content
        }
        .background(Theme.bg)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { headerWidth = $0 }
        .task(id: "title:\(session?.title ?? ""):\(Int((session?.lastModified ?? 0) / 300_000))") {
            if let session { await client.navigationTitles.prepare(client: client, machineId: machineId, session: session) }
        }
        .inlineTitle()
        .toolbarBackground(.hidden, for: .navigationBar)
        #if os(iOS)
        .toolbar {
                // ☰ рядом со «назад»: шторка открывается ПОВЕРХ разговора, и
                // это единственная дорога к другой сессии, не выходя из этой.
                // Раньше такой дороги не было вовсе — приходилось возвращаться
                // в список, то есть уходить из разговора ровно затем, чтобы в
                // разговоре остаться.
                bareToolbarItem { DrawerButton() }
                // Session identity leads; runtime settings live in the composer.
                ToolbarItem(placement: .principal) {
                    Button { showInfo = true; Haptics.light() } label: {
                        SessionTitle(title: sessionName,
                                            active: sessionActivity == .working,
                                            isCodex: isCodex, isOpenCode: isOpenCode, availableWidth: headerWidth)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("session.titleIsland")
                }
                bareToolbarItem(placement: .trailingActions) { NewChatButton(target: newChatTarget) }
        }
        #endif
        // Здесь пряталась нижняя полоса вкладок. Её больше нет нигде, поэтому
        // модификатор снят, а не оставлен ни на что не влияющим: no-op, который
        // описывает выброшенную вещь, — это дрейф документации в коде.
        //
        // Побочно это снимает и причину той возни с safe area у композера: он
        // висит на нижней safe area транскрипта, потому что автоматический
        // отступ под клавиатуру считался против области, которая всё ещё
        // включала полосу вкладок. Полосы нет — считать не против чего. Кто
        // будет разбирать композер в фазе 3: отступ, скорее всего, можно
        // упростить, но менять его сейчас — менять чужую приёмку.
        // Keyed on the connection generation as well as the session: a socket the
        // OS killed while the app was suspended means the turn kept running on the
        // machine and its text now lives only in the transcript file. Re-running
        // focus + history on reconnect is what makes the chat catch up instead of
        // sitting on the pre-background tail.
        .task(id: FocusKey(session: sessionId, connection: client.connectionEpoch, keys: client.e2eeRevision)) { await onFocus() }
        // Enrichment: ask the hub ONCE per tail turn (keyed on its text — see
        // `EnrichTail.key`), and only while a reply would be accepted. The answer
        // — including a failure — is stored per tail, so there is no retry (web
        // parity); an ask that was cancelled stores nothing and is asked again.
        .task(id: EnrichKey(tail: enrichTail?.key, gate: enrichGate)) { await requestEnrichment() }
        // Convergence pass (port of web/src/panels/Chat.tsx): a history read taken
        // during a live turn lacks that turn's streamed part, so re-read once it
        // lands and drop the live buffer it supersedes.
        //
        // Timing is the whole problem: `busy` flips on the run's result event, but
        // the SDK writes the assistant turn to the .jsonl independently — a read
        // fired the instant the turn ends often returns the user message and
        // nothing after it, and clearing the live lines against that wipes the
        // answer off the screen. So only accept a read that has demonstrably
        // caught up, poll briefly while it hasn't, and keep the streamed text if
        // it never does. Showing streamed text beats showing nothing.
        .onChange(of: client.busy) { was, now in
            guard ownsFocus else { return }
            if !was, now {
                // A new turn starts → forget the last answer's enrichment. Keyed
                // on text alone, a turn that ends with the same words as the
                // previous one («Готово.») would inherit its buttons (web Chat.tsx).
                llmEnrich = nil
                // Same for what was dismissed or drafted: those are keyed on
                // the text too, and a new turn is a new strip.
                answeredKey = nil
                draftedIdeas = []
                pendingConverge = true
                historyConnectionEpoch = nil
                historyState.cancelForTurnStart()
                convergenceTask?.cancel()
                return
            }
            guard was, !now, pendingConverge, !historyState.isFocusReading else { return }
            convergenceTask?.cancel()
            convergenceTask = Task { await converge() }
        }
        // The backstop for a convergence that gave up. It polls ~3 s after idle,
        // but the hub can learn of the file's last write later than that — on
        // stage the final answer reached it 9 s late (07.10.2026), every read
        // came back without it, and the chat sat on «Пишу страницу. ⚙ 8» until
        // the session was reopened: nothing re-read once the hub caught up.
        // The session's mtime moving is exactly that news, so re-converge on it
        // whenever the turn is idle. Not only when the shown history looks
        // behind: an old copy usually ends in an EARLIER answered pair, which
        // reads as caught up. Idle sessions rarely move, so this is cheap.
        // Opened before the session reached the list: `onFocus` had no cwd to
        // read with and returned. Nothing else re-reads — the focus key is the
        // session id, which does not change — so the chat stayed blank for good
        // (16.10.2026, sessions opened from the phone minutes after they began).
        .onChange(of: session?.cwd) { was, now in
            // A chat begun here already shows its live turn; the convergence
            // pass at the end of that turn reads the file.
            guard was == nil, now != nil, ownsFocus, !showMirror, history.isEmpty,
                  client.lines.isEmpty else { return }
            Task { await loadHistory() }
        }
        .onChange(of: session?.lastModified) { _, _ in
            guard ownsFocus, !client.busy, !showMirror else { return }
            // A focus read is in flight and may already be the old copy: leave
            // the news for it — `onFocus` converges after its read when owed.
            if historyState.isFocusReading { pendingConverge = true; return }
            // Nothing shown yet — the session just reached the list (its cwd
            // arrived in the same update) or an earlier read failed. That is a
            // first read, not convergence: the cwd handler owns it, and a
            // convergence pass started here would supersede it.
            // After a failed read, the file moving is a reason to try again.
            // Live lines on screen (a chat begun here) still need convergence.
            if history.isEmpty, client.lines.isEmpty, !historyState.confirmedCurrent {
                if historyState.failed, !historyState.loading { Task { await loadHistory() } }
                return
            }
            convergenceTask?.cancel()
            convergenceTask = Task { await converge() }
        }
        // Only release the focus if THIS session still owns it. Pushing session B
        // over A fires B's `.task` (focus B) before A's `.onDisappear`; an
        // unconditional unfocus would then tear down B's fresh subscription.
        .onDisappear {
            historyState.cancel()
            convergenceTask?.cancel()
            if client.active?.machineId == machineId, client.active?.sessionId == sessionId { client.unfocus() }
            takeoverTask?.cancel()
        }
        .onChange(of: client.toolReq, initial: true) { _, req in presentedTool = req }
        // The run is the source of truth for its permission mode; this used to ride
        // along on the header's Picker and had to move with it.
        .onChange(of: client.permissionMode, initial: true) { _, mode in
            if let mode, mode != .unknown { permissionMode = mode }
        }
        // Same for model and reasoning: the run is the source of truth. Without
        // this the pickers only ever showed this client's own last write, so a
        // change made from the web — or the runtime's own resolution — never
        // reached them.
        .onChange(of: client.runSettings, initial: true) { _, settings in
            guard ownsFocus, let settings else { return }
            selectedModel = settings.model ?? ""
            if let choice = settings.effortChoice { effort = choice }
        }
        // A refused resume surfaces as an error frame, never as a run: the quick
        // reply that started it goes into the composer draft, where a typed
        // message would have been, instead of vanishing.
        .onChange(of: client.lastError) { _, err in
            guard err != nil, let text = pendingResume else { return }
            pendingResume = nil
            // A private machine's words are not parked on disk (docs/E2EE.md): they come
            // back through memory, into the composer.
            if client.isPrivateMachine(machineId) {
                ideaSeed = ComposerSeed(text: text, images: [])
                return
            }
            if DraftStore.load(draftKey, scope: client.storageScope).isEmpty { DraftStore.save(draftKey, text, scope: client.storageScope) }
            draftReload += 1
        }
        .onChange(of: client.active?.runId) { _, runId in
            if runId != nil { pendingResume = nil }
        }
    }

    /// Всё, что поднимается НАД экраном. Вынесено отдельной функцией по той же
    /// причине, по которой разрезан `body`: вместе с корпусом это одно
    /// выражение, которое компилятор больше не берётся проверить.
    private func presentations(_ view: some View) -> some View {
        view
        // A send to a private machine that did not go out: the words return to the composer.
        .onChange(of: client.failedPrivate.count, initial: true) { _, _ in
            let back = client.takeFailedPrivate(machineId: machineId, sessionId: sessionId)
            guard !back.isEmpty else { return }
            ideaSeed = ComposerSeed(text: back.map(\.text).joined(separator: "\n\n"),
                                    images: back.flatMap(\.images))
        }
        .sheet(item: $presentedTool) { req in
            if req.tool == "AskUserQuestion" || req.tool == "EnterPlanMode" || req.tool == "ExitPlanMode" {
                QuestionSheet(request: req) { allow, updated, mode in
                    if client.toolReq?.id == req.id {
                        client.decideTool(allow: allow, updatedInput: updated, permissionMode: mode)
                    }
                }
            } else {
                ToolApprovalSheet(request: req) { allow in
                    if client.toolReq?.id == req.id { client.decideTool(allow: allow) }
                }
            }
        }
        .sheet(isPresented: $showInfo) {
            if let session {
                SessionInfoSheet(session: session, machineId: machineId,
                                 machineName: machineName ?? machineId,
                                 canControl: canEdit, canDrive: canDrive,
                                 canRename: canEdit || canStartHere)
            }
        }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if client.isLocked(machineId) {
            // Private machine, no key on this phone: say so, with the way out,
            // instead of an empty or broken transcript (docs/E2EE.md).
            LockedSessionView(machineId: machineId, machineName: machineName ?? machineId)
        } else if showMirror, let session {
            MirrorView(machineId: machineId, session: session, takingOver: takingOver,
                       readOnly: isCodex,
                       onTakeOver: startTakeover, onForceTakeOver: forceTakeover,
                       onSendTakeover: { text in
                           takingOver = false
                           takeoverTask?.cancel()
                           client.takeover(machineId: machineId, sessionId: sessionId, message: text)
                       })
                .id(SessionRoute(machineId: machineId, sessionId: sessionId))
        } else {
            // The composer hangs off the transcript's BOTTOM SAFE AREA rather than
            // sitting next to it in a VStack. Stacked, it was covered by the
            // keyboard: this screen hides the tab bar (`.toolbar(.hidden, for:
            // .tabBar)`) inside a NavigationStack pushed from a TabView, and
            // SwiftUI's automatic keyboard avoidance then insets against a safe
            // area that still counts the tab bar — the bar lands short by roughly
            // its height and the send button ends up under the keys.
            //
            // As a safe-area inset the composer is part of what the ScrollView
            // insets its content by, so `.defaultScrollAnchor(.bottom)` parks the
            // newest line directly above it — and keeps doing so as the field
            // grows to its six-line limit or a banner appears, neither of which
            // used to re-pin anything.
            ChatViewGate(chat: ChatView(history: history, loadingHist: loadingHist,
                     historyFailed: historyState.failed && !showMirror,
                     waitingForSession: waitingForSession && !showMirror,
                     onRetryHistory: { Task { await loadHistory() } },
                     agent: agentName(session?.source),
                     answerCompleted: answerCompleted,
                     onContinue: answerCompleted && enrichGate ? continueTask : nil,
                     canLoadEarlier: canLoadEarlier, loadingEarlier: loadingEarlier,
                     onLoadEarlier: { Task { await loadEarlier() } },
                     subagentScope: SubagentScope(machineId: machineId, sessionId: sessionId,
                                                  cwd: session?.cwd, source: session?.source,
                                                  canStop: canDrive && isActive)))
                .equatable()
                .id(SessionRoute(machineId: machineId, sessionId: sessionId))
                .chatEdgeFade()
                .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        }
    }

    /// Everything that sits under the transcript: the tool banner, whichever
    /// status banner applies, and the composer itself.
    @ViewBuilder private var bottomBar: some View {
        VStack(spacing: 0) {
            if client.hasLeftoverKey(for: machineId) { LeftoverKeyBanner(machineId: machineId) }
            RateLimitBanner(machineId: machineId)
            if client.toolReq != nil && presentedTool == nil { pendingToolBanner }
            if session?.isArchived == true {
                archivedBanner
            } else if !canDrive {
                readOnlyBanner
            } else if let run = erroredRun {
                stuckRunBanner(runId: run.runId)
            } else if isBlocked {
                blockedSessionBanner
            } else {
                // Offline is not read-only: the composer stays, sends go to
                // the persistent queue, and the banner says exactly that.
                if !machineOnline { offlineBanner }
                if !queued.isEmpty { pendingStrip }
                // Pinned with the composer, not lost in the transcript's tail:
                // the suggestion is the next move, so it sits where the thumb
                // already is (13.10.2026).
                // How far along the turn is: only while it runs, and only when
                // the model keeps a plan (`mcp__hegai__plan` / TodoWrite).
                if isActive, client.busy,
                   let plan = CurrentPlan.current(history: history, lines: client.lines) {
                    PlanStrip(plan: plan)
                }
                if let enrichment, showEnrichGate {
                    EnrichStrip(enrichment: enrichment, onReply: quickReply, onIdea: draftIdea,
                                onDismiss: dismissEnrichment)
                }
                ComposerView(isActive: isActive,
                             draftKey: draftKey,
                             onSend: send,
                             draftReload: draftReload,
                             seed: ideaSeed,
                             onSeedTaken: { ideaSeed = nil },
                             polishContext: { raw in
                                 // Project, title and the end of the conversation:
                                 // the vocabulary the person is likely to say.
                                 PolishRequest(text: raw,
                                               project: session?.cwd.map { ($0 as NSString).lastPathComponent },
                                               title: sessionName,
                                               recent: PolishRequest.recent(history))
                             },
                             privateMachine: client.isPrivateMachine(machineId)) {
                    SessionRunPicker(machineId: machineId, sessionId: sessionId, isCodex: isCodex,
                                     runId: isActive ? client.active?.runId : nil,
                                     models: models, selectedModel: $selectedModel,
                                     permissionMode: $permissionMode, effort: $effort)
                }
            }
        }
    }


    /// Имя сессии — через ОБЩУЮ функцию, ту же, что у строки шторки.
    private var sessionName: String {
        guard let session else { return compactSessionName(title: nil, sessionId: sessionId) }
        return client.navigationTitles.label(machineId: machineId, session: session)
    }

    private var pendingToolBanner: some View {
        Button { presentedTool = client.toolReq } label: {
            HStack(spacing: Theme.s2) {
                Image(systemName: "exclamationmark.bubble.fill").foregroundStyle(Theme.purpleText)
                Text("Ждёт подтверждения инструмента").font(.ui(Theme.sizeMeta, weight: .medium)).foregroundStyle(Theme.text)
                Spacer()
                Text("Открыть").font(.ui(Theme.sizeMeta, weight: .semibold)).foregroundStyle(Theme.link)
            }
            .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
            .background(Theme.surfaceSunken)
        }
    }

    /// A run that errored still owns the session on the hub. Closing it is the only
    /// way back to a composer, so make that one tap rather than a toast the user
    /// cannot act on.
    private func stuckRunBanner(runId: String) -> some View {
        recoveryBanner(
            icon: "exclamationmark.triangle.fill",
            text: "Ран завершился ошибкой и всё ещё держит сессию.",
            action: "Закрыть ран"
        ) {
            client.closeRun(runId: runId)
            client.rescan(machineId: machineId)
        }
    }

    private var blockedSessionBanner: some View {
        recoveryBanner(
            icon: "lock.fill",
            text: "Сессия занята раном, который отсюда не виден.",
            action: "Закрыть и продолжить"
        ) {
            client.endSession(machineId: machineId, sessionId: sessionId)
        }
    }

    private func recoveryBanner(icon: String, text: String, action: String,
                                perform: @escaping () -> Void) -> some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: icon).font(.system(size: 13)).foregroundStyle(Theme.orangeText)  // бокс глифа
            Text(text).font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted)
            Spacer(minLength: Theme.s2)
            // Кнопка продукта, а не `.borderedProminent` с ember-тинтом:
            // системная рисовалась единственной оранжевой плашкой в приложении
            // и с чужой геометрией.
            ActionButton(action) {
                perform()
                Haptics.rigid()
            }
        }
        .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s3)
        .background(.bar)
    }

    private var readOnlyBanner: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: "eye").font(.system(size: 13))  // бокс глифа
            Text("Общая сессия · только просмотр. Открытия видны в аудите рабочего пространства.")
                .font(.ui(Theme.sizeMicro))
            Spacer()
        }
        .foregroundStyle(Theme.textMuted)
        .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s3)
        .background(.bar)
    }

    /// The hub refuses to open an archived session; a composer here would
    /// promise a continuation that cannot happen.
    private var archivedBanner: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: "archivebox").font(.system(size: 13))  // бокс глифа
            Text("Архив: файл переписки удалён с машины, история сохранена на сервере. Читать можно, продолжить нельзя.")
                .font(.ui(Theme.sizeMicro))
            Spacer()
        }
        .foregroundStyle(Theme.textMuted)
        .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s3)
        .background(.bar)
        .accessibilityIdentifier("session.archived")
    }

    private var offlineBanner: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: "icloud.slash")
            Text("Машина офлайн · сообщения уйдут, когда связь вернётся")
                .font(.ui(Theme.sizeMeta, weight: .medium))
            Spacer()
        }
        .foregroundStyle(Theme.textMuted)
        .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s3)
        .background(.bar)
    }

    /// Messages waiting out a dead connection, one chip each — visible, ordered,
    /// and removable, so "did my message go?" never needs guessing.
    private var queued: [PendingMessage] {
        client.pendingFor(machineId: machineId, sessionId: sessionId)
    }

    private var pendingStrip: some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            ForEach(queued) { msg in
                HStack(spacing: Theme.s2) {
                    Image(systemName: "clock").font(.system(size: 12))  // бокс глифа
                        .foregroundStyle(Theme.orangeText)
                    Text(msg.text.isEmpty ? "📎 Вложение" : msg.text)
                        .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                    if !msg.images.isEmpty {
                        Text("· \(msg.images.count) фото").font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                    }
                    Spacer(minLength: Theme.s2)
                    Button {
                        client.removePending(msg.id)
                        Haptics.light()
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))  // бокс глифа
                            .foregroundStyle(Theme.textFaint)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, Theme.s3).padding(.vertical, 6)
                .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: Theme.radiusSm))
            }
        }
        .padding(.horizontal, Theme.s3)
        .padding(.top, Theme.s2)
        .accessibilityLabel("Сообщения в очереди: \(queued.count)")
    }

    /// The in-view session header: who you are talking to, where it runs, and
    /// the one menu. Opaque, so nothing scrolls under it. macOS only now — the
    /// iPhone's copy existed for the «Колонки» pane, which is gone. The subtitle
    /// doubles as the connection status.
    private var sessionHeader: some View {
        HStack(spacing: Theme.s3) {
            Button { showInfo = true } label: {
                HStack(spacing: Theme.s3) {
                    if sessionActivity == .working {
                        SessionActivityIcon(isCodex: isCodex, isOpenCode: isOpenCode, size: 13)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(cleanTitle(session?.title).isEmpty ? "Сессия" : cleanTitle(session?.title))
                            .font(.ui(Theme.sizeSmall, weight: .semibold)).foregroundStyle(Theme.text)
                            .lineLimit(1)
                        HStack(spacing: Theme.s2) {
                            if client.status != .open {
                                Text("переподключение…")
                                    .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.orangeText)
                            } else if let machineName {
                                Text(machineName).font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                            }
                            if let project = session?.project {
                                Text(project).font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                            }
                        }
                        .lineLimit(1)
                    }
                }
            }
            .buttonStyle(.plain)

            Spacer(minLength: Theme.s3)

            if session?.isCodex == true { CodexBadge() }
            if session?.isLive == true { LiveBadge() }
        }
        .padding(.horizontal, Theme.s4)
        .padding(.vertical, Theme.s2)
        .background(Theme.surface)
    }

    // MARK: Actions

    /// Session identity + connection generation. A new socket means the transcript
    /// may have moved on without us, so focus and history re-run.
    /// `keys`: a key added or forgotten (a private machine) re-reads the session.
    private struct FocusKey: Equatable { let session: String; let connection: Int; let keys: Int }

    private func onFocus() async {
        // Blank ONLY when the session actually changed. This also runs on every
        // reconnect, and clearing here left the transcript empty across the
        // `listModels` round-trip below — an empty scroller collapses to the top,
        // and that is what you came back to after the phone woke up.
        let identity = historyIdentity
        // Not in this account's inventory (deleted, access revoked, or not
        // listed yet): a kept copy is not shown — the screen waits for the
        // session as it always did.
        if session?.cwd == nil { SessionHistoryShelf.shared.forget(identity) }
        historyState.select(identity)
        let focusRead = historyState.beginFocusRead()
        defer { historyState.endFocusRead(focusRead) }
        client.focusSession(machineId: machineId, sessionId: sessionId)
        if shownSessionId != identity {
            // Each session keeps its own history now, so selecting this one no
            // longer cancels the last one's read or convergence — whose finish
            // would clear THIS session's live lines.
            convergenceTask?.cancel()
            SessionHistoryShelf.shared.kept(shownSessionId)?.cancel()
            shownSessionId = identity
            pendingConverge = false
            llmEnrich = nil
            answeredKey = nil
            draftedIdeas = []
            ideaSeed = nil
            pendingResume = nil
            models = isCodex ? [] : DEFAULT_MODELS
            selectedModel = client.runSettings?.model ?? ""
            // Окно принадлежит СЕССИИ: открыв соседнюю, не надо тащить в неё
            // чужие три тысячи ходов.
        }
        // Ask the RUNTIME this session actually runs on: Codex's model ids are
        // not Claude's, and the app-server answers `model/list` for itself. One
        // unkeyed call served a Codex session the Claude list, which is only
        // invisible while the control is hidden — and it no longer is.
        async let modelRefresh: Void = refreshModels()
        // A live, editor-owned session renders the read-only Mirror (which streams
        // the transcript tail) — its full history is never shown here, and pulling
        // it can be huge. Only load history for the sessions that actually display it.
        guard !showMirror, !Task.isCancelled else { return }
        // Reading while a turn is in flight yields a file that is missing the part
        // already streamed; flag it so the convergence pass re-reads after idle.
        pendingConverge = pendingConverge || client.busy
        // Reconnect can keep busy=true without an observable false→true edge.
        if pendingConverge { historyState.cancelForTurnStart() }
        await loadHistory()
        let mayClearLines = historyState.endFocusRead(focusRead)
        // Idle may have arrived while the initial read was awaiting cache/IO.
        // Keep that base transcript before convergence takes ownership of reads.
        if ownsFocus, !Task.isCancelled, !client.busy, pendingConverge {
            convergenceTask?.cancel()
            convergenceTask = Task { await converge() }
        }
        // The streamed lines that survived the reconnect (see `focusSession`) are
        // superseded once the file demonstrably contains the turn they belong to.
        // While a turn is still in flight they stay — the convergence pass owns
        // that case at idle.
        if mayClearLines, ownsFocus, !Task.isCancelled, !client.busy, historyState.confirmedCurrent,
           !historyState.lastReadStale,
           SessionHistory.caughtUp(history) { client.clearLines() }
        await modelRefresh
    }

    private func refreshModels() async {
        if machineOnline,
           let fetched = try? await client.listModels(machineId: machineId, source: isCodex ? "codex" : nil),
           !Task.isCancelled, ownsFocus {
            models = fetched
        }
    }

    private var ownsFocus: Bool {
        client.active?.machineId == machineId && client.active?.sessionId == sessionId
    }

    private func readHistory(limit: Int?) async throws -> HistoryPage {
        guard let cwd = session?.cwd else { throw ClientError.connectionClosed }
        return try await client.sessionMessagesPage(machineId: machineId, cwd: cwd,
            sessionId: sessionId, source: session?.source,
            lastModified: limit == nil ? session?.lastModified : nil, limit: limit)
    }

    private func loadHistory(preservingConfirmedTail: Bool = false) async {
        guard session?.cwd != nil else { return }
        let epoch = client.connectionEpoch
        let mtime = session?.lastModified
        await historyState.load(preservingConfirmedTail: preservingConfirmedTail, mtime: mtime, cached: {
            await client.cachedMessages(machineId: machineId, sessionId: sessionId)
        }, isFresh: {
            guard let mtime else { return false }
            return await client.hasFreshCache(machineId: machineId, sessionId: sessionId, lastModified: mtime)
        }, readPage: { try await readHistory(limit: $0) })
        if epoch == client.connectionEpoch, !Task.isCancelled, historyState.confirmedCurrent {
            historyConnectionEpoch = epoch
        }
    }

    private func loadEarlier() async {
        guard historyState.expand() else { return }
        await loadHistory(preservingConfirmedTail: true)
    }

    private func converge() async {
        let epoch = client.connectionEpoch
        let converged = await historyState.converge(readPage: { try await readHistory(limit: $0) })
        if converged, epoch == client.connectionEpoch, !Task.isCancelled { historyConnectionEpoch = epoch }
        if converged, epoch == client.connectionEpoch, ownsFocus, !Task.isCancelled, !client.busy {
            // Keep this requirement across reconnects and failed refreshes until
            // the current transcript actually supersedes the live answer.
            pendingConverge = false
            client.clearLines()
        }
    }

    /// Clear the draft only when sent or durably queued. A disk failure keeps
    /// the composer intact and reports why the message could not be saved.
    private func send(_ text: String, _ images: [ImageAttachment]) -> Bool {
        guard !client.isChangingModel else { return false }
        // Order is sacred: while earlier messages still wait in the queue, a new
        // one must join the line, not jump it.
        if client.status != .open || !machineOnline || !queued.isEmpty {
            return client.queuePending(machineId: machineId, sessionId: sessionId,
                                text: text, images: images)
        }
        let sent = isActive
            ? client.sendInput(text, images: images)
            : client.open(machineId: machineId, sessionId: sessionId,
                          message: text.isEmpty ? nil : text, images: images)
        if sent { return true }
        // The socket died between the check and the write — same answer: keep it.
        return client.queuePending(machineId: machineId, sessionId: sessionId,
                            text: text, images: images)
    }

    private func requestEnrichment() async {
        // No stored answer for this tail yet. A pass that was cancelled (the
        // gate flipped, the tail moved on) stored nothing and is asked again.
        guard let tail = enrichTail, enrichGate, llmEnrich?.key != tail.key else { return }
        let echoed = EnrichTailFinder.echoedUserText(history: history, lines: client.lines)
        let digest = EnrichDigest.build(history: history, live: client.lines, cwd: session?.cwd,
                                        clean: EnrichTailFinder.clean)
        let state = await client.enrichState(
            machineId: machineId, sessionId: sessionId, source: session?.source,
            // The end of the turn, where the question lives (web ENRICH_MAX_INPUT).
            uuid: tail.uuid, text: String(tail.text.suffix(15_000)),
            userText: echoed.map { String($0.prefix(4000)) }, digest: digest)
        guard !Task.isCancelled else { return }
        llmEnrich = LlmEnrich(key: tail.key, state: state)
    }

    /// One tap answers the question the turn ends with: a live run takes it as
    /// input, a dormant session resumes on it, an offline machine queues it.
    /// The strip hides at once — the echoed user line flips the tail anyway.
    private func quickReply(_ reply: Enrichment.QuickReply) {
        guard let tail = enrichTail else { return }
        let resuming = !isActive
        guard send(reply.send, []) else { return }
        if resuming { pendingResume = reply.send }
        answeredKey = tail.key
    }

    /// An idea is a thought, not an instruction: it lands in the composer
    /// AFTER whatever is already typed (`ComposerView.takeSeed` never
    /// overwrites a draft), the field takes focus, and nothing is sent.
    private func draftIdea(_ idea: Enrichment.QuickReply) {
        guard let tail = enrichTail else { return }
        draftedIdeas.insert("\(tail.key)|\(idea.send.trimmingCharacters(in: .whitespacesAndNewlines))")
        ideaSeed = ComposerSeed(text: idea.send, images: [], focuses: true)
    }

    /// The ✕: no suggestions for this turn. A new turn brings its own.
    private func dismissEnrichment() {
        answeredKey = enrichTail?.key
    }

    private func continueTask() {
        guard answerCompleted, enrichGate else { return }
        quickReply(Enrichment.QuickReply(label: TurnCompletion.continuation, send: TurnCompletion.continuation))
    }

    /// Cooperative takeover: poll until the editor releases the session, then open.
    private func startTakeover() {
        guard !takingOver else { return }
        takingOver = true
        takeoverTask?.cancel()
        takeoverTask = Task {
            while takingOver && !Task.isCancelled {
                client.rescan(machineId: machineId)
                try? await Task.sleep(for: .milliseconds(2500))
                if session?.livePid == nil {
                    client.open(machineId: machineId, sessionId: sessionId)
                    takingOver = false
                    break
                }
            }
        }
    }

    private func forceTakeover() {
        takingOver = false
        takeoverTask?.cancel()
        client.takeover(machineId: machineId, sessionId: sessionId)
    }

}
