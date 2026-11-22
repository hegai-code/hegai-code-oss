import SwiftUI
import CCRemoteKit

/// «Удалить» в контекстном меню строки сессии — то, что веб делает из меню
/// сессии (`deleteSession` в appHooks.ts): тот же вопрос, тот же RPC
/// `session.delete`, ту же запись убирает с машины. Живую сессию агент сначала
/// останавливает сам (`releaseForDelete`), отдельного предупреждения у веба нет.
/// Показывается там, где веб разрешает (`ProjectAdmin.canDeleteSession`).
struct SessionContextMenu<Items: View>: ViewModifier {
    let machineId: String
    let session: SessionSummary
    let menu: Items

    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @State private var confirm = false

    private var allowed: Bool {
        ProjectAdmin.canDeleteSession(machine: client.machines.first { $0.machine.machineId == machineId },
                                      session: session, viewerId: client.effectiveViewerId)
            && session.cwd != nil
    }

    func body(content: Content) -> some View {
        content
            .contextMenu {
                menu
                if allowed {
                    Button(role: .destructive) { confirm = true } label: {
                        Label("Удалить", systemImage: "trash")
                    }
                }
            }
            .confirmationDialog(ProjectAdmin.deleteSessionConfirmation, isPresented: $confirm,
                                titleVisibility: .visible) {
                Button("Удалить", role: .destructive) { Task { await delete() } }
                Button("Отмена", role: .cancel) {}
            }
    }

    private func delete() async {
        guard let cwd = session.cwd else { return }
        do {
            try await client.deleteSession(machineId: machineId, cwd: cwd, sessionId: session.sessionId,
                                           source: session.source)
            if router.currentSession?.id == "\(machineId)::\(session.sessionId)" { router.home() }
            client.rescan(machineId: machineId)
            Haptics.success()
        } catch {
            client.flashError("Не удалось удалить: \(error.localizedDescription)")
            Haptics.warning()
        }
    }
}

extension View {
    func sessionContextMenu<M: View>(machineId: String, session: SessionSummary,
                                     @ViewBuilder _ menu: () -> M) -> some View {
        modifier(SessionContextMenu(machineId: machineId, session: session, menu: menu()))
    }
}
