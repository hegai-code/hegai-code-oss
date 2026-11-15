import SwiftUI
import CCRemoteKit

// Память — корпус заметок этого человека по всему флоту (веб `Memory.tsx`).
// Намеренно только чтение и удаление: заметки пишут агенты в сессиях, и ручная
// правка здесь воевала бы с их циклом сверки.
//
// Таб Настроек, а не отдельный экран: заголовок несёт `SettingsTabsView`.
// Второй формы («Mac рядом двумя колонками») больше нет — нативного Mac-таргета
// нет с 21.09.2026, а `selectedId` остался: по нему подсвечивается открытая
// заметка, когда со стека возвращаются назад.

/// Список → вытолкнутая деталь. Удаление возвращает назад и перечитывает.
struct MemoryView: View {
    @State private var selectedEntry: MemoryEntry?
    @State private var reloadTick = 0

    var body: some View {
        MemoryListView(selectedId: selectedEntry?.id, reloadTick: reloadTick) { selectedEntry = $0 }
            .navigationDestination(item: $selectedEntry) { entry in
                MemoryDetailView(entry: entry) {
                    selectedEntry = nil
                    reloadTick += 1
                }
                .navigationTitle("Заметка")
                .inlineTitle()
                .pushedScreen()
            }
    }
}

/// The grouped note list. Owns the fetch; `reloadTick` lets the shell force a
/// refetch (after a delete) without reaching into this view's state.
struct MemoryListView: View {
    var selectedId: String?
    var reloadTick: Int
    var onSelect: (MemoryEntry) -> Void
    @Environment(CentralClient.self) private var client

    @State private var entries: [MemoryEntry] = []
    @State private var loading = false
    @State private var loadError: String?
    @State private var filter = ""

    /// MEMORY.md is loaded into context on EVERY session — its growth is the
    /// thing worth flagging (web parity: "heavy" at 8 KB).
    private let heavyIndexBytes = 8 * 1024

    private struct MemoryGroup: Identifiable {
        let id: String
        let title: String
        let entries: [MemoryEntry]
    }

    private var visibleEntries: [MemoryEntry] {
        let alive = entries.filter { !$0.deleted }
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return alive }
        return alive.filter {
            $0.path.lowercased().contains(q) || scopeTitle($0).lowercased().contains(q)
        }
    }

    private var groups: [MemoryGroup] {
        var byKey: [String: [MemoryEntry]] = [:]
        for e in visibleEntries { byKey["\(e.scope.rawValue):\(e.scopeKey)", default: []].append(e) }
        return byKey
            .map { key, list in
                MemoryGroup(id: key,
                            title: scopeTitle(list[0]),
                            entries: list.sorted { $0.path < $1.path })
            }
            // Fleet first, then machines, then projects — mirrors the web order.
            .sorted { l, r in
                let rank = { (g: MemoryGroup) -> Int in
                    if g.id.hasPrefix("fleet") { return 0 }
                    if g.id.hasPrefix("machine") { return 1 }
                    return 2
                }
                return rank(l) == rank(r) ? l.title < r.title : rank(l) < rank(r)
            }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Theme.s2) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13))  // бокс глифа
                    .foregroundStyle(Theme.drawerSecondary)
                TextField("Фильтр по заметкам…", text: $filter)
                    .textFieldStyle(.plain).font(SettingsStyle.body)
                    .plainTextEntry()
                Button {
                    Task { await load() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 15, weight: .medium))  // бокс глифа
                        .foregroundStyle(Theme.textMuted)
                        .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Перечитать список")
            }
            .padding(.leading, Theme.s3)
            .settingsCard()
            .padding(Theme.s4)
            if loading && entries.isEmpty {
                Spacer()
                ProgressView().controlSize(.small)
                Spacer()
            } else if let loadError, entries.isEmpty {
                Spacer()
                Text(loadError).font(SettingsStyle.body).foregroundStyle(Theme.drawerSecondary)
                    .multilineTextAlignment(.center).padding(Theme.s4)
                Spacer()
            } else if visibleEntries.isEmpty {
                Spacer()
                Text(filter.isEmpty ? "Память пуста — заметки появляются из сессий."
                                    : "Ничего не нашлось")
                    .font(SettingsStyle.body).foregroundStyle(Theme.drawerSecondary)
                    .multilineTextAlignment(.center).padding(Theme.s4)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.s5) {
                        ForEach(groups) { group in
                            VStack(alignment: .leading, spacing: Theme.s2) {
                                SettingsSectionHeader(text: group.title, count: group.entries.count)
                                VStack(spacing: 0) {
                                    ForEach(group.entries) { entry in
                                        entryRow(entry)
                                        if entry.id != group.entries.last?.id {
                                            Divider().padding(.leading, Theme.s4)
                                        }
                                    }
                                }
                                .settingsCard()
                            }
                        }
                    }
                    .padding(.horizontal, Theme.s4).padding(.bottom, Theme.s4)
                    .frame(maxWidth: Theme.readingWidth)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .background(Theme.settingsBackground)
        // Keyed on the connection too: pushed at launch (CC_PUSH, cold deep
        // link) this view mounts BEFORE the socket opens, and a fetch fired
        // then dies with "connection closed" and would otherwise just sit there.
        .task(id: "\(reloadTick):\(client.status == .open)") { await load() }
    }

    private func entryRow(_ entry: MemoryEntry) -> some View {
        let selectedNow = entry.id == selectedId
        let heavyIndex = entry.path == "MEMORY.md" && entry.bytes >= heavyIndexBytes
        return Button { onSelect(entry) } label: {
            HStack(spacing: Theme.s2) {
                Text(entry.path)
                    .font(selectedNow ? SettingsStyle.emphasis : SettingsStyle.body)
                    .foregroundStyle(Theme.text)
                    .lineLimit(1).truncationMode(.middle)
                Spacer()
                Text(memorySizeLabel(entry.bytes))
                    .font(SettingsStyle.caption)
                    .foregroundStyle(heavyIndex ? Theme.onAttn : Theme.drawerSecondary)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(heavyIndex ? Theme.attn : Color.clear,
                                in: RoundedRectangle(cornerRadius: Theme.statusDotRadius,
                                                     style: .continuous))
            }
            .padding(.horizontal, Theme.s3)
            .frame(minHeight: SettingsStyle.rowHeight)
            // Открытая заметка — навигационное «ты здесь», а не выбор из
            // палитры: была сплошная плашка `select`, и она заставляла
            // перекрашивать и путь, и вес, чтобы те читались поверх неё.
            .hereTint(selectedNow, radius: Theme.radiusSm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, Theme.s2)
        .accessibilityHint(heavyIndex
                           ? "Индекс MEMORY.md загружается в контекст каждой сессии — он потяжелел"
                           : "")
    }

    private func load() async {
        loading = true
        loadError = nil
        do {
            entries = try await client.memoryList()
        } catch {
            loadError = "Не удалось получить список: \(error.localizedDescription)"
        }
        loading = false
    }

    private func scopeTitle(_ entry: MemoryEntry) -> String {
        switch entry.scope {
        case .fleet: return "Весь флот"
        case .machine:
            return client.machines.first { $0.machine.machineId == entry.scopeKey }?.machine.name
                ?? String(entry.scopeKey.prefix(8))
        case .project:
            return (entry.scopeKey as NSString).lastPathComponent
        }
    }
}

