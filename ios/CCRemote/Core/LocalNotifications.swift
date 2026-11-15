import Foundation
import UserNotifications
import CCRemoteKit

/// Notification identifiers shared with the hub's APNs payload (`set_category`).
enum NotifIDs {
    static let toolApprovalCategory = HegaiNotif.toolApproval
    static let allowAction = HegaiNotif.allow
    static let denyAction = HegaiNotif.deny
}

/// Bridges UNUserNotificationCenter: requests authorization, suppresses banners
/// while the app is foregrounded (the in-app Inbox shows them), routes a tap back
/// to a session deep-link, and — for APNs pushes carrying a pending approval —
/// registers Allow/Deny actions so the user can decide from the lock screen.
@MainActor
final class LocalNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = LocalNotifications()

    /// Set by the app; invoked with (machineId, sessionId) when a notification is tapped.
    var onTap: ((String, String) -> Void)?
    /// Set by the app; invoked with (runId, requestId, allow) when an Allow/Deny
    /// action button is used on a tool-approval push.
    var onApprove: ((String, String, Bool) -> Void)?
    /// Set by the app; invoked with (runId, text) for a text reply on a push that
    /// carries no action token (the one-shot-socket fallback of WATCH.md §6).
    var onReply: ((String, String) -> Void)?
    /// Set by the app; invoked with (runId, requestId, text) for ASK/PLAN text on a
    /// push without an action token: a `tool_decision {allow:false, message}`.
    var onDenyWithMessage: ((String, String, String) -> Void)?
    private(set) var appActive = true

    /// Idempotent: the app delegate calls it at launch (so a background launch for
    /// a notification action finds the delegate and the categories in place) and
    /// the scene calls it again.
    func configure() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // Categories of WATCH.md §6; the watch registers the same set. Allow and
        // PLAN_ACCEPT require the device be unlocked; none opens the app.
        center.setNotificationCategories(HegaiNotificationCategories.make())
    }

    /// What a text reply on a push WITHOUT `act` becomes (WATCH.md §6): ASK/PLAN text
    /// answers the pending request (`tool_decision` allow:false + message), only
    /// DONE/ERROR text is a plain `input`. Anything else, or empty text, is dropped.
    nonisolated enum FallbackReply: Equatable {
        case input(runId: String, text: String)
        case toolDecision(runId: String, requestId: String, message: String)
    }

    nonisolated static func fallbackReply(category: String, userInfo: [AnyHashable: Any], text: String?) -> FallbackReply? {
        let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let runId = userInfo["runId"] as? String, !runId.isEmpty else { return nil }
        switch category {
        case HegaiNotif.ask, HegaiNotif.plan:
            guard let requestId = userInfo["requestId"] as? String, !requestId.isEmpty else { return nil }
            return .toolDecision(runId: runId, requestId: requestId, message: trimmed)
        case HegaiNotif.done, HegaiNotif.error:
            return .input(runId: runId, text: trimmed)
        default:
            return nil
        }
    }

    /// Hub and token for a background launch, where no `AppSettings` exists yet:
    /// the same two stores it reads (UserDefaults + Keychain).
    static func storedHub() -> String {
        UserDefaults.standard.string(forKey: "hubURL") ?? AppSettings.defaultHubURL
    }

    func setAppActive(_ active: Bool) { appActive = active }

    func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            #if os(iOS)
            // Register for remote (APNs) push once the user allows notifications.
            // The Mac raises its banners locally instead: the wire's push platform
            // enum only knows `ios`, and widening it is a protocol change.
            Task { @MainActor in PushRegistration.shared.register() }
            #endif
        }
    }

    func post(id: String, title: String, body: String, machineId: String, sessionId: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = sessionId
        content.userInfo = ["machineId": machineId, "sessionId": sessionId]
        let req = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    /// A banner carrying Allow/Deny for a pending tool decision.
    ///
    /// On iOS this shape arrives from the hub as an APNs push. A Mac app is
    /// already running and already holds the socket when the request lands, so it
    /// raises the same banner locally and answers over the live connection —
    /// which is why the Mac needs no push capability to answer without being
    /// brought to the front.
    func postApproval(id: String, title: String, body: String,
                      runId: String, requestId: String,
                      machineId: String, sessionId: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = sessionId
        content.categoryIdentifier = NotifIDs.toolApprovalCategory
        content.userInfo = ["machineId": machineId, "sessionId": sessionId,
                            "runId": runId, "requestId": requestId]
        let req = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    // Foregrounded: don't interrupt with a banner (the in-app Inbox covers it).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        []
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let info = content.userInfo
        let category = content.categoryIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        // A private machine's push never answers from the banner: the answer would have to
        // leave unsealed. Open the app instead (docs/E2EE.md).
        if response.actionIdentifier != UNNotificationDefaultActionIdentifier,
           response.actionIdentifier != UNNotificationDismissActionIdentifier,
           !E2eeKeyRing.shared.pushActionAllowed(userInfo: info) {
            postOpenApp(info: info)
            return
        }
        // A push with an action token answers over HTTPS from any surface.
        if let body = PushActionMapper.tokenBody(category: category, actionId: response.actionIdentifier,
                                                 userInfo: info, text: text) {
            await submitAction(body, info: info)
            return
        }
        switch response.actionIdentifier {
        case HegaiNotif.reply:
            // No token: the text goes in as an `input` over the one-shot socket.
            // An empty reply or a missing run id is dropped, not turned into a tap.
            switch Self.fallbackReply(category: category, userInfo: info, text: text) {
            case .input(let runId, let t):
                if let onReply { onReply(runId, t) } else { postOpenApp(info: info) }
            case .toolDecision(let runId, let requestId, let t):
                if let onDenyWithMessage { onDenyWithMessage(runId, requestId, t) } else { postOpenApp(info: info) }
            case nil: break
            }
        case HegaiNotif.planAccept:
            // Accepting needs the pending plan input, which only the token path has.
            if let m = info["machineId"] as? String, let s = info["sessionId"] as? String { onTap?(m, s) }
        case NotifIDs.allowAction, NotifIDs.denyAction:
            // One-tap approve/deny from a push. runId + requestId come from the
            // hub's APNs custom data; route_to_agent looks the run up by runId.
            if let runId = info["runId"] as? String, let reqId = info["requestId"] as? String {
                if let onApprove { onApprove(runId, reqId, response.actionIdentifier == NotifIDs.allowAction) }
                else { postOpenApp(info: info) }
            }
        default:
            // Body tap → deep-link into the session.
            if let m = info["machineId"] as? String, let s = info["sessionId"] as? String {
                onTap?(m, s)
            }
        }
    }

    /// `POST /api/push-action` under a background assertion; a failure becomes a
    /// local notification, because the user already walked away from the banner.
    private func submitAction(_ body: PushActionBody, info: [AnyHashable: Any]) async {
        let grace = UIKitBackgroundGrace()
        let held = grace.begin("push-action")
        defer { if let held { grace.end(held) } }
        guard let base = HegaiAuth.apiBase(hubURL: Self.storedHub()) else {
            postFailure("нет адреса хаба", info: info); return
        }
        let result = await PushActionClient(base: base).send(body)
        if let reason = result.message { postFailure(reason, info: info) }
    }

    /// A cold background launch for an action without `act`: the handlers above
    /// are installed by the scene, which has not run. Say so instead of
    /// dropping the answer silently.
    private func postOpenApp(info: [AnyHashable: Any]) {
        post(id: "push-action-open-\(UUID().uuidString)", title: "Hegai Code",
             body: "Откройте Hegai Code, чтобы ответить",
             machineId: info["machineId"] as? String ?? "", sessionId: info["sessionId"] as? String ?? "")
    }

    private func postFailure(_ reason: String, info: [AnyHashable: Any]) {
        post(id: "push-action-failed-\(UUID().uuidString)", title: "Hegai Code",
             body: "Не отправилось: \(reason)",
             machineId: info["machineId"] as? String ?? "", sessionId: info["sessionId"] as? String ?? "")
    }
}
