import SwiftUI
import CCRemoteKit

/// The ONE way the app moves to another hub: the typed address in Settings, the
/// server sheet on the login screen and a `ccremote://connect` link all end here,
/// so the old session is revoked the same way whichever door was used.
@MainActor
enum HubSwitcher {
    /// `/health` probe, then the switch. nil = done; otherwise why nothing changed
    /// (shown under the address field / in the link dialog).
    static func connect(_ plan: HubSwitchPlan, settings: AppSettings, client: CentralClient) async -> String? {
        let expectedHub = settings.hubURL
        let expectedToken = settings.token
        if plan.switching {
            // Nothing is changed unless the new server really is a Hegai Code hub.
            if let failure = await probe(plan.hub) { return failure }
            // The plan was made for the state before the probe. A sign-in or
            // another switch that landed meanwhile must not be revoked or
            // overwritten by this older one.
            guard HegaiAuth.sameHub(settings.hubURL, expectedHub), settings.token == expectedToken else {
                return "Сервер уже изменён — повторите подключение"
            }
        }
        return commit(plan, settings: settings, client: client)
    }

    /// Stores the plan. nil = stored; otherwise the reason it was not.
    static func commit(_ plan: HubSwitchPlan, settings: AppSettings, client: CentralClient) -> String? {
        if plan.switching {
            // The session belongs to the hub that issued it. Revoke it at the
            // OLD hub (the client still points there) and forget it BEFORE the
            // new address is stored, so the old bearer can never be sent to a
            // server that never issued it. A token typed for the new hub is
            // stored only after the hub.
            // The Keychain copy goes first, and verifiably: if it cannot be
            // removed, storing the new hub would pair it with the old bearer on
            // the next launch — so nothing changes, the app stays connected to
            // the old hub. (The in-memory token is still known to the client,
            // which revokes it at the old hub in signOut below.)
            let oldToken = settings.token
            guard KeychainStore.deleteToken(), KeychainStore.loadToken() == nil else {
                if !oldToken.isEmpty { KeychainStore.saveToken(oldToken, hub: settings.hubURL) }
                Haptics.rigid()
                return "Не удалось завершить текущую сессию, сервер не изменён"
            }
            SignOutCleanup.run(hubURL: settings.hubURL, token: oldToken)
            client.disconnect()
            TelegramSignInMemo.forget()
            settings.token = ""
            settings.workspaceId = ""
        }
        settings.hubURL = plan.hub
        // A hand-pasted token is another session: the Telegram banner is not
        // about it.
        if plan.token != settings.token { TelegramSignInMemo.forget() }
        // Clearing the token on the same hub is signing out: the live connection
        // must not keep the old bearer until the next launch.
        // (a different pasted token is another account: same cleanup).
        if !plan.switching {
            SignOutCleanup.retire(hubURL: settings.hubURL, token: settings.token,
                                  replacingWith: plan.token, client: client)
        }
        settings.token = plan.token
        if plan.token.isEmpty {
            settings.workspaceId = ""
            Haptics.rigid()
            return nil
        }
        client.connect(endpoint: settings.hubURL, token: settings.token,
                       workspaceId: settings.workspaceId.isEmpty ? nil : settings.workspaceId)
        Haptics.light()
        return nil
    }

    /// `nil` = the server answered `/health` with `{"ok":true}`; otherwise the reason (as on Android).
    static func probe(_ hub: String) async -> String? {
        guard let base = HegaiAuth.apiBase(hubURL: hub),
              let url = URL(string: base.absoluteString + "/health") else { return "Некорректный адрес сервера" }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.httpMethod = "GET"
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 10
        let label = HubSwitchPlan.label(hub)
        do {
            // No redirects, as on Android: the answer must come from the typed host itself.
            let (data, resp) = try await URLSession(configuration: cfg, delegate: NoRedirect(), delegateQueue: nil).data(for: req)
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
               HubSwitchPlan.isHealthy(data) { return nil }
            return "Это не сервер Hegai Code: нет ответа {\"ok\":true} на /health"
        } catch let e as URLError {
            switch e.code {
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
                 .appTransportSecurityRequiresSecureConnection:
                return "Не удалось установить защищённое соединение с \(label)"
            case .badURL, .unsupportedURL: return "Некорректный адрес сервера"
            default: return "Сервер \(label) недоступен"
            }
        } catch {
            return "Сервер \(label) недоступен"
        }
    }

    /// Refuses every redirect, so a 3xx surfaces as «не сервер Hegai Code».
    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}

/// Confirmation for a server proposed by `ccremote://connect?hub=…` (Router.pendingHubLink).
/// Lives at the root so it shows whether the person is signed in or not. A link
/// never switches silently: host in the title, «Подключиться» / «Отмена».
struct HubConnectPrompt: ViewModifier {
    @Environment(AppSettings.self) private var settings
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @State private var failure: String?

    func body(content: Content) -> some View {
        content
            .alert(title, isPresented: Binding(
                get: { router.pendingHubLink != nil },
                set: { if !$0 { router.pendingHubLink = nil } }
            )) {
                Button("Подключиться") { confirm() }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text(message)
            }
            .alert("Не удалось подключиться", isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
    }

    private var host: String { router.pendingHubLink.map(HubSwitchPlan.label) ?? "" }
    private var title: String { "Подключиться к серверу \(host)?" }
    private var message: String {
        guard !settings.token.isEmpty else { return "Войдёте на этом сервере под своей учётной записью." }
        return "Вы выйдете из аккаунта на \(HubSwitchPlan.label(settings.hubURL))."
    }

    private func confirm() {
        guard let hub = router.pendingHubLink,
              let plan = HubSwitchPlan.make(currentHub: settings.hubURL, currentToken: settings.token,
                                            draftHub: hub, draftToken: "") else { return }
        router.pendingHubLink = nil
        guard plan.switching else { return }
        Task {
            // Same path as typing the address by hand: /health probe, then the
            // transaction that revokes the old session.
            if let reason = await HubSwitcher.connect(plan, settings: settings, client: client) {
                failure = reason
            }
        }
    }
}