/// One note: header with revision/size/age and a fleet-wide delete, then the
/// Markdown body. Loads itself, so it works pushed on a phone or docked in the
/// Mac split.
struct MemoryDetailView: View {
    let entry: MemoryEntry
    var onDeleted: () -> Void
    @Environment(CentralClient.self) private var client

    @State private var noteBody: String?
    @State private var bodyError: String?
    @State private var confirmDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: Theme.s2) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.path)
                        .font(.mono(Theme.sizeCard, weight: .semibold)).foregroundStyle(Theme.text)
                        .lineLimit(2).truncationMode(.middle)
                    Text("rev \(entry.revision) · \(memorySizeLabel(entry.bytes)) · \(RelTime.short(entry.updatedAt))")
                        .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                }
                Spacer()
                Button { confirmDelete = true } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 15))  // бокс глифа
                        .foregroundStyle(Theme.negative)
                        .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Удалить по всему флоту")
            }
            .padding(.horizontal, Theme.s4)
            .padding(.vertical, Theme.s2)
            Divider().overlay(Theme.divider)
            Group {
                if let bodyError {
                    Text(bodyError).font(SettingsStyle.body)
                        .foregroundStyle(Theme.drawerSecondary).padding(Theme.s4)
                } else if let noteBody {
                    ScrollView {
                        MarkdownText(text: noteBody)
                            .textSelection(.enabled)
                            .padding(Theme.s4)
                            .frame(maxWidth: 720, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    ProgressView().controlSize(.small)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .background(Theme.settingsBackground)
        .confirmationDialog("Удалить «\(entry.path)»?", isPresented: $confirmDelete) {
            Button("Удалить по всему флоту", role: .destructive) {
                Task { await delete() }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Заметка помечается удалённой на хабе, и ни одна машина не вернёт её обратно.")
        }
        .task(id: entry.id) { await loadBody() }
    }

    private func loadBody() async {
        noteBody = nil
        bodyError = nil
        do {
            noteBody = try await client.memoryRead(scope: entry.scope,
                                                   scopeKey: entry.scopeKey,
                                                   path: entry.path)
        } catch {
            bodyError = "Не удалось прочитать: \(error.localizedDescription)"
        }
    }

    private func delete() async {
        do {
            try await client.memoryDelete(scope: entry.scope, scopeKey: entry.scopeKey, path: entry.path)
            onDeleted()
        } catch {
            bodyError = "Не удалось удалить: \(error.localizedDescription)"
        }
    }
}

private func memorySizeLabel(_ bytes: Int) -> String {
    if bytes < 1024 { return "\(bytes) Б" }
    return String(format: "%.1f КБ", Double(bytes) / 1024)
}
