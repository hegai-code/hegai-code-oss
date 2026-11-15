import SwiftUI

struct InboxView: View {
    @ObservedObject var store: WatchStore
    @Environment(\.scenePhase) private var scenePhase
    /// Sessions opened on top of the list; a tapped notification pushes one.
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let message = store.state.message {
                    VStack(spacing: 8) {
                        Text(message).multilineTextAlignment(.center).foregroundStyle(WatchTheme.ivory)
                        if store.state == .offline {
                            Button("Повторить") { Task { await store.refresh() } }
                                .buttonStyle(WatchButtonStyle(prominent: true))
                        }
                    }
                    .padding(.horizontal, 6)
                } else if case .ready(let inbox) = store.state {
                    if inbox.items.isEmpty {
                        Text("Пока тихо").foregroundStyle(WatchTheme.muted)
                    } else {
                        List {
                            if inbox.waiting + inbox.working > 0 {
                                FleetCounters(waiting: inbox.waiting, working: inbox.working)
                                    .listRowBackground(Color.clear)
                            }
                            ForEach(WatchInboxSection.group(inbox.items), id: \.0) { section, rows in
                                Section(section.title) {
                                    ForEach(rows) { item in
                                        NavigationLink(value: item.sessionKey) { InboxRow(item: item) }
                                    }
                                }
                            }
                        }
                        .refreshable { await store.refresh() }
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Hegai")
            .navigationDestination(for: String.self) { key in
                // Keyed by session, not run: a reply that starts a run must not orphan the open screen.
                if case .ready(let inbox) = store.state, let item = inbox.items.first(where: { $0.sessionKey == key }) {
                    DetailView(store: store, item: item)
                } else {
                    Text("Уже не актуально").foregroundStyle(WatchTheme.muted)
                }
            }
        }
        .task { await store.refresh() }
        .onChange(of: store.openSessionKey) { _, key in openRequested(key) }
        .onAppear { openRequested(store.openSessionKey) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.refresh() } }
        }
    }
}

extension InboxView {
    private func openRequested(_ key: String?) {
        guard let key else { return }
        store.openSessionKey = nil
        path = [key]
    }
}

/// «1 ждёт · 2 работают» as two coloured tiles above the list.
struct FleetCounters: View {
    let waiting: Int
    let working: Int

    var body: some View {
        HStack(spacing: 6) {
            tile(waiting, FleetSummary.waiting(waiting).replacingOccurrences(of: " \(waiting)", with: ""),
                 WatchTheme.ember, "exclamationmark.bubble.fill")
            tile(working, FleetSummary.working(working).replacingOccurrences(of: " \(working)", with: ""),
                 WatchTheme.working, "gearshape.2.fill")
        }
        .accessibilityElement(children: .combine)
    }

    private func tile(_ n: Int, _ label: String, _ tint: Color, _ icon: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 3) {
                Image(systemName: icon).font(.caption2)
                Text("\(n)").font(.system(.title3, design: .rounded).weight(.bold)).monospacedDigit()
            }
            .foregroundStyle(n > 0 ? tint : WatchTheme.muted)
            Text(label).font(.caption2).foregroundStyle(WatchTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background((n > 0 ? tint : WatchTheme.ivory).opacity(0.16),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct InboxRow: View {
    let item: WatchInboxItem

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: glyph).font(.caption2)
                    .foregroundStyle(WatchTheme.color(forState: item.state))
                Text(item.machine).font(.caption2).foregroundStyle(WatchTheme.muted).lineLimit(1)
                Spacer(minLength: 2)
                if let t = FleetSummary.relative(ms: item.activityMs) {
                    Text(t).font(.caption2).foregroundStyle(WatchTheme.muted)
                }
            }
            Text(item.title).font(.footnote.weight(.semibold)).lineLimit(2)
            if item.isWorking, let p = item.progress, p.total > 0 {
                HStack(spacing: 4) {
                    PlanBar(fraction: p.fraction).frame(height: 3)
                    Text("\(min(p.done, p.total))/\(p.total)").font(.system(size: 10)).monospacedDigit()
                        .foregroundStyle(WatchTheme.muted)
                }
                if let active = p.active, !active.isEmpty {
                    Text(active).font(.caption2).foregroundStyle(WatchTheme.muted).lineLimit(1)
                }
            } else if item.state == "idle", !(item.replies ?? []).isEmpty {
                Label("что дальше: \(item.replies?.count ?? 0)", systemImage: "arrow.up.circle")
                    .font(.caption2).foregroundStyle(WatchTheme.ember)
            }
        }
    }

    private var glyph: String {
        switch item.state {
        case "needs_attention": return "exclamationmark.bubble.fill"
        case "working": return "circle.dotted"
        case "error": return "xmark.octagon.fill"
        default: return "checkmark.circle"
        }
    }
}
