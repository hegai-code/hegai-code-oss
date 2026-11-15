import Foundation
import ActivityKit
import UserNotifications
import CCRemoteKit

/// Every start / activity token this device has reported, so signing out can ask
/// the hub to drop them all (WATCH.md §5 `signout`).
enum LiveActivityTokens {
    private static let key = "liveActivityTokens"
    private static let pendingKey = "liveActivityPendingSignout"
    /// The hub rejects a signout with more tokens than this.
    static let cap = 32
    static func all() -> [String] { UserDefaults.standard.stringArray(forKey: key) ?? [] }
    /// Insertion order, deduped (a re-reported token moves to the end), last `cap` kept.
    static func merged(_ existing: [String], adding token: String) -> [String] {
        var list = existing.filter { $0 != token }
        list.append(token)
        return Array(list.suffix(cap))
    }
    static func remember(_ token: String) {
        UserDefaults.standard.set(merged(all(), adding: token), forKey: key)
    }
    static func forget() { UserDefaults.standard.removeObject(forKey: key) }
    /// Tokens whose signout the hub did not confirm; retried with the next session.
    static func pending() -> [String] { UserDefaults.standard.stringArray(forKey: pendingKey) ?? [] }
    static func setPending(_ tokens: [String]) {
        if tokens.isEmpty { UserDefaults.standard.removeObject(forKey: pendingKey) }
        else { UserDefaults.standard.set(Array(tokens.suffix(cap)), forKey: pendingKey) }
    }

    /// POST the signout; true on 2xx.
    static func sendSignout(tokens: [String], base: URL, session: String, timeout: TimeInterval) async -> Bool {
        var request = URLRequest(url: base.appendingPathComponent("api/push/live-activity"))
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(LiveActivityRegistration.signout(tokens: tokens))
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
    }
}

/// Run right before the session is cleared. One fire-and-forget task, in order:
/// (a) tell the hub to drop this device's Live Activity tokens, (b) forget them
/// locally only on 2xx (otherwise they wait in `pending` for the next session),
/// (c) revoke the watch session, (d) THEN revoke the phone session itself — so
/// the signout never races its own bearer's logout. Delivered notifications
/// leave the lock screen at once. Callers must `client.disconnect()` instead of
/// `client.signOut()`; this revokes the phone session.
enum SignOutCleanup {
    /// Every path that stores a DIFFERENT session than the current one, or clears
    /// it, goes through here first (the delivered notifications of the old account
    /// carry `act` tokens that are credentials; its Live Activity and watch
    /// registrations must not be inherited). No-op when nothing changes.
    @MainActor
    static func retire(hubURL: String, token old: String, replacingWith new: String, client: CentralClient) {
        guard !old.isEmpty, old != new else { return }
        run(hubURL: hubURL, token: old)
        client.disconnect()
    }

    @MainActor
    static func run(hubURL: String, token: String) {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        // Persist the combined list BEFORE anything async or forget(): a kill
        // mid-flight must not lose tokens the hub still holds.
        var merged: [String] = []
        for t in LiveActivityTokens.pending() + LiveActivityTokens.all() where !merged.contains(t) { merged.append(t) }
        let all = Array(merged.suffix(LiveActivityTokens.cap))
        if !all.isEmpty { LiveActivityTokens.setPending(all) }
        LiveActivityTokens.forget()
        // Taken now: the sync that follows the cleared token would delete it first.
        let watch = WatchLink.takeCached()
        let base = HegaiAuth.apiBase(hubURL: hubURL)
        let grace = UIKitBackgroundGrace()
        let held = grace.begin("signout-cleanup")
        // Marked synchronously, so the next session's registrar skips them.
        if #available(iOS 17.2, *) {
            LiveActivityRegistrar.markRetired()
            Task { @MainActor in await LiveActivityRegistrar.endRetired() }
        }
        Task.detached {
            defer { if let held { grace.end(held) } }
            if !token.isEmpty, let base, !all.isEmpty {
                // Cleared only on a confirmed 2xx; otherwise stays pending.
                if await LiveActivityTokens.sendSignout(tokens: all, base: base, session: token, timeout: 4) {
                    LiveActivityTokens.setPending([])
                }
            }
            await WatchLink.revoke(record: watch)
            if !token.isEmpty { _ = await MainActor.run { CentralClient.revoke(session: token, at: hubURL) }.value }
        }
    }
}

