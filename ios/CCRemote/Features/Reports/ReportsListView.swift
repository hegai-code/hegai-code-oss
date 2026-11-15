import SwiftUI
import CCRemoteKit

// Отчёты — список опубликованных отчётов этого человека (раздел «Отчёты» веба).
// Только чтение: публикует их сессия командой `hegai-fleet report publish`.
// Тап открывает тот же `ReportViewer`, что и ссылка из транскрипта.

/// Один отчёт из `GET /api/reports`. Поля, которых у старого хаба нет, —
/// опциональные: `folder` появился позже остальных.
struct ReportItem: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let description: String?
    let sizeBytes: Double?
    let createdAt: Double?
    let updatedAt: Double?
    let ownerName: String?
    let ownerEmail: String?
    let folder: String?
    let url: String?

    var folderName: String { folder ?? "" }
    var changedAt: Double { updatedAt ?? createdAt ?? 0 }
}

struct ReportsResponse: Decodable {
    let reports: [ReportItem]
    let admin: Bool?
}

struct ReportFolderGroup: Identifiable, Equatable {
    let folder: String
    let reports: [ReportItem]
    var id: String { folder }
    var title: String { folder.isEmpty ? ReportsListView.rootFolderTitle : folder }
}

struct ReportsListView: View {
    static let rootFolderTitle = "Hegai Code"

    @Environment(AppSettings.self) private var settings

    @State private var reports: [ReportItem] = []
    @State private var loading = false
    @State private var loaded = false
    @State private var loadError: String?

    /// «Hegai Code» ('' ) первой, дальше папки по самому свежему отчёту; внутри
    /// папки новые сверху. Чистая функция — под тест.
    static func group(_ items: [ReportItem]) -> [ReportFolderGroup] {
        var byFolder: [String: [ReportItem]] = [:]
        for item in items { byFolder[item.folderName, default: []].append(item) }
        let groups = byFolder.map { folder, list in
            ReportFolderGroup(folder: folder, reports: list.sorted { $0.changedAt > $1.changedAt })
        }
        return groups.sorted { l, r in
            if l.folder.isEmpty != r.folder.isEmpty { return l.folder.isEmpty }
            let ln = l.reports.first?.changedAt ?? 0
            let rn = r.reports.first?.changedAt ?? 0
            return ln == rn ? l.folder < r.folder : ln > rn
        }
    }

    /// Ссылка отчёта: поле `url`, а без него — адрес на нашем хабе.
    static func link(for item: ReportItem, hubURL: String) -> ReportLink? {
        if let raw = item.url, let url = URL(string: raw),
           let link = ReportLink(url, hubURL: hubURL) {
            return link
        }
        guard let base = HegaiAuth.apiBase(hubURL: hubURL),
              let url = URL(string: base.absoluteString + "/w/reports/" + item.id) else { return nil }
        return ReportLink(url, hubURL: hubURL)
    }

    private var groups: [ReportFolderGroup] { Self.group(reports) }

    var body: some View {
        Group {
            if loading && !loaded {
                VStack { Spacer(); ProgressView().controlSize(.small); Spacer() }
                    .frame(maxWidth: .infinity)
            } else if let loadError, reports.isEmpty {
                message(loadError)
            } else if reports.isEmpty {
                message("Отчётов пока нет — их публикует сессия командой hegai-fleet report publish")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.s5) {
                        ForEach(groups) { group in
                            VStack(alignment: .leading, spacing: Theme.s2) {
                                SettingsSectionHeader(text: group.title, count: group.reports.count)
                                VStack(spacing: 0) {
                                    ForEach(group.reports) { item in
                                        row(item)
                                        if item.id != group.reports.last?.id {
                                            Divider().padding(.leading, Theme.s4)
                                        }
                                    }
                                }
                                .settingsCard()
                            }
                        }
                    }
                    .padding(Theme.s4)
                    .frame(maxWidth: Theme.readingWidth)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .background(Theme.settingsBackground)
        .refreshable { await load() }
        .task { await load() }
        .accessibilityIdentifier("settings.reports.list")
    }

    private func message(_ text: String) -> some View {
        ScrollView {
            Text(text).font(SettingsStyle.body).foregroundStyle(Theme.drawerSecondary)
                .multilineTextAlignment(.center).padding(Theme.s4)
                .frame(maxWidth: .infinity)
                .padding(.top, Theme.s5)
        }
    }

    private func row(_ item: ReportItem) -> some View {
        Button { open(item) } label: {
            HStack(spacing: Theme.s2) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title.isEmpty ? "Без названия" : item.title)
                        .font(SettingsStyle.body).foregroundStyle(Theme.text)
                        .lineLimit(2).multilineTextAlignment(.leading)
                    if let description = item.description, !description.isEmpty {
                        Text(description)
                            .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                            .lineLimit(2).multilineTextAlignment(.leading)
                    }
                    if item.changedAt > 0 {
                        Text("обновлён \(Self.relative(item.changedAt))")
                            .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                SettingsChevron()
            }
            .padding(.horizontal, Theme.s4).padding(.vertical, Theme.s3)
            .frame(minHeight: SettingsStyle.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private static func relative(_ msEpoch: Double) -> String {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "ru_RU")
        f.unitsStyle = .short
        return f.localizedString(for: Date(timeIntervalSince1970: msEpoch / 1000), relativeTo: Date())
    }

    private func open(_ item: ReportItem) {
        guard let link = Self.link(for: item, hubURL: settings.hubURL) else { return }
        ReportPresenter.present(link, hubURL: settings.hubURL, token: settings.token)
    }

    private func load() async {
        loading = true
        loadError = nil
        let rest = RestClient()
        rest.configure(hubURL: settings.hubURL, token: settings.token)
        do {
            reports = try await rest.get("api/reports", as: ReportsResponse.self).reports
        } catch {
            if !(error is CancellationError) {
                loadError = "Не удалось получить список: \(error.localizedDescription)"
            }
        }
        loading = false
        loaded = true
    }
}
