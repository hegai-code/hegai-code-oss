import SwiftUI
import CCRemoteKit

/// Hegai Code for macOS.
///
/// The five root objects are created and injected exactly as on iOS — that is the
/// whole point of the CCRemoteKit split, and it means the Mac inherits the
/// reconnect state machine, the RPC registry and the offline outbox on day one.
/// What differs is everything above them: scenes instead of a `TabView`, a real
/// main menu, and a split view instead of two navigation stacks.
@main
struct CCRemoteMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var appDelegate
    @State private var settings = AppSettings()
    // No `BackgroundGrace` here: AppKit does not suspend the app mid-send, so the
    // no-op default is the correct implementation, not a stub.
    @State private var client = CentralClient()
    @State private var router = Router()
    @State private var auth = HegaiAuth()

    var body: some Scene {
        Window("Hegai Code", id: "main") {
            MacRootView()
                .environment(settings)
                .environment(client)
                .environment(router)
                .environment(auth)
                .tint(Theme.primary)
                .preferredColorScheme(settings.colorScheme)
                .frame(minWidth: 900, minHeight: 560)
                .onAppear { onLaunch() }
                .onChange(of: waitingCount) { syncDockBadge() }
        }
        .defaultSize(width: 1180, height: 760)
        .commands { MacCommands(client: client, router: router) }

        MenuBarExtra {
            MacMenuBarPanel()
                .environment(settings)
                .environment(client)
                .environment(router)
                .tint(Theme.primary)
                .preferredColorScheme(settings.colorScheme)
        } label: {
            MacMenuBarLabel(waiting: waitingCount, working: workingCount)
        }
        .menuBarExtraStyle(.window)

        Settings {
            // The phone's Settings screen, verbatim: account and SSO, workspace
            // switcher, hub override, appearance, run defaults, notifications,
            // enrollment codes, devices, the offline-cache readout. Writing a Mac
            // subset would have meant two places to add the next setting to.
            NavigationStack { SettingsView() }
                .environment(settings)
                .environment(client)
                .environment(auth)
                .environment(router)
                .tint(Theme.action)
                .preferredColorScheme(settings.colorScheme)
                .frame(width: 560, height: 640)
        }
    }

    private var waitingCount: Int {
        client.activeRuns.filter { $0.state == .needs_attention }.count
    }
    private var workingCount: Int {
        client.activeRuns.filter { $0.state == .working }.count
    }

    private func onLaunch() {
        LocalNotifications.shared.configure()
        LocalNotifications.shared.onTap = { machineId, sessionId in
            router.openSession(machineId: machineId, sessionId: sessionId)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        // Answering from the banner needs no push round trip here: the app is
        // running and already holds the socket, so the decision goes straight out
        // over the live connection.
        LocalNotifications.shared.onApprove = { _, _, allow in
            client.decideTool(allow: allow)
        }
        client.notifs.appIsActive = { NSApplication.shared.isActive }
        client.notifs.postBanner = { banner in
            LocalNotifications.shared.post(
                id: banner.id, title: banner.title, body: banner.body,
                machineId: banner.machineId, sessionId: banner.sessionId
            )
        }
        // A pending decision is the one event worth interrupting for, and it is
        // exactly the moment the window is usually behind something else.
        client.onToolRequest = {
            guard !NSApplication.shared.isActive, let req = client.toolReq else { return }
            LocalNotifications.shared.postApproval(
                id: "tool-\(req.requestId)",
                title: "Hegai Code — нужно решение",
                body: req.title ?? req.tool,
                runId: req.runId, requestId: req.requestId,
                machineId: client.active?.machineId ?? "",
                sessionId: client.active?.sessionId ?? ""
            )
        }
        client.notifs.enabled = settings.notificationsEnabled
        if settings.notificationsEnabled { LocalNotifications.shared.requestAuthorization() }

        guard settings.isConfigured else { return }
        client.connect(endpoint: settings.hubURL, token: settings.token,
                       workspaceId: settings.workspaceId.isEmpty ? nil : settings.workspaceId)
    }

    /// The dock badge carries the same number as the menu bar, so a glance at
    /// either answers "does anything want me".
    private func syncDockBadge() {
        NSApp.dockTile.badgeLabel = waitingCount > 0 ? "\(waitingCount)" : nil
    }
}

/// Present so the app has a delegate to hang notification handling off in the
/// next step; `NSApplication` also wants one to own activation policy.
final class MacAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