/// Reports ActivityKit tokens to the hub (WATCH.md §5). The app never starts an
/// activity itself: the hub starts it by push-to-start and updates it by push; the
/// app only tells the hub which tokens to use, and when an activity is gone.
@available(iOS 17.2, *)
@MainActor
final class LiveActivityRegistrar {
    static let shared = LiveActivityRegistrar()

    private var tasks: [Task<Void, Never>] = []
    private var noCardsTask: Task<Void, Never>?
    private var tracked: Set<String> = []
    private var base: URL?
    private var session = ""
    /// An account the hub refuses gets 403; stay quiet until the next launch.
    private var forbidden = false
    /// Activities of the account that just left: never observed (their tokens
    /// would be registered under the next account), and ended.
    private static var retiredActivities: Set<String> = []

    fileprivate static func markRetired() {
        retiredActivities.formUnion(Activity<HegaiFleetAttributes>.activities.map(\.id))
    }

    fileprivate static func endRetired() async {
        for a in Activity<HegaiFleetAttributes>.activities where retiredActivities.contains(a.id) {
            await a.end(nil, dismissalPolicy: .immediate)
        }
    }

    /// Call on launch and whenever the hub or the session changes. An empty
    /// token (signed out) just stops the observers.
    func update(hubURL: String, token: String) {
        // Launch calls this twice (app delegate, then the first view); restarting
        // would cancel a token report in flight.
        if !token.isEmpty, !forbidden, token == session, !tasks.isEmpty,
           let current = base, current == HegaiAuth.apiBase(hubURL: hubURL) { return }
        stop()
        // A 403 belongs to the account that got it; another session starts clean.
        if token != session { forbidden = false }
        guard !forbidden, !token.isEmpty, let base = HegaiAuth.apiBase(hubURL: hubURL) else {
            self.base = nil
            return
        }
        self.base = base
        session = token
        let pending = LiveActivityTokens.pending()
        if !pending.isEmpty {
            tasks.append(Task {
                if await LiveActivityTokens.sendSignout(tokens: pending, base: base, session: token, timeout: 15) {
                    LiveActivityTokens.setPending([])
                }
            })
        }
        tasks.append(Task { [weak self] in
            for await data in Activity<HegaiFleetAttributes>.pushToStartTokenUpdates {
                await self?.post(.start(token: data))
            }
        })
        tasks.append(Task { [weak self] in
            for await activity in Activity<HegaiFleetAttributes>.activityUpdates {
                self?.observe(activity)
            }
        })
        for activity in Activity<HegaiFleetAttributes>.activities { observe(activity) }
    }

    /// Only from the foreground: on a background launch the card that just started
    /// by push may not be listed yet, and this report would invite a second one.
    func reportIfNoCards() {
        guard base != nil, !forbidden else { return }
        let live = Activity<HegaiFleetAttributes>.activities.contains {
            $0.activityState != .ended && $0.activityState != .dismissed
        }
        guard !live else { return }
        noCardsTask?.cancel()
        noCardsTask = Task { [weak self] in await self?.post(.noCards) }
    }

    func stop() {
        for t in tasks { t.cancel() }
        tasks = []
        noCardsTask?.cancel()
        noCardsTask = nil
        tracked = []
    }

    private func observe(_ activity: Activity<HegaiFleetAttributes>) {
        guard !forbidden, !Self.retiredActivities.contains(activity.id),
              tracked.insert(activity.id).inserted else { return }
        let id = activity.id
        tasks.append(Task { [weak self] in
            for await data in activity.pushTokenUpdates {
                await self?.post(.activity(id: id, token: data))
            }
        })
        tasks.append(Task { [weak self] in
            for await state in activity.activityStateUpdates {
                if state == .ended || state == .dismissed {
                    await self?.post(.ended(id: id))
                    self?.tracked.remove(id)
                    return
                }
            }
        })
    }

    private func post(_ body: LiveActivityRegistration) async {
        guard !forbidden, let base else { return }
        // A push-to-start wakes the app for seconds: the token must get out first.
        let grace = UIKitBackgroundGrace()
        let held = grace.begin("live-activity-token")
        defer { if let held { grace.end(held) } }
        if let t = body.token, body.kind != "signout" { LiveActivityTokens.remember(t) }
        var request = URLRequest(url: base.appendingPathComponent("api/push/live-activity"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let payload = try? JSONEncoder().encode(body) else { return }
        request.httpBody = payload
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return }
        if http.statusCode == 403 {
            forbidden = true
            stop()
        }
    }
}
