import SwiftUI
import CCRemoteKit

/// Runtime controls at the point of writing. Session facts stay in the header.
struct SessionRunPicker: View {
    let machineId: String
    let sessionId: String
    let isCodex: Bool
    let runId: String?
    let models: [ModelInfoLite]
    @Binding var selectedModel: String
    @Binding var permissionMode: PermissionMode
    @Binding var effort: EffortChoice
    @Environment(CentralClient.self) private var client
    @State private var presented = false

    private var settings: RunSettingsInfo? {
        if runId != nil, client.active?.runId == runId, let settings = client.runSettings { return settings }
        return client.sessionSettings.settings(machineId: machineId, sessionId: sessionId)
    }
    /// A Codex thread cannot switch between native Codex and OpenCode (`pool-go/`)
    /// models — the agent refuses — so only the session's own side is offered.
    /// Pending picks are not visible here; the run's settings (or its stored
    /// copy) already carry the model the session is on.
    private var isGoSession: Bool {
        isCodex && AgentModels.isGoModel(ModelLabel.explicit(settings?.model)
                                         ?? ModelLabel.explicit(settings?.activeModel))
    }
    private var offeredModels: [ModelInfoLite] {
        guard isCodex else { return models }
        return AgentModels.rows(models, for: isGoSession ? AgentModels.opencode : "codex")
    }
    private var row: ModelInfoLite? {
        ModelLabel.row(models: models, model: ModelLabel.explicit(settings?.model) ?? settings?.activeModel)
    }
    private var modelLabel: String {
        ModelLabel.name(models: models, model: settings?.model, activeModel: settings?.activeModel)
    }
    private var effortLabel: String? {
        guard row?.supportsEffort != false, let settings else { return nil }
        return settings.ultracode ? "Ultracode" : settings.effort?.composerLabel
    }
    private var modes: [PermissionMode] {
        client.machines.first {
            $0.machine.machineId == machineId
        }?.machine.offeredPermissionModes(isCodex: isCodex) ?? [.default, .plan]
    }
    private var efforts: [EffortChoice] {
        EffortChoice.allCases.filter { choice in
            if choice == .ultracode { return !isCodex }
            return row?.efforts.map { $0.contains(choice.rawValue) } ?? true
        }
    }
    private var canChange: Bool {
        client.status == .open && !client.isChangingModel
            && client.machines.first { $0.machine.machineId == machineId }?.online == true
            && !client.pending.contains { $0.machineId == machineId && $0.sessionId == sessionId }
    }
    private var canTuneRun: Bool { canChange && runId != nil && client.runSettings != nil }

    var body: some View {
        Button { presented = true; Haptics.light() } label: {
            RunSettingsSummary(model: modelLabel, effort: effortLabel)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("composer.settings")
        .accessibilityLabel("Настройка модели")
        .accessibilityValue([modelLabel, effortLabel].compactMap { $0 }.joined(separator: ", "))
        .sheet(isPresented: $presented) { sheet }
    }

    private var sheet: some View {
        RunSettingsSheet(onDone: { presented = false }) {
            if client.isChangingModel {
                ProgressView("Переключаю модель…")
                    .font(.system(.subheadline))
                    .accessibilityIdentifier("runSettings.changingModel")
            } else if !canChange {
                Text("Настройки будут доступны после подключения и отправки очереди.")
                    .font(.system(.subheadline)).foregroundStyle(Theme.drawerSecondary)
            }
            RunSettingGroup {
                if !isGoSession {
                    RunSettingChoice(title: "По умолчанию", subtitle: ModelLabel.name(models: offeredModels, model: nil),
                                     selected: ModelLabel.explicit(settings?.model) == nil) {
                        chooseModel("")
                    }
                }
                ForEach(offeredModels.filter { $0.id != "default" }) { model in
                    if !isGoSession || model.id != offeredModels.first?.id { Divider().padding(.horizontal, 16) }
                    RunSettingChoice(title: model.name ?? model.id, selected: settings?.model == model.id) {
                        chooseModel(model.id)
                    }
                }
            }
            .disabled(!canChange)
            RunSettingGroup {
                if row?.supportsEffort == false || efforts.isEmpty {
                    Text("Эта модель не поддерживает настройку рассуждения")
                        .font(.system(.subheadline)).foregroundStyle(Theme.drawerSecondary).padding(16)
                } else {
                    RunSettingMenu(title: "Рассуждение") {
                        Picker("Рассуждение", selection: effortBinding) {
                            if settings?.effortChoice == nil {
                                Text("Как в аккаунте").tag(Optional<EffortChoice>.none)
                            }
                            ForEach(efforts) { choice in
                                Text(choice.composerLabel).tag(Optional(choice))
                            }
                        }
                        .accessibilityIdentifier("runSettings.effort")
                    }
                }
                Divider().padding(.horizontal, 16)
                RunSettingMenu(title: "Разрешения") {
                    Picker("Разрешения", selection: modeBinding) {
                        ForEach(modes, id: \.self) { mode in Text(mode.label).tag(mode) }
                    }
                    .accessibilityIdentifier("runSettings.permissions")
                }
            }
            .disabled(!canTuneRun)

        }
    }

    private func chooseModel(_ id: String) {
        guard canChange else { return }
        client.changeSessionModel(machineId: machineId, sessionId: sessionId, model: id)
        Haptics.light()
    }
    private var effortBinding: Binding<EffortChoice?> {
        Binding(get: { settings?.effortChoice }, set: { choice in
            guard canTuneRun, let runId, let choice else { return }
            effort = choice
            client.setEffort(runId: runId, effort: choice.effort, ultracode: choice.isUltracode)
            Haptics.light()
        })
    }
    private var modeBinding: Binding<PermissionMode> {
        Binding(get: { permissionMode }, set: { mode in
            guard canTuneRun, let runId else { return }
            permissionMode = mode
            client.setPermissionMode(runId: runId, mode: mode)
            Haptics.light()
        })
    }
}
