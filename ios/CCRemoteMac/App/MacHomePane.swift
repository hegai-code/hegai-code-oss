import SwiftUI
import CCRemoteKit

/// Главная — what the logo opens (web parity: home is the door the wordmark
/// opens, not a rail slot).
///
/// The same rebuild as the phone: what wants you first, with the last thing
/// said in each session under it, then the overview. The four counters went —
/// the list above states everything they counted, and states it in a form you
/// can act on — and the limits moved into the header, where a figure you only
/// glance at belongs.
struct MacHomePane: View {
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router

    @State private var lastMessages = LastMessageStore()

    private static let shown = 12

    private var activeAll: [ActiveWorkItem] {
        ActiveWork.items(machines: client.machines, runs: client.activeRuns)
    }

    private var teamToday: [TeamToday.PersonDay] { TeamToday.people(from: client.machines) }

    var body: some View {
        let active = activeAll
        let visible = Array(active.prefix(Self.shown))
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s5) {
                header
                if visible.isEmpty {
                    ActiveWorkEmpty()
                } else {
                    ActiveWorkSection(items: visible,
                                      total: active.count,
                                      store: lastMessages,
                                      onShowAll: { router.destination = .sessions })
                }
                if teamToday.count > 1 {
                    TeamTodaySection(people: teamToday)
                }
            }
            .padding(Theme.s6)
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg)
        .task(id: visible.map(\.id).joined(separator: ",") + "|"
                + visible.map { String($0.session.lastModified) }.joined(separator: ",")) {
            await lastMessages.refresh(visible, client: client)
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Главная").font(.ui(22, weight: .bold)).foregroundStyle(Theme.text)
                Text(statusLine).font(.mono(11)).foregroundStyle(Theme.text3)
            }
            Spacer()
            UsageHeaderMeter(machines: client.machines,
                             gateway: client.gatewayUsage,
                             connection: connColor)
                .padding(.trailing, Theme.s3)
            if client.machines.contains(where: \.canDrive) {
                Button { router.startNewSession() } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus").font(.system(size: 11, weight: .bold))
                        Text("Новая сессия").font(.ui(13, weight: .semibold))
                    }
                    .foregroundStyle(Theme.onAction)
                    .padding(.horizontal, Theme.s3)
                    .frame(height: 32)
                    .background(Theme.action, in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                }
                .buttonStyle(.plain)
                .keyboardShortcut("n", modifiers: .command)
            }
        }
        .padding(.top, Theme.s4)
    }

    private var connColor: Color {
        switch client.status {
        case .open: return Theme.green
        case .connecting: return Theme.orange
        case .closed: return Theme.text3
        }
    }

    private var statusLine: String {
        switch client.status {
        case .open: return "\(client.machines.count) машин · \(client.activeRuns.count) активных прогонов"
        case .connecting: return "подключение к хабу…"
        case .closed: return "нет связи с хабом"
        }
    }

}
