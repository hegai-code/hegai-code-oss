import SwiftUI
import CCRemoteKit

/// Табы Настроек.
///
/// Железо, Память и Профиль были тремя строками во вкладке «Ещё» — то есть тремя
/// отдельными местами, между которыми надо возвращаться. В вебе они табы одного
/// экрана Настроек, и `/w/hardware`, `/w/memory`, `/w/profile` открывают
/// нужный таб, поправляя адрес. Здесь то же: `router.openSettings(.hardware)`
/// открывает экран на табе, а `CC_SCREEN=settings:hardware` — при запуске.
enum SettingsTab: String, CaseIterable, Identifiable {
    case account, hardware, memory, profile, reports
    var id: String { rawValue }
    var label: String {
        switch self {
        case .account: return "Аккаунт"
        case .hardware: return "Серверы и устройства"
        case .memory: return "Память"
        case .profile: return "Моя активность"
        case .reports: return "Отчёты"
        }
    }
}

/// Табы Команды. Живут рядом с табами Настроек и по той же причине: экран
/// пересоздаётся при каждом пуше, и `@State` внутри него не может знать, что
/// харнес просил «Аудит». Пятого таба веба («Доступ», только админу платформы)
/// здесь нет — его эндпоинтов нет в CCRemoteKit.
enum TeamTab: String, CaseIterable, Identifiable {
    case overview, people, projects, audit
    var id: String { rawValue }
    var label: String {
        switch self {
        case .overview: return "Обзор"
        case .people: return "Люди"
        case .projects: return "Проекты"
        case .audit: return "Аудит"
        }
    }
}

/// A short native root. Legacy deep links still open their matching destination.
struct SettingsTabsView: View {
    @Environment(Router.self) private var router
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings

    var body: some View {
        Group {
            switch router.settingsTab {
            case .account: root
            case .hardware: HardwareView().navigationTitle("Серверы и устройства")
            case .memory: MemoryView().navigationTitle("Память")
            case .profile: ProfileView().navigationTitle("Моя активность")
            case .reports: ReportsListView().navigationTitle("Отчёты")
            }
        }
        .background(Theme.settingsBackground.ignoresSafeArea())
        .toolbarBackground(Theme.settingsBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .tint(Theme.text)
        .inlineTitle()
    }

    private var root: some View {
        ScrollView {
            VStack(spacing: Theme.s5) {
                VStack(spacing: 0) {
                    NavigationLink { SettingsView(page: .account) } label: {
                        HStack(spacing: Theme.s3) {
                            if let viewer = client.viewer {
                                Avatar(seed: viewer.userId, label: viewer.displayName, size: Theme.avatarCard)
                            }
                            VStack(alignment: .leading, spacing: Theme.s1) {
                                Text(client.viewer?.displayName ?? "Аккаунт").font(SettingsStyle.heading)
                                Text(client.viewer?.workspace.name ?? "Управление аккаунтом")
                                    .font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            SettingsChevron()
                        }.foregroundStyle(Theme.text).padding(Theme.s4)
                    }.buttonStyle(.plain).accessibilityIdentifier("settings.account")
                    Divider().padding(.leading, Theme.s4)
                    UsageLimitsView(compact: true).padding(.horizontal, Theme.s4)
                }.settingsCard()
                group("Приложение") {
                    page(.appearance, icon: "circle.lefthalf.filled")
                    Divider().padding(.leading, Theme.s4)
                    page(.notifications, icon: "bell")
                    Divider().padding(.leading, Theme.s4)
                    page(.defaults, icon: "slider.horizontal.3")
                }
                group("Работа с AI") {
                    NavigationLink { MemoryView().navigationTitle("Память").inlineTitle() } label: {
                        SettingsNavigationRow("Память", icon: "text.book.closed")
                    }.accessibilityIdentifier("settings.memory")
                    Divider().padding(.leading, Theme.s4)
                    NavigationLink { HardwareView().navigationTitle("Серверы и устройства").inlineTitle() } label: {
                        SettingsNavigationRow("Серверы и устройства", icon: "desktopcomputer")
                    }.accessibilityIdentifier("settings.hardware")
                    Divider().padding(.leading, Theme.s4)
                    NavigationLink { ReportsListView().navigationTitle("Отчёты").inlineTitle() } label: {
                        SettingsNavigationRow("Отчёты", icon: "doc.richtext")
                    }.accessibilityIdentifier("settings.reports")
                }
                group("Данные и помощь") {
                    page(.privacy, icon: "hand.raised")
                    Divider().padding(.leading, Theme.s4)
                    Link(destination: HegaiAuth.hubPageURL(hubURL: settings.hubURL, path: "/api/support")) {
                        SettingsNavigationRow("Поддержка", icon: "questionmark.circle", external: true)
                    }.accessibilityIdentifier("settings.support")
                    Divider().padding(.leading, Theme.s4)
                    page(.about, icon: "info.circle")
                    Divider().padding(.leading, Theme.s4)
                    page(.advanced, icon: "wrench.and.screwdriver")
                }
            }
            .padding(Theme.s4).frame(maxWidth: Theme.readingWidth).frame(maxWidth: .infinity)
        }
        .navigationTitle("Настройки")
        .accessibilityIdentifier("settings.root")
    }

    private func page(_ page: SettingsPage, icon: String) -> some View {
        NavigationLink { SettingsView(page: page) } label: {
            SettingsNavigationRow(page.title, icon: icon)
        }.accessibilityIdentifier("settings.\(page.rawValue)")
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            SettingsSectionHeader(text: title).padding(.leading, Theme.s2)
            VStack(spacing: 0, content: content).buttonStyle(.plain).settingsCard()
        }
    }
}
