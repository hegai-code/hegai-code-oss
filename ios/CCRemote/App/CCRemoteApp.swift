import SwiftUI
import UIKit
import CCRemoteKit

@main
struct CCRemoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var settings = AppSettings()
    @State private var client: CentralClient = {
        let client = CentralClient(grace: UIKitBackgroundGrace())
        client.requiresAIConsent = true
        return client
    }()
    @State private var router = Router()
    @State private var auth = HegaiAuth()
    @State private var hubIndicator = ConnectionIndicator()
    @State private var pathWatcher = NetworkPathWatcher()
    @Environment(\.scenePhase) private var scenePhase
    /// True once the app has been fully backgrounded (not just briefly inactive),
    /// so the return to `.active` knows to hard-reconnect a likely-dead socket.
    @State private var wasBackgrounded = false

    var body: some Scene {
        WindowGroup {
            // CC_GALLERY=1 открывает витрину дизайн-системы вместо приложения
            // (DEBUG-only, см. GalleryView). Она ничего не знает про хаб, поэтому
            // стоит ДО RootView и роняет свой маяк готовности сама: иначе харнес
            // ждал бы сокет, которого на этом экране нет, и помечал готовый кадр
            // как несостоявшийся.
            // CC_SCREEN / CC_DRAWER / CC_LENS и переводы со старых CC_TAB и
            // CC_PUSH разбираются один раз и проговариваются в лог: скрипт,
            // который зовёт старым именем, должен об этом УЗНАТЬ, а не получить
            // правильный по имени файл с неправильным кадром внутри.
            Group {
                #if DEBUG
                if GalleryView.isRequested {
                    GalleryView()
                } else if TranscriptFixtureView.isRequested {
                    // Стенд транскрипта — по той же причине и на том же месте,
                    // что и витрина: хаба он не знает, маяк роняет сам.
                    TranscriptFixtureView()
                } else {
                    RootView().harnessReadySignal(client, settings)
                }
                #else
                RootView()
                #endif
            }
                .environment(settings)
                .environment(client)
                .environment(router)
                .environment(auth)
                .environment(hubIndicator)
                .onChange(of: client.status == .open || !settings.isConfigured, initial: true) { _, open in
                    hubIndicator.update(open: open)
                }
                // Системные контролы берут ту же роль, что и кнопки продукта
                // — `action`, то есть чернила (в тёмной ivory), как в вебе.
                // Ember здесь стоять НЕ должен: тинт красит тумблеры, пикеры,
                // курсор и окантовки контролов, а ember — цвет внимания, а не
                // цвет «тут можно нажать». Ровно это владелец и увидел на
                // живой сборке как «оранжевый в окантовках, действиях».
                .tint(Theme.action)
                .preferredColorScheme(settings.colorScheme)
                .onAppear {
                    onLaunch()
                    pathWatcher.start { satisfied in client.networkPathChanged(satisfied: satisfied) }
                }
                .onChange(of: client.viewer) { _, _ in selectPreferredWorkspace() }
                .onChange(of: client.outbox.isEmpty && client.pending.isEmpty && !client.busy && client.turnProgress == nil) { _, ready in
                    if ready { selectPreferredWorkspace() }
                }
                .onChange(of: scenePhase) { _, phase in
                    LocalNotifications.shared.setAppActive(phase == .active)
                    switch phase {
                    case .active:
                        if #available(iOS 17.2, *) { LiveActivityRegistrar.shared.reportIfNoCards() }
                        hubIndicator.appBecameActive()
                        client.appDidBecomeActive(fromBackground: wasBackgrounded)
                        wasBackgrounded = false
                    case .background:
                        wasBackgrounded = true
                        client.appWillBackground()
                    default:
                        break
                    }
                }
                .onChange(of: settings.notificationsEnabled) { _, on in
                    client.notifs.enabled = on
                    if on { LocalNotifications.shared.requestAuthorization() }
                }
                .onOpenURL { url in handleDeepLink(url) }
                .onChange(of: settings.token, initial: true) { _, _ in syncWatchAndActivities() }
                .onChange(of: settings.hubURL) { _, _ in syncWatchAndActivities() }
        }
    }

    /// Watch hand-off (WatchConnectivity) and Live Activity token reporting follow
    /// the signed-in session; both go quiet on sign-out.
    private func syncWatchAndActivities() {
        let base = HegaiAuth.apiBase(hubURL: settings.hubURL)?.absoluteString
        WatchLink.shared.sync(hubBase: base, token: settings.token)
        if #available(iOS 17.2, *) {
            LiveActivityRegistrar.shared.update(hubURL: settings.hubURL, token: settings.token)
        }
    }

    private func selectPreferredWorkspace() {
        guard let viewer = client.viewer else { return }
        let hasPendingWork = client.hasPendingWork
        let preferred = viewer.preferredWorkspace(
            rememberedId: settings.workspaceId,
            hasQueuedMessages: hasPendingWork)
        // Keep the intended team remembered while the switch is deferred.
        guard !hasPendingWork else { return }
        settings.workspaceId = preferred.workspaceId
        if viewer.workspace.workspaceId != preferred.workspaceId {
            client.switchWorkspace(preferred.workspaceId)
        }
    }

    /// A `ccremote://share` link means the Share extension put the shared content
    /// on the pasteboard. Pull it, downscale any images, and open a prefilled New
    /// Session. Gate tightly on host == "share": the clipboard is read ONLY on this
    /// exact hand-off, so no other ccremote:// open (or a stray link) can slurp
    /// whatever the user happens to have copied.
    private func handleDeepLink(_ url: URL) {
        // `ccremote://connect?hub=…` — «подключиться к своему серверу». Только
        // предложение: подтверждение показывает корень (`HubConnectPrompt`),
        // вошёл человек или нет. Тот же хаб, что сейчас, — тихо ничего.
        // (`ccremote://auth` — колбэк входа, его ловит сама сессия входа.)
        if url.scheme == "ccremote", url.host == "connect" {
            // A proposal already on screen is not replaced: the alert keeps the
            // host it showed, and «Подключиться» must switch to THAT one.
            if let hub = HubLink.parse(url.absoluteString), !HegaiAuth.sameHub(settings.hubURL, hub),
               router.pendingHubLink == nil {
                router.pendingHubLink = hub
            }
            return
        }
        guard url.scheme == "ccremote", url.host == "share", settings.isConfigured else { return }
        let pb = UIPasteboard.general
        var images: [ImageAttachment] = []
        if pb.hasImages {
            for img in (pb.images ?? []).prefix(4) {
                if let att = ImageAttachment.make(from: img) { images.append(att) }
            }
        }
        let task = pb.hasStrings ? (pb.string ?? "") : ""
        guard !task.isEmpty || !images.isEmpty else { return }
        router.presentShare(ComposerSeed(text: task, images: images))
    }

    private func onLaunch() {
        // До первой панели: снимает стеклянную КАПСУЛУ с кнопки «назад» (iOS 26
        // кладёт в неё каждый элемент панели) и ставит на полосу свои токены.
        NavigationChrome.apply()
        #if DEBUG
        BundledFonts.audit()
        LaunchAffordances.current.announce()
        #endif
        LocalNotifications.shared.configure()
        LocalNotifications.shared.onTap = { machineId, sessionId in
            router.openSession(machineId: machineId, sessionId: sessionId)
        }
        LocalNotifications.shared.onApprove = { runId, requestId, allow in
            client.decidePush(runId: runId, requestId: requestId, allow: allow,
                              endpoint: settings.hubURL, token: settings.token)
        }
        LocalNotifications.shared.onDenyWithMessage = { runId, requestId, text in
            client.decidePush(runId: runId, requestId: requestId, allow: false, message: text,
                              endpoint: settings.hubURL, token: settings.token)
        }
        LocalNotifications.shared.onReply = { runId, text in
            client.replyPush(runId: runId, text: text, endpoint: settings.hubURL, token: settings.token)
        }
        // APNs device token → hub (once the capability + provisioning are in place).
        PushRegistration.shared.onToken = { token in client.registerPush(deviceToken: token) }
        // The socket reports that a decision is wanted; the phone is what buzzes.
        client.onToolRequest = { Haptics.warning() }
        client.notifs.appIsActive = { LocalNotifications.shared.appActive }
        client.notifs.postBanner = { banner in
            LocalNotifications.shared.post(
                id: banner.id, title: banner.title, body: banner.body,
                machineId: banner.machineId, sessionId: banner.sessionId
            )
        }
        client.notifs.enabled = settings.notificationsEnabled
        // A harness stand asks nothing: the system alert covered its frames.
        if settings.notificationsEnabled && LaunchAffordances.current.notificationPrompt {
            LocalNotifications.shared.requestAuthorization()
        }
        guard settings.isConfigured else { return }
        client.connect(endpoint: settings.hubURL, token: settings.token,
                       workspaceId: settings.workspaceId.isEmpty ? nil : settings.workspaceId)
    }
}
