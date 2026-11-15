import AuthenticationServices
import SwiftUI
import CCRemoteKit

/// Apple's native sheet; the hub verifies both signed identity and one-use code.
///
/// With `linkSession` set it LINKS instead of signing in: the exchange carries
/// that session as a bearer, the hub attaches the Apple ID to the signed-in
/// account and answers no new session (`onLinked`).
struct AppleSignInView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(\.colorScheme) private var colorScheme
    let onSignIn: (String) -> Void
    var linkSession: String? = nil
    var onLinked: (() -> Void)? = nil
    @State private var nonce: String?
    @State private var endpoint = ""
    @State private var error: String?
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            SignInWithAppleButton(linkSession == nil ? .signIn : .continue) { request in
                request.requestedScopes = [.fullName]
                request.nonce = nonce
                request.state = nonce
                working = true
            } onCompletion: { result in
                Task { await complete(result) }
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: Theme.tapTarget)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            .disabled(nonce == nil || working)
            .accessibilityIdentifier("auth.apple")
            if let error {
                Text(error).font(SettingsStyle.caption).foregroundStyle(Theme.negative)
                Button("Повторить подключение к Apple") { Task { await prepare() } }
                    .font(SettingsStyle.caption).disabled(working)
            }
        }
        .task(id: settings.hubURL) { await prepare() }
    }

    private func prepare() async {
        nonce = nil
        error = nil
        endpoint = settings.hubURL
        let currentEndpoint = endpoint
        let rest = RestClient(); rest.configure(hubURL: currentEndpoint, token: "")
        struct Challenge: Decodable { let nonce: String }
        do {
            let challenge = try await rest.post("api/auth/apple/start", body: [String: String](), as: Challenge.self)
            guard endpoint == currentEndpoint, !Task.isCancelled else { return }
            nonce = challenge.nonce
        } catch {
            guard endpoint == currentEndpoint, !Task.isCancelled else { return }
            self.error = "Вход Apple пока недоступен. Повторите попытку позже."
        }
    }

    private func complete(_ result: Result<ASAuthorization, Error>) async {
        defer { working = false }
        do {
            let authorization = try result.get()
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let nonce, credential.state == nonce,
                  endpoint == settings.hubURL,
                  let identity = credential.identityToken.flatMap({ String(data: $0, encoding: .utf8) }),
                  let code = credential.authorizationCode.flatMap({ String(data: $0, encoding: .utf8) }) else {
                throw ClientError.rpc("Не удалось проверить ответ Apple. Повторите вход.")
            }
            let currentEndpoint = endpoint
            let rest = RestClient(); rest.configure(hubURL: currentEndpoint, token: linkSession ?? "")
            var body = ["nonce": nonce, "code": code, "identityToken": identity]
            if let name = credential.fullName {
                body["name"] = PersonNameComponentsFormatter().string(from: name)
            }
            if linkSession != nil {
                struct Linked: Decodable { let linked: String }
                _ = try await rest.post("api/auth/apple/exchange", body: body, as: Linked.self)
                guard settings.hubURL == currentEndpoint else { return }
                await prepare()
                onLinked?()
                return
            }
            struct Reply: Decodable { let session: String }
            let reply = try await rest.post("api/auth/apple/exchange", body: body, as: Reply.self)
            guard settings.hubURL == currentEndpoint else { return }
            onSignIn(reply.session)
        } catch let failure as ASAuthorizationError where failure.code == .canceled {
            await prepare()
        } catch ClientError.rpc(let code) where linkSession != nil {
            await prepare()
            self.error = IdentityWords.error(code)
        } catch ClientError.rpc(let code) where code == "mfa_browser_required" {
            // A second factor is owed and Sign in with Apple has no browser step.
            await prepare()
            self.error = IdentityWords.error(code)
        } catch {
            await prepare()
            self.error = linkSession == nil
                ? "Не удалось войти через Apple. Повторите вход."
                : "Не удалось привязать Apple. Попробуйте ещё раз."
        }
    }
}
