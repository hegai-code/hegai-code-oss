import SwiftUI
import CCRemoteKit

/// ⌘K — the fuzzy jump palette (web `CommandPalette.tsx`): a few actions, the
/// active runs, then every session on every machine. Type to filter, arrows to
/// move, Return to go.
struct MacCommandPalette: View {
    private static let maximumVisibleRows = 14
    private static let maximumSessionsPerMachine = 60

    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router

    @State private var query = ""
    @State private var selection = 0
    @FocusState private var focused: Bool

    private struct Row: Identifiable {
        let id: String
        let icon: String
        let title: String
        let meta: String?
        let trailing: String?
        let accent: Color?
        let perform: () -> Void
    }

    private var actionRows: [Row] {
        var rows: [Row] = [
            Row(id: "act-board", icon: "rectangle.split.3x1", title: "Открыть доску",
                meta: "действие", trailing: nil, accent: nil) {
                router.destination = .board
            },
            Row(id: "act-new", icon: "plus", title: "Новая сессия",
                meta: "действие · ⌘N", trailing: nil, accent: nil) {
                router.startNewSession()
            },
        ]
        rows.append(Row(id: "act-rescan", icon: "arrow.clockwise", title: "Обновить список машин",
                        meta: "действие · ⌘R", trailing: nil, accent: nil) { [machines = client.machines] in
            for m in machines { client.rescan(machineId: m.machine.machineId) }
        })
        return rows
    }

    private var runRows: [Row] {
        client.activeRuns.map { run in
            return Row(id: "run-\(run.runId)", icon: "circle.square",
                       title: run.macDisplayTitle,
                       meta: [run.machineName, run.state.label].compactMap { $0 }.joined(separator: " · "),
                       trailing: RelTime.short(run.since),
                       accent: run.state.pillColor) {
                router.openSession(machineId: run.machineId, sessionId: run.sessionId)
            }
        }
    }

    private var sessionRows: [Row] {
        // Per-machine cap (web parity: 60) keeps a fleet with giant transcripts
        // from turning the palette into a 4000-row list.
        let liveKeys = Set(client.activeRuns.map {
            MacSessionKey(machineId: $0.machineId, sessionId: $0.sessionId).id
        })
        var rows: [Row] = []
        for snap in client.machines {
            let sorted = snap.sessions.sorted { $0.lastModified > $1.lastModified }
                .prefix(Self.maximumSessionsPerMachine)
            for s in sorted where !liveKeys.contains(
                MacSessionKey(machineId: snap.machine.machineId, sessionId: s.sessionId).id
            ) {
                rows.append(Row(id: "s-\(snap.machine.machineId)-\(s.sessionId)", icon: "bubble.left",
                                title: s.title.isEmpty ? String(s.sessionId.prefix(8)) : s.title,
                                meta: [snap.machine.name, s.project].compactMap { $0 }.joined(separator: " · "),
                                trailing: RelTime.short(s.lastModified),
                                accent: nil) {
                    router.openSession(machineId: snap.machine.machineId, sessionId: s.sessionId)
                })
            }
        }
        return rows
    }

    private var visibleRows: [Row] {
        let all = actionRows + runRows + sessionRows
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return Array(all.prefix(Self.maximumVisibleRows)) }
        return all
            .compactMap { row -> (Row, Int)? in
                let haystack = "\(row.title) \(row.meta ?? "")"
                guard let score = Self.fuzzyScore(q, in: haystack) else { return nil }
                return (row, score)
            }
            .sorted { $0.1 > $1.1 }
            .prefix(Self.maximumVisibleRows)
            .map(\.0)
    }

    var body: some View {
        ZStack(alignment: .top) {
            // Scrim: click anywhere outside closes.
            Theme.macPaletteScrim
                .ignoresSafeArea()
                .onTapGesture { close() }

            VStack(spacing: 0) {
                HStack(spacing: Theme.s2) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13)).foregroundStyle(Theme.text3)
                    TextField("Сессия, проект или машина…", text: $query)
                        .textFieldStyle(.plain).font(.ui(15))
                        .foregroundStyle(Theme.text)
                        .focused($focused)
                        .onSubmit { performSelected() }
                    Text("esc").font(.mono(10)).foregroundStyle(Theme.text3)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Theme.surface3,
                                    in: RoundedRectangle(cornerRadius: Theme.macKeycapRadius,
                                                         style: .continuous))
                }
                .padding(Theme.s3)
                Divider().overlay(Theme.border)
                let rows = visibleRows
                if rows.isEmpty {
                    Text("Ничего не нашлось")
                        .font(.ui(13)).foregroundStyle(Theme.text3)
                        .padding(Theme.s5)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { idx, row in
                                rowView(row, selected: idx == selection)
                                    .onTapGesture { row.perform(); close() }
                            }
                        }
                        .padding(Theme.s1)
                    }
                    .frame(maxHeight: 380)
                }
            }
            .frame(width: 560)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous)
                .stroke(Theme.border, lineWidth: 1))
            .shadow(color: Theme.macPaletteShadow,
                    radius: Theme.macPaletteShadowRadius, y: Theme.s3)
            .padding(.top, 90)
        }
        .onAppear { query = ""; selection = 0; focused = true }
        .onChange(of: query) { _, _ in selection = 0 }
        .onKeyPress(.downArrow) {
            selection = min(selection + 1, max(0, visibleRows.count - 1)); return .handled
        }
        .onKeyPress(.upArrow) {
            selection = max(0, selection - 1); return .handled
        }
        .onExitCommand { close() }
    }

    private func rowView(_ row: Row, selected: Bool) -> some View {
        HStack(spacing: Theme.s2) {
            if let accent = row.accent {
                MacStatusMark(color: accent)
            } else {
                Image(systemName: row.icon)
                    .font(.system(size: 12)).foregroundStyle(selected ? Theme.onSelect : Theme.text3)
                    .frame(width: Theme.statusDot + 4)
            }
            Text(row.title)
                .font(.ui(13, weight: .medium))
                .foregroundStyle(selected ? Theme.onSelect : Theme.text)
                .lineLimit(1)
            if let meta = row.meta {
                Text(meta).font(.mono(10))
                    .foregroundStyle(selected ? Theme.onSelect.opacity(0.75) : Theme.text3)
                    .lineLimit(1)
            }
            Spacer()
            if let trailing = row.trailing {
                Text(trailing).font(.mono(10))
                    .foregroundStyle(selected ? Theme.onSelect.opacity(0.75) : Theme.text3)
            }
        }
        .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
        .background(selected ? Theme.select : Color.clear,
                    in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
        .contentShape(Rectangle())
    }

    private func performSelected() {
        let rows = visibleRows
        guard rows.indices.contains(selection) else { return }
        rows[selection].perform()
        close()
    }

    private func close() {
        router.paletteOpen = false
    }

    /// Subsequence match with bonuses for prefix and word-boundary hits; nil =
    /// no match. Small and dependency-free — cmdk's scorer without cmdk.
    static func fuzzyScore(_ query: String, in haystack: String) -> Int? {
        let q = Array(query.lowercased())
        let h = Array(haystack.lowercased())
        guard !q.isEmpty else { return 0 }
        var score = 0
        var hi = 0
        var lastHit = -2
        for ch in q {
            var found = false
            while hi < h.count {
                if h[hi] == ch {
                    score += (hi == 0 || h[hi - 1] == " " || h[hi - 1] == "/") ? 4
                        : (hi == lastHit + 1 ? 3 : 1)
                    lastHit = hi
                    hi += 1
                    found = true
                    break
                }
                hi += 1
            }
            if !found { return nil }
        }
        return score
    }
}
