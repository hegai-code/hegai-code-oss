import SwiftUI
import CCRemoteKit

/// Что показано на самом верху: онбординг или шелл.
///
/// Здесь был `TabView` с четырьмя вкладками, бейджем на «Главной» и шторкой,
/// положенной поверх всего этого. Вкладок нет — есть `AppShell` (одна страница и
/// одна шторка), и в этом файле остались ровно две вещи, которые к шелу не
/// относятся: развилка «настроено / не настроено» и листы, которые всплывают
/// поверх чего угодно.
struct RootView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router

    @State private var didDeepLink = false
    @State private var didLaunchScreen = false

    var body: some View {
        @Bindable var client = client
        ZStack(alignment: .bottom) {
            if settings.isConfigured {
                AppShell().id(client.accountGeneration)
            } else {
                NavigationStack {
                    SettingsView(onboarding: true)
                }
            }

        }
        // Ошибка хаба — под шапкой, а не над клавиатурой: снизу её поднимало
        // на клавиатуру и она закрывала поле ввода. Статус связи живёт в самой
        // шапке (`ConnectionIndicator`).
        .overlay(alignment: .top) {
            HubStatusOverlay()
                .padding(.top, 52)
                .ignoresSafeArea(.keyboard)
        }
        // «Вы вошли через Telegram как @x» — over onboarding and the shell
        // alike, the first thing after a Telegram sign-in (TelegramSignIn.swift).
        .overlay(alignment: .top) {
            TelegramSignedInBanner()
                .padding(.top, Theme.s2)
        }
        // Здесь было два `fullScreenCover` с формой новой сессии — под «Новый
        // чат» и под передачу из «Поделиться». Формы нет: корень приложения и
        // есть композер, и передача садится прямо в него (`Router.presentShare`).
        // Test affordance: CC_OPEN="machineId::sessionId" deep-links once the
        // inventory arrives, so the Simulator can screenshot a session directly.
        // `task(id:)` and not `onChange`: on a warm start the snapshot can land
        // BEFORE this view mounts, and a change-only observer then never fires.
        //
        // НЕ ТРОГАТЬ без нужды: этот механизм ловит гонку холодного старта, и
        // ровно он отличает снимок сессии от снимка спиннера.
        .task(id: client.machines.count) {
            guard !didDeepLink, client.machines.count > 0,
                  let target = ProcessInfo.processInfo.environment["CC_OPEN"] else { return }
            let parts = target.components(separatedBy: "::")
            guard parts.count == 2 else { return }
            didDeepLink = true
            router.openSession(machineId: parts[0], sessionId: parts[1])
            // Шторку можно попросить ПОВЕРХ открытой сессии — это отдельный
            // кадр приёмки, и открыть её надо после того, как сессия легла на
            // стек, иначе `openSession` её же и закроет.
            if LaunchAffordances.current.drawerOpen { router.openDrawer() }
        }
        .onChange(of: client.accountGeneration) { _, _ in
            router.pendingShare = nil
            router.newChatTarget = nil
            router.path = []
            router.closeDrawer()
        }
        .sheet(isPresented: $client.aiConsentRequested) { AIDataConsentView() }
        // «Ввести код пары» для зашифрованной машины: из карточки машины и из
        // закрытой сессии (docs/E2EE.md).
        .sheet(item: $client.pairRequest) { PairKeySheet(request: $0) }
        // Отчёт с платформы — в приложении, а не в Safari (`ReportViewer`).
        // Один перехват на всё: транскрипт, Markdown, `Link`, листы поверх них
        // — каждый `openURL` ниже идёт через него. Не отчёт — система.
        .environment(\.openURL, OpenURLAction { url in
            // Действие зовётся с главного потока (тап), но его тип этого не
            // говорит — без `assumeIsolated` не читаются настройки и UIKit.
            MainActor.assumeIsolated { () -> OpenURLAction.Result in
                guard let link = ReportLink(url, hubURL: settings.hubURL) else { return .systemAction }
                ReportPresenter.present(link, hubURL: settings.hubURL, token: settings.token)
                return .handled
            }
        })
        .task { await AccountDeletionRecovery.resume(client: client, settings: settings) }
        .onAppear(perform: applyLaunchScreen)
        #if DEBUG
        // Аффорданс приёмки: CC_REPORT=<ссылка /w/reports/<id>> открывает отчёт
        // так же, как тап по ссылке, — чтобы симулятор снял `ReportViewer`
        // без тапов. Пауза — чтобы шелл успел стать корневым контроллером.
        .task {
            guard let raw = ProcessInfo.processInfo.environment["CC_REPORT"],
                  let url = URL(string: raw),
                  let link = ReportLink(url, hubURL: settings.hubURL) else { return }
            try? await Task.sleep(for: .seconds(1.5))
            ReportPresenter.present(link, hubURL: settings.hubURL, token: settings.token)
        }
        #endif
    }

    /// `CC_SCREEN` (и переведённые с него `CC_TAB` / `CC_PUSH`) — один раз, на
    /// первом кадре. Экран не зависит от инвентаря, поэтому ждать сокет незачем.
    private func applyLaunchScreen() {
        guard !didLaunchScreen, settings.isConfigured else { return }
        didLaunchScreen = true
        switch LaunchAffordances.current.screen {
        case .start:
            break
        case let .team(tab):
            router.teamTab = tab
            router.pushAtLaunch(.team)
        case .notifications:
            router.pushAtLaunch(.notifications)
        case let .settings(tab):
            router.settingsTab = tab
            router.pushAtLaunch(.settings)
        case .gallery, .transcript:
            // Витрина и стенд транскрипта перехвачены выше, в `CCRemoteApp`, —
            // сюда не доходят.
            break
        case .swipeProbe:
            #if DEBUG
            router.pushAtLaunch(.swipeProbe)
            #endif
        }
    }
}
