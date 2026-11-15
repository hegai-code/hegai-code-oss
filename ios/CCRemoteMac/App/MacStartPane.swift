import SwiftUI
import CCRemoteKit

/// The start screen — what the sessions detail shows when nothing is selected.
/// A port of the web's StartScreen: greet, pick a project, describe the task,
/// go. Landing place for ⌘N (`router.startFocusTick` focuses the composer).
struct MacStartPane: View {
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings
    @Environment(Router.self) private var router

    @State private var target: StartTarget?
    @State private var task = ""
    @State private var attachments: [ImageAttachment] = []
    /// Owned here, not by the button: the recognizer must outlive a control the
    /// composer swaps out as soon as there is text to send.
    @State private var dictation = SpeechDictation()
    @State private var category: SessionCategory?
    @State private var showPicker = false
    @State private var pickerQuery = ""
    @State private var customMode = false
    @State private var customPath = ""
    @State private var customMachineId = ""
    /// Model / permissions / reasoning for the session about to start,
    /// remembered per machine AND engine (see `StartRunStore`).
    @State private var startRun = StartRunSettings()
    /// Sent `new_session`, waiting for the hub's `session_started` to give the
    /// real id — then we route to the session and the detail swaps under us.
    @State private var starting = false
    @FocusState private var composerFocused: Bool

    /// Control-shares published to the workspace — targets a member can start
    /// in even when the inventory shows them no sessions there yet.
    @State private var shareTargets: [StartTarget] = []

    private var targets: [StartTarget] {
        let derived = StartTargets.derive(from: client.machines)
        let known = Set(derived.map(\.id))
        return derived + shareTargets.filter { !known.contains($0.id) }
    }
    private var onlineMachines: [MachineSnapshot] {
        client.machines.filter(\.online).sorted {
            $0.machine.name.localizedCaseInsensitiveCompare($1.machine.name) == .orderedAscending
        }
    }
    /// Members don't pick an agent — the hub routes them to Codex regardless,
    /// so offering the choice would be a lie (web parity).
    private var isMember: Bool { client.viewer?.workspace.role == "member" }
    /// The runtime this start will actually land on. The model list and the mode
    /// list both differ per engine, so this — not `preferredAgent` — keys them.
    private var engine: String { isMember ? "codex" : settings.preferredAgent }
    /// Machine + engine: the pair the remembered pick belongs to.
    private var startRunKey: String { "\(target?.machineId ?? "")::\(engine)" }
    private var canSend: Bool {
        target != nil && !starting &&
            (!task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }
    private var recentItems: [SessionItem] {
        Array(ProjectGrouping.allItems(from: client.machines)
            .sorted { $0.session.lastModified > $1.session.lastModified }
            .prefix(6))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s5) {
                MacStartGreeting(fullName: client.viewer?.fullName)
                MacStartComposer(
                    target: $target,
                    task: $task,
                    attachments: $attachments,
                    dictation: dictation,
                    category: $category,
                    showPicker: $showPicker,
                    pickerQuery: $pickerQuery,
                    customMode: $customMode,
                    customPath: $customPath,
                    customMachineId: $customMachineId,
                    startRun: $startRun,
                    targets: targets,
                    onlineMachines: onlineMachines,
                    isMember: isMember,
                    isCodex: engine == "codex",
                    starting: starting,
                    canSend: canSend,
                    composerFocus: $composerFocused,
                    onStart: start
                )
                MacStartQuickActions(recentItems: recentItems)
                if !client.activeRuns.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        SectionLabel(text: "Активная работа", count: client.activeRuns.count)
                        ForEach(client.activeRuns) {
                            MacActiveRunRow(run: $0, presentation: .compact)
                        }
                    }
                }
                if !recentItems.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        SectionLabel(text: "Недавние")
                            .padding(.bottom, Theme.s2)
                        ForEach(recentItems) { SessionRow(item: $0, showProject: true) }
                    }
                }
            }
            .padding(Theme.s6)
            .frame(maxWidth: 680, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg)
        .onAppear { setupDefault(); composerFocused = true }
        .task(id: client.viewer?.workspace.workspaceId) { await loadShareTargets() }
        .onChange(of: client.machines.count) { _, _ in if target == nil { setupDefault() } }
        .onChange(of: router.startFocusTick) { _, _ in composerFocused = true }
        // The pick belongs to the machine+engine pair, so moving to either one
        // reloads rather than carries: a Codex model id means nothing to Claude,
        // and `bypassPermissions` offered on one box is withheld on the next.
        .onChange(of: startRunKey, initial: true) { _, _ in
            startRun = StartRunStore.load(machineId: target?.machineId ?? "", engine: engine)
        }
        .onChange(of: startRun) { _, next in
            StartRunStore.save(next, machineId: target?.machineId ?? "", engine: engine)
        }
        // `newSession` opens with an empty session id; `session_started` fills in
        // the real one — that is the moment this pane hands over to the workspace.
        .onChange(of: client.active?.sessionId) { _, sid in
            guard starting, let sid, !sid.isEmpty, let machineId = client.active?.machineId else { return }
            starting = false
            task = ""
            attachments = []
            router.openSession(machineId: machineId, sessionId: sid)
        }
    }

    // MARK: Actions

    private func loadShareTargets() async {
        guard let workspaceId = client.viewer?.workspace.workspaceId else { return }
        guard let shares = try? await client.team.projects(workspaceId: workspaceId) else { return }
        shareTargets = shares.filter(\.isControl).map { share in
            StartTarget(machineId: share.machineId,
                        machineName: client.machines.first { $0.machine.machineId == share.machineId }?
                            .machine.name ?? share.machineId,
                        cwd: share.root, label: share.name, lastModified: share.createdAt, count: 0)
        }
        if target == nil { setupDefault() }
    }

    private func setupDefault() {
        guard target == nil else { return }
        let all = targets
        if let mid = router.selectedMachineId, let t = all.first(where: { $0.machineId == mid }) {
            target = t
        } else {
            target = all.first
        }
    }

    private func start() {
        guard let t = target, canSend else { return }
        let msg = task.trimmingCharacters(in: .whitespacesAndNewlines)
        // Absent `source` lets the hub decide; an explicit choice rides along
        // for owners/managers only (members get Codex server-side anyway).
        let source: String? = isMember ? nil : settings.preferredAgent
        // The three run settings ride along ADVISORY: the hub drops what this
        // machine cannot honour rather than refusing the start, so a stale pick
        // costs a setting, never the session.
        guard client.newSession(machineId: t.machineId, cwd: t.cwd,
                                message: msg.isEmpty ? nil : msg, images: attachments,
                                category: category, source: source,
                                model: startRun.model, effort: startRun.effort,
                                permissionMode: startRun.permissionMode) else { return }
        starting = true
    }
}
