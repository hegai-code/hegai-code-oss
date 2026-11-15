import UIKit
import Observation

/// Holds the APNs device token and bridges it to the CentralClient. The token
/// is re-sent to the hub on every (re)connect because APNs tokens rotate and the
/// hub keeps the device map in memory.
@MainActor
final class PushRegistration {
    static let shared = PushRegistration()
    private(set) var deviceToken: String?
    /// Set by the app; called whenever a device token arrives.
    var onToken: ((String) -> Void)?

    func register() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    func setToken(_ hex: String) {
        deviceToken = hex
        onToken?(hex)
    }
}

/// Minimal UIApplicationDelegate just to receive the APNs device token (SwiftUI
/// has no direct hook for `didRegisterForRemoteNotifications`).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // The notification delegate must exist before the first scene: a push
        // action can launch the app in the background with no UI at all.
        MainActor.assumeIsolated {
            LocalNotifications.shared.configure()
            // A push-to-start launches the app the same way, and its update token
            // is reported only to observers already running (WATCH.md §5).
            if #available(iOS 17.2, *) {
                let settings = AppSettings()
                LiveActivityRegistrar.shared.update(hubURL: settings.hubURL, token: settings.token)
            }
        }
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        MainActor.assumeIsolated { PushRegistration.shared.setToken(hex) }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No push available (Simulator, or provisioning without the capability) —
        // local notifications still work while connected.
    }
}
