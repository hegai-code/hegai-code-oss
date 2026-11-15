import Foundation
import SwiftUI
import WatchConnectivity
import WatchKit
import WidgetKit

/// What the inbox screen shows.
enum InboxState: Equatable {
    case loading
    case signedOut
    case forbidden
    case offline
    case ready(WatchInbox)

    /// Russian copy for the non-ready states.
    var message: String? {
        switch self {
        case .signedOut: return "Открой Hegai Code на iPhone"
        case .forbidden: return "Пока только для владельца"
        case .offline: return "Нет связи с хабом"
        default: return nil
        }
    }
}

/// Session + inbox. The WatchConnectivity receiver lives here because the
/// credentials are what every screen needs first.
@MainActor
final class WatchStore: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchStore()

    @Published private(set) var state: InboxState = .loading
    @Published private(set) var credentials: WatchCredentials?
    @Published var lastActionError: String?
    /// `machineId/sessionId` to open on top of the inbox — set when a
    /// notification is tapped, cleared by the inbox once it navigated.
    @Published var openSessionKey: String?
    private var refreshGeneration = 0

    override init() {
        credentials = WatchKeychain.load()
        super.init()
    }

    #if DEBUG
    func debugSet(_ s: InboxState) { state = s }
    #endif

    func start() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
        // The context may have arrived while the app was not running.
        if !s.receivedApplicationContext.isEmpty { adopt(s.receivedApplicationContext) }
    }

    private func adopt(_ context: [String: Any]) {
        credentials = WatchKeychain.apply(context: context)
        Task { await refresh() }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {
        let ctx = session.receivedApplicationContext
        guard !ctx.isEmpty else { return }
        Task { @MainActor in self.adopt(ctx) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.adopt(applicationContext) }
    }

    func refresh() async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-watchFixture") }) { return }
        #endif
        // Every refresh, signed in or not, retires the ones in flight: an
        // answer to a request made before sign-out must not bring the list back.
        refreshGeneration += 1
        let mine = refreshGeneration
        guard let creds = credentials ?? WatchKeychain.load() else {
            state = .signedOut
            WidgetCenter.shared.reloadAllTimelines()
            return
        }
        credentials = creds
        // Refreshes overlap (the session screen polls, an action refreshes):
        // only the newest one may land, or an older idle answer could bring
        // back reply buttons a newer working one had replaced.
        do {
            let inbox = try await WatchAPI.fetchInbox(creds)
            guard mine == refreshGeneration else { return }
            state = .ready(inbox)
        } catch WatchInboxError.unsigned {
            guard mine == refreshGeneration else { return }
            state = .signedOut
            // The session was revoked or expired: ask the iPhone for a fresh one.
            if WCSession.isSupported() { WCSession.default.transferUserInfo(["needToken": true]) }
        } catch WatchInboxError.forbidden {
            guard mine == refreshGeneration else { return }
            state = .forbidden
        } catch {
            guard mine == refreshGeneration else { return }
            // Keep the last inbox on screen when a refresh merely failed.
            if case .ready = state {} else { state = .offline }
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Session-mode action (`Authorization: Bearer`). Haptic on success, then a
    /// refresh; the error text lands in `lastActionError`.
    @discardableResult
    func perform(_ body: PushActionBody) async -> Bool {
        guard let creds = credentials, let base = creds.baseURL else {
            lastActionError = "Открой Hegai Code на iPhone"
            return false
        }
        let result = await PushActionClient(base: base).send(body, bearer: creds.token)
        switch result {
        case .ok:
            lastActionError = nil
            WKInterfaceDevice.current().play(.success)
            await refresh()
            return true
        case .failed:
            lastActionError = result.message
            WKInterfaceDevice.current().play(.failure)
            await refresh()
            return false
        }
    }
}
