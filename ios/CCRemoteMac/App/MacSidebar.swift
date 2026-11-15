import SwiftUI
import CCRemoteKit

/// The sessions column. Reuses `SessionRow` verbatim — it already takes a
/// `selected` flag and drives `router.openSession` itself, which is exactly the
/// shape a split view wants.
struct MacSidebar: View {
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @State private var query = ""

    private var buckets: [ProjectBucket] {
        let all = ProjectGrouping.buckets(from: client.machines)
        guard !query.isEmpty else { return all }
        let needle = query.lowercased()
        return all.compactMap { bucket in
            let hits = bucket.items.filter {
                $0.session.title.lowercased().contains(needle)
                    || (($0.session.project ?? "").lowercased().contains(needle))
                    || $0.machineName.lowercased().contains(needle)
            }
            return hits.isEmpty ? nil : ProjectBucket(name: bucket.name, items: hits)
        }
    }

    /// Every live run across the fleet, including other people's — the same
    /// "Сейчас в работе" pin the web shows, and the reason to keep the app open.
    private var liveItems: [SessionItem] {
        let live = Set(client.activeRuns.map {
            MacSessionKey(machineId: $0.machineId, sessionId: $0.sessionId).id
        })
        return ProjectGrouping.allItems(from: client.machines)
            .filter {
                live.contains(MacSessionKey(machineId: $0.machineId,
                                            sessionId: $0.session.sessionId).id)
            }
    }

    var body: some View {
        List {
            if !liveItems.isEmpty && query.isEmpty {
                Section {
                    ForEach(liveItems) { row(for: $0, showProject: true) }
                } header: {
                    SectionLabel(text: "Сейчас в работе")
                }
            }
            ForEach(buckets) { bucket in
                Section {
                    ForEach(bucket.items) { row(for: $0) }
                } header: {
                    // The header is the door to the project view (web parity:
                    // clicking a project drills into its cross-machine list).
                    Button { router.openProject(bucket.name) } label: {
                        HStack(spacing: Theme.s1) {
                            SectionLabel(text: bucket.name)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 8, weight: .semibold))
                                .foregroundStyle(Theme.text3)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .searchable(text: $query, placement: .sidebar, prompt: "Поиск по сессиям")
        // Anything that leaves the list blank deserves an explanation, and
        // "no machines" was the only one being caught. A fleet whose machines
        // hold no sessions yet — or a search that matches nothing — rendered an
        // empty column with no text at all.
        .overlay { if buckets.isEmpty && liveItems.isEmpty { emptyState } }
    }

    private func row(for item: SessionItem, showProject: Bool = false) -> some View {
        SessionRow(
            item: item,
            showServer: true,
            showProject: showProject,
            selected: router.selectedSession == SessionRoute(machineId: item.machineId,
                                                            sessionId: item.session.sessionId)
        )
        .listRowInsets(EdgeInsets(top: 2, leading: 4, bottom: 2, trailing: 4))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// Three states, not two.
    ///
    /// "Запустите Claude Code на любой машине" is sound advice only if the
    /// person HAS a machine. To someone who just installed the app and connected
    /// nothing, it names a step they cannot take and hides the one they can —
    /// which is exactly how a new employee reads the app as broken. Connected
    /// with no machines is its own state and gets its own instruction.
    private var emptyState: some View {
        VStack(spacing: Theme.s2) {
            Text(headline)
                .font(.ui(13, weight: .medium))
                .foregroundStyle(Theme.text2)
            Text(detail)
                .font(.ui(12))
                .foregroundStyle(Theme.text3)
                .multilineTextAlignment(.center)
        }
        .padding(Theme.s4)
    }

    private var headline: String {
        guard client.status == .open else { return "Подключение…" }
        if client.machines.isEmpty { return "Ни одного компьютера" }
        return query.isEmpty ? "Сессий пока нет" : "Ничего не нашлось"
    }

    private var detail: String {
        guard client.status == .open else {
            return "Хаб: \(client.status == .connecting ? "соединяемся" : "нет связи")"
        }
        if client.machines.isEmpty {
            return "Подключите рабочий компьютер: «Настройки → Подключить машину» на code.acme.test, дальше по инструкции"
        }
        return query.isEmpty
            ? "Запустите Claude Code или Codex на любой машине"
            : "Ни одна сессия не подходит под «\(query)»"
    }
}
