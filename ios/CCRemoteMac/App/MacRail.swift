import SwiftUI
import CCRemoteKit

/// Where the app can take you. A Mac-only enum rather than a new `AppTab` case:
/// the phone's tab bar switches exhaustively over `AppTab`, so widening it there
/// would mean editing iOS screens to add destinations iOS does not have.
enum MacDestination: String, Identifiable {
    case home, sessions, board, columns, team, hardware, memory, profile, inbox
    var id: String { rawValue }

    /// What the rail actually lists. Home is reachable through the logo (and ⌘0),
    /// not a rail slot — the web's nav model, where the wordmark is the door.
    static let railCases: [MacDestination] = railGroups.flatMap { $0 }

    /// The web's nav groups (navModel.ts): work / fleet / you. The rail draws a
    /// hairline between groups so ten slots read as three ideas.
    static let railGroups: [[MacDestination]] = [
        [.sessions, .board, .columns],
        [.team, .hardware],
        [.memory, .profile, .inbox],
    ]

    var label: String {
        switch self {
        case .home: return "Главная"
        case .sessions: return "Сессии"
        case .board: return "Доска"
        case .columns: return "Колонки"
        case .team: return "Команда"
        case .hardware: return "Железо"
        case .memory: return "Память"
        case .profile: return "Профиль"
        case .inbox: return "Входящие"
        }
    }

    var systemImage: String {
        switch self {
        case .home: return "house"
        case .sessions: return "bubble.left.and.bubble.right"
        case .board: return "rectangle.split.3x1"
        case .columns: return "rectangle.split.2x1"
        case .team: return "person.2"
        case .hardware: return "cpu"
        case .memory: return "brain.head.profile"
        case .profile: return "gauge"
        case .inbox: return "tray"
        }
    }
}

/// The permanent left rail.
///
/// It is a SIBLING of the contextual column, not its parent — collapsing the
/// sessions sidebar must never take navigation with it. 68pt wide per DESIGN.md,
/// square icon plates, and the unread count rides the Inbox slot.
struct MacRail: View {
    @Binding var selection: MacDestination
    @Environment(CentralClient.self) private var client
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(spacing: Theme.s1) {
            Button { selection = .home } label: {
                HegaiMark(size: 22)
                    .foregroundStyle(selection == .home ? Theme.onSelect : Theme.brand)
                    .frame(width: 40, height: 36)
                    .background(selection == .home ? Theme.select : Color.clear,
                                in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
            }
            .buttonStyle(.plain)
            .help("Главная (⌘0)")
            .padding(.top, Theme.s3)
            .padding(.bottom, Theme.s2)

            ForEach(Array(MacDestination.railGroups.enumerated()), id: \.offset) { idx, group in
                if idx > 0 {
                    Rectangle().fill(Theme.border)
                        .frame(width: 24, height: 1)
                        .padding(.vertical, Theme.s1)
                }
                ForEach(group) { dest in
                    railButton(dest)
                }
            }

            Spacer()

            Button { openSettings() } label: {
                railIcon("gearshape", active: false)
            }
            .buttonStyle(.plain)
            .help("Настройки (⌘,)")
            .padding(.bottom, Theme.s3)
        }
        .frame(width: 68)
        .frame(maxHeight: .infinity)
        .background(Theme.surface)
    }

    private func railButton(_ dest: MacDestination) -> some View {
        Button { selection = dest } label: {
            railIcon(dest.systemImage, active: selection == dest)
                .overlay(alignment: .topTrailing) {
                    if dest == .inbox, client.notifs.unread > 0 {
                        Text("\(min(client.notifs.unread, 99))")
                            .font(.mono(9, weight: .medium))
                            .foregroundStyle(Theme.onAttn)
                            .padding(.horizontal, 4)
                            .frame(minWidth: 15, minHeight: 15)
                            .background(Theme.attn, in: Capsule())
                            .offset(x: 6, y: -4)
                    }
                }
        }
        .buttonStyle(.plain)
        .help(helpText(dest))
    }

    /// Rail slots carry their ⌘-shortcut in the tooltip; numbering matches
    /// `MacCommands` (⌘1 = first rail slot).
    private func helpText(_ dest: MacDestination) -> String {
        if let idx = MacDestination.railCases.firstIndex(of: dest) {
            return "\(dest.label) (⌘\(idx + 1))"
        }
        return dest.label
    }

    private func railIcon(_ name: String, active: Bool) -> some View {
        Image(systemName: name)
            .font(.system(size: 17, weight: .regular))
            .foregroundStyle(active ? Theme.onSelect : Theme.text2)
            .frame(width: 40, height: 36)
            .background(active ? Theme.select : Color.clear,
                        in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
    }
}
