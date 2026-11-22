import SwiftUI
import CCRemoteKit

/// Только что начатая сессия — до того, как она узнает своё имя.
///
/// `new_session` уходит с ПУСТЫМ `sessionId`: настоящий приходит позже, кадром
/// `session_started`. Значит, адреса, по которому можно было бы открыть
/// `SessionDetailView`, в момент отправки ещё не существует — а показать разговор
/// надо сразу, потому что первый ход уже пошёл.
///
/// Поэтому это отдельный экран, а не «сессия с пустым id»: он привязан не к
/// адресу, а к `client.active`, то есть к живому прогону как таковому. Истории у
/// него нет по определению — она начинается здесь.
struct NewRunView: View {
    /// Куда начали — на случай, если сессия ещё не назвала себя.
    let label: String
    let machineName: String
    let source: String?
    var projectName: String = "Без проекта"
    @State private var headerWidth: CGFloat = 375

    @State private var showInfo = false
    @State private var focusedRunId: String?
    @State private var pendingDraftKey = "pending::\(UUID().uuidString)"
    @State private var assignedDraftKey: String?
    /// Words of a send to a private machine that did not go out, handed back in memory.
    @State private var returnedSeed: ComposerSeed?
    @State private var models: [ModelInfoLite] = []
    @State private var selectedModel = ""
    @State private var permissionMode: PermissionMode = .default
    @State private var effort: EffortChoice = .high
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings
    @Environment(Router.self) private var router

    /// Display name of the agent. OpenCode is a Codex run on a `pool-go/` model,
    /// so it is told apart by the model, not by `source`.
    private var agent: String {
        if let active = client.active,
           let session = client.machines.first(where: { $0.machine.machineId == active.machineId })?
            .sessions.first(where: { $0.sessionId == active.sessionId }) {
            return session.isCodex ? (runIsGo ? "OpenCode" : "Codex") : "Claude"
        }
        return (source ?? settings.preferredAgent) == "claude" ? "Claude" : (runIsGo ? "OpenCode" : "Codex")
    }

    /// The runtime, not the label: OpenCode runs on Codex.
    private var isCodexRun: Bool { agent != "Claude" }

    private var runIsGo: Bool {
        AgentModels.isGoModel(ModelLabel.explicit(client.runSettings?.model)
                              ?? ModelLabel.explicit(client.runSettings?.activeModel))
    }

    /// Words of a send to a private machine that did not go out come back here. Guarded on the
    /// active run only: a send made before `session_started` was recorded under the empty id,
    /// and this screen owns that run; the real id, once known, is asked for as well.
    private func takeReturnedWords() {
        guard let a = client.active else { return }
        var back = client.takeFailedPrivate(machineId: a.machineId, sessionId: "")
        if !a.sessionId.isEmpty { back += client.takeFailedPrivate(machineId: a.machineId, sessionId: a.sessionId) }
        guard !back.isEmpty else { return }
        returnedSeed = ComposerSeed(text: back.map(\.text).joined(separator: "\n\n"), images: back.flatMap(\.images))
    }

    private var draftKey: String {
        assignedDraftKey ?? pendingDraftKey
    }

    /// Helpers of the run once it has a session address; before that there is
    /// nothing to read their transcripts by.
    private var subagentScope: SubagentScope? {
        guard let active = client.active, !active.sessionId.isEmpty else { return nil }
        let machine = client.machines.first { $0.machine.machineId == active.machineId }
        let session = machine?.sessions.first { $0.sessionId == active.sessionId }
        return SubagentScope(machineId: active.machineId, sessionId: active.sessionId, cwd: session?.cwd,
                             source: session?.source ?? (isCodexRun ? "codex" : "claude"),
                             canStop: machine?.canDrive == true && active.runId != nil)
    }

    private var title: String {
        let active = client.active
        let session = client.machines.first { $0.machine.machineId == active?.machineId }?
            .sessions.first { $0.sessionId == active?.sessionId }
        if let session, let active { return client.navigationTitles.label(machineId: active.machineId, session: session) }
        return compactSessionName(title: label)
    }

    private var answerCompleted: Bool {
        guard let active = client.active, client.toolReq == nil, !client.pendingCatchUp else { return false }
        let machine = client.machines.first { $0.machine.machineId == active.machineId }
        return TurnCompletion.isComplete(history: [], lines: client.lines, busy: client.busy,
            connected: client.status == .open && machine?.online == true,
            state: client.runFor(machineId: active.machineId, sessionId: active.sessionId)?.state,
            linesConfirmed: client.hasCurrentAssistantLines)
    }

    private var canContinue: Bool {
        guard answerCompleted, !client.isChangingModel, let active = client.active else { return false }
        return client.machines.first { $0.machine.machineId == active.machineId }?.canDrive == true
    }

    private func continueTask() {
        guard canContinue else { return }
        _ = client.sendInput(TurnCompletion.continuation)
    }

