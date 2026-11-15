import SwiftUI
import CCRemoteKit

/// Единственный путь смены команды (старт, лист «Проекты», Настройки): тот же
/// запрет, что у `selectPreferredWorkspace` — пока есть неотправленное или идёт
/// ход, переподключение потеряло бы сообщения.
enum WorkspaceSwitch {
    @MainActor
    @discardableResult
    static func select(_ workspace: WorkspaceSummary, client: CentralClient, settings: AppSettings) -> Bool {
        guard workspace.workspaceId != client.viewer?.workspace.workspaceId else {
            // Picking the current team is still a choice: it cancels a remembered
            // one that pending work postponed, or the queue would drain into it.
            settings.workspaceId = workspace.workspaceId
            return true
        }
        guard !client.hasPendingWork else {
            client.flashError("Дождитесь отправки сообщений", ms: 3000)
            Haptics.light()
            return false
        }
        settings.workspaceId = workspace.workspaceId
        client.switchWorkspace(workspace.workspaceId)
        Haptics.light()
        return true
    }
}

/// Имя текущей команды и ▾; меню — только команды («Моя работа» не предлагается,
/// когда команда есть). Показывается при двух и больше командах.
struct WorkspaceSwitcher: View {
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings

    var body: some View {
        if let viewer = client.viewer, !viewer.switcherChoices.isEmpty {
            let current = viewer.workspace
            Menu {
                ForEach(viewer.switcherChoices) { workspace in
                    Button {
                        WorkspaceSwitch.select(workspace, client: client, settings: settings)
                    } label: {
                        if workspace.workspaceId == current.workspaceId {
                            Label(workspace.displayName, systemImage: "checkmark")
                        } else {
                            Text(workspace.displayName)
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(current.displayName)
                        .font(.ui(Theme.sizeMeta, weight: .medium))
                        .lineLimit(1).truncationMode(.tail)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))  // бокс глифа
                }
                .foregroundStyle(Theme.text)
                .padding(.horizontal, Theme.s3)
                .frame(minHeight: 36)
                .frame(maxWidth: 180)
                .headerIsland()
            }
            .accessibilityIdentifier("start.workspace")
            .accessibilityLabel("Рабочее пространство: \(current.displayName). Сменить")
        }
    }
}
