import SwiftUI
import CCRemoteKit

/// Inbox — attention events as chat rows, not a stock `List`: hashed avatar,
/// what happened, and an ember unread dot while it is still unread.
struct NotificationCenterView: View {
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router

    var body: some View {
        Group {
            if client.notifs.items.isEmpty {
                empty
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(client.notifs.items) { item in
                            Button {
                                router.openSession(machineId: item.machineId, sessionId: item.sessionId)
                                Haptics.light()
                            } label: {
                                NotifRow(item: item)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, Theme.s2)
                    .padding(.vertical, Theme.s3)
                }
            }
        }
        .background(Theme.bg)
        .navigationTitle("Входящие")
        .inlineTitle()
        .toolbar {
            if !client.notifs.items.isEmpty {
                ToolbarItem(placement: .trailingActions) {
                    Button("Очистить") { client.notifs.clear() }
                        .font(.ui(Theme.sizeSmall, weight: .medium))
                        .foregroundStyle(Theme.link)
                }
            }
        }
        .onAppear { client.notifs.markRead() }
    }

    private var empty: some View {
        VStack(spacing: Theme.s3) {
            Image(systemName: "bell.slash")
                .font(.system(size: 28)).foregroundStyle(Theme.textFaint)  // бокс глифа
            Text("Пока тихо").font(.ui(Theme.sizeCard, weight: .semibold)).foregroundStyle(Theme.text)
            Text("Сюда попадут раны, которым нужно ваше решение.")
                .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Theme.s6)
    }
}

private struct NotifRow: View {
    let item: NotifItem
    var body: some View {
        HStack(spacing: Theme.s3) {
            LeadStatusDot(live: item.state == .working, working: item.state == .working)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.ui(Theme.sizeSmall, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text("\(item.machineName.map { $0 + " · " } ?? "")\(NotificationEngine.verb(item.state, pendingKind: item.pendingKind))")
                    .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textMuted).lineLimit(2)
            }
            Spacer(minLength: Theme.s2)
            VStack(alignment: .trailing, spacing: 4) {
                Text(item.ts, style: .relative).font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                if item.state == .needs_attention {
                    // Квадрат 8×8 и `attn`: круглая точка была вторым кругом в
                    // продукте, а `primary` — имя роли, которой в системе из
                    // четырёх цветов больше нет.
                    StatusSquare(color: Theme.attn)
                }
            }
        }
        .padding(.horizontal, Theme.s3)
        .padding(.vertical, Theme.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