    var body: some View {
        ChatView(history: [], loadingHist: false, agent: agent,
                 answerCompleted: answerCompleted, onContinue: canContinue ? continueTask : nil,
                 subagentScope: subagentScope)
            .chatEdgeFade()
            .background(Theme.bg)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { headerWidth = $0 }
            .task(id: "title:\(client.active?.sessionId ?? ""):\(client.busy)") {
                if let active = client.active,
                   let session = client.machines.first(where: { $0.machine.machineId == active.machineId })?
                    .sessions.first(where: { $0.sessionId == active.sessionId }) {
                    await client.navigationTitles.prepare(client: client, machineId: active.machineId, session: session)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if let machineId = client.active?.machineId { RateLimitBanner(machineId: machineId) }
                    // Тот же ключ черновика, что и у настоящего экрана сессии, —
                    // чтобы набранное здесь не потерялось, когда сессия обзаведётся
                    // своим адресом и откроется уже им.
                    ComposerView(isActive: true,
                                 draftKey: draftKey,
                                 onSend: { client.sendInput($0, images: $1) },
                                 seed: returnedSeed,
                                 onSeedTaken: { returnedSeed = nil },
                                 preservesDraftOnKeyChange: true,
                                 privateMachine: client.active.map { client.isPrivateMachine($0.machineId) } ?? false) {
                        if let active = client.active {
                            SessionRunPicker(machineId: active.machineId, sessionId: active.sessionId, isCodex: isCodexRun,
                                             runId: active.runId, models: models,
                                             selectedModel: $selectedModel, permissionMode: $permissionMode,
                                             effort: $effort)
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                bareToolbarItem { DrawerButton() }
                bareToolbarItem(placement: .trailingActions) { NewChatButton() }
                ToolbarItem(placement: .principal) {
                    Button { showInfo = true } label: {
                        SessionTitle(title: title,
                                            active: client.busy, isCodex: isCodexRun,
                                            isOpenCode: agent == "OpenCode",
                                            availableWidth: headerWidth)
                    }.buttonStyle(.plain)
                        .accessibilityIdentifier("session.titleIsland")
                        .disabled(client.active?.sessionId.isEmpty != false)
                }
            }
            .sheet(isPresented: $showInfo) {
                if let active = client.active,
                   let machine = client.machines.first(where: { $0.machine.machineId == active.machineId }),
                   let session = machine.sessions.first(where: { $0.sessionId == active.sessionId }) {
                    SessionInfoSheet(session: session, machineId: active.machineId,
                                     machineName: machineName,
                                     canControl: ProjectAdmin.canDeleteSession(machine: machine, session: session, viewerId: client.viewer?.userId),
                                     canDrive: machine.canDrive,
                                     canRename: machine.hasControl || machine.canStartHere)
                } else {
                    Text("Сведения о сессии ещё загружаются").padding()
                }
            }
            // Уйти с экрана — значит отпустить прогон. Без этого хаб продолжает
            // считать, что на него смотрят, и шлёт поток в никуда.
            .onAppear { captureSessionIdentity() }
            .onChange(of: client.failedPrivate.count, initial: true) { _, _ in takeReturnedWords() }
            .onChange(of: client.active?.sessionId) { _, _ in takeReturnedWords() }
            .onChange(of: client.active?.runId) { _, _ in captureSessionIdentity() }
            .onChange(of: client.active?.sessionId) { _, _ in captureSessionIdentity() }
            .task(id: client.active?.machineId) {
                guard let machineId = client.active?.machineId else { return }
                if let result = try? await client.listModels(machineId: machineId, source: isCodexRun ? "codex" : nil),
                   !Task.isCancelled { models = result }
            }
            .onChange(of: client.runSettings, initial: true) { _, value in
                selectedModel = value?.model ?? ""
                if let choice = value?.effortChoice { effort = choice }
            }
            .onChange(of: client.permissionMode, initial: true) { _, mode in
                if let mode, mode != .unknown { permissionMode = mode }
            }
            .onDisappear {
                // Opening the same conversation from its new drawer row keeps
                // its live subscription; the destination now owns that focus.
                if let route = router.currentSession, route.machineId == client.active?.machineId,
                   route.sessionId == client.active?.sessionId { return }
                if let focusedRunId, client.active?.runId == focusedRunId { client.unfocus() }
            }
    }

    private func captureSessionIdentity() {
        guard let active = client.active else { return }
        if focusedRunId == nil { focusedRunId = active.runId }
        guard let focusedRunId, active.runId == focusedRunId,
              assignedDraftKey == nil, !active.sessionId.isEmpty else { return }
        // Latch once. Switching to another conversation or unfocusing on exit
        // must never move this draft into that conversation or back to pending.
        assignedDraftKey = "\(active.machineId)::\(active.sessionId)"
    }
}
