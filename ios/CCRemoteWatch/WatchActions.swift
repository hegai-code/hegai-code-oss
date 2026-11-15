import Foundation
import UserNotifications
import WatchKit
import WidgetKit

/// Token-mode actions fired from a notification (the action buttons or the
/// buttons inside the long-look interface). The hub base comes from the
/// credentials the iPhone handed over; the token itself needs no session.
enum WatchActions {
    static func submit(_ body: PushActionBody) async -> PushActionResult {
        guard let base = WatchKeychain.load()?.baseURL else {
            return .failed(status: nil, error: nil)
        }
        let result = await PushActionClient(base: base).send(body)
        await MainActor.run {
            WKInterfaceDevice.current().play(result == .ok ? .success : .failure)
        }
        WidgetCenter.shared.reloadAllTimelines()
        return result
    }

    /// An action chosen on a notification: on failure the user already walked
    /// away from the banner, so say it with a local notification.
    static func handle(category: String, actionId: String, userInfo: [AnyHashable: Any], text: String?) async {
        let outcome = PushActionMapper.watchRoute(category: category, actionId: actionId,
                                                  userInfo: userInfo, text: text,
                                                  hasSession: WatchKeychain.load() != nil)
        switch outcome {
        case .ignore:
            return
        case .token(let body):
            let result = await submit(body)
            if let reason = result.message { await postFailure(reason) }
        case .session(let body):
            guard let creds = WatchKeychain.load(), let base = creds.baseURL else {
                await postFailure("ответьте с iPhone"); return
            }
            let result = await PushActionClient(base: base).send(body, bearer: creds.token)
            await MainActor.run { WKInterfaceDevice.current().play(result == .ok ? .success : .failure) }
            WidgetCenter.shared.reloadAllTimelines()
            if let reason = result.message { await postFailure(reason) }
        case .useIPhone:
            await postFailure("ответьте с iPhone")
        }
    }

    static func postFailure(_ reason: String) async {
        let content = UNMutableNotificationContent()
        content.title = "Hegai Code"
        content.body = reason == "ответьте с iPhone" ? "Ответьте с iPhone" : "Не отправилось: \(reason)"
        content.sound = .default
        let request = UNNotificationRequest(identifier: "push-action-failed-\(UUID().uuidString)",
                                            content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
