import SwiftUI
import CCRemoteKit

/// The main menu.
///
/// On a Mac the menu bar is the command registry, not decoration: an action that
/// lives only on a button is undiscoverable, unbindable and invisible to Help
/// search. Every command added to the app belongs here as well as wherever it
/// appears on screen.
///
/// Items stay enabled and guard inside the action instead: `Commands` is not a
/// View, so re-evaluating `.disabled(...)` off `@Observable` state is unreliable —
/// a menu that greys out and never comes back is worse than a no-op.
struct MacCommands: Commands {
    let client: CentralClient
    let router: Router

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Новая сессия") { router.startNewSession() }
                .keyboardShortcut("n", modifiers: .command)
        }
        CommandGroup(after: .textEditing) {
            Button("Поиск сессий…") { router.paletteOpen = true }
                .keyboardShortcut("k", modifiers: .command)
        }
        CommandMenu("Сессия") {
            Button("Обновить список машин") {
                for m in client.machines { client.rescan(machineId: m.machine.machineId) }
            }
            .keyboardShortcut("r", modifiers: .command)
        }
        CommandMenu("Переход") {
            Button("Главная") { router.destination = .home }
                .keyboardShortcut("0", modifiers: .command)
            Divider()
            ForEach(Array(MacDestination.railCases.enumerated()), id: \.element) { idx, dest in
                Button(dest.label) { router.destination = dest }
                    .keyboardShortcut(KeyEquivalent(Character("\(idx + 1)")), modifiers: .command)
            }
        }
    }
}
