import AuthenticationServices
import Foundation
import Observation
import os
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Google sign-in for the native client (HegAI SSO until 6 Oct 2026; the type
/// keeps its name, the hop is the same).
///
/// The browser flow ends in a cookie on the hub's origin, which an app cannot
/// use. `/api/auth/google/start?native=1` therefore ends in a redirect to
/// `ccremote://auth?session=…`, which `ASWebAuthenticationSession` captures and
/// hands back here. The session token that comes out is the SAME workspace
/// session the web holds — the app is a real user from that point on, with their
/// own workspaces, roles and access, instead of a shared device token.
@MainActor
@Observable
public final class HegaiAuth: NSObject {
    public private(set) var signingIn = false
    public private(set) var lastError: String?

    private var session: ASWebAuthenticationSession?
    private let log = Logger(subsystem: "net.hegai.ccremote", category: "auth")

    public static let callbackScheme = "ccremote"

    /// Runs the web sheet and resolves to a workspace session token.
    /// `hubURL` is the ws endpoint the app is configured with; the SSO routes
    /// live on the same origin over https.
    ///
    /// `hubPage` opens the hub's own sign-in page (`/native-signin`) instead of
    /// the Google hop — a customer's hub has no Google button
    /// (`HubPublicConfig.usesHubSignInPage`). Both end in the same callback.
    public func signIn(hubURL: String, hubPage: Bool = false) async -> String? {
        guard let start = hubPage ? Self.hubSignInURL(hubURL: hubURL) : Self.ssoStartURL(hubURL: hubURL) else {
            lastError = "Не удалось разобрать адрес хаба."
            return nil
        }
        signingIn = true
        lastError = nil
        defer { signingIn = false }

        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            let session = ASWebAuthenticationSession(
                url: start,
                callbackURLScheme: Self.callbackScheme
            ) { [weak self] callback, error in
                guard let self else { return continuation.resume(returning: nil) }
                if let error {
                    // A cancel is a choice, not a failure worth shouting about.
                    let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                    if !cancelled {
                        self.log.error("sso failed: \(String(describing: error))")
                        self.lastError = "Не удалось войти. Попробуйте ещё раз."
                    }
                    return continuation.resume(returning: nil)
                }
                guard let token = callback.flatMap(Self.sessionToken(from:)) else {
                    self.lastError = "Хаб не вернул сессию."
                    return continuation.resume(returning: nil)
                }
                continuation.resume(returning: token)
            }
            session.presentationContextProvider = self
            // Use the shared Safari cookie jar: someone already signed into HegAI
            // in Safari should not have to type the password again.
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                lastError = "Не удалось открыть окно входа."
                continuation.resume(returning: nil)
            }
        }
    }

    /// How a «Привязать Google» hop ended.
    public enum LinkResult: Equatable, Sendable {
        case linked
        /// Google answered; the app attaches it with ITS session
        /// (`POST /api/auth/google/link/confirm {result}`).
        case confirm(String)
        case cancelled
        /// The hub's stable code (`identity_owner_has_data`, …) or nil.
        case refused(String?)
    }

    /// «Привязать Google»: the same web sheet, opened on a start URL that
    /// carries a one-use link ticket (`POST /api/auth/google/link`, minted
    /// with this app's session — the sheet itself carries none). The hub
    /// answers `ccremote://auth?link_result=<token>` (to confirm with this
    /// app's session) or `?link_error=<code>`; no session comes back.
    public func link(hubURL: String, startPath: String) async -> LinkResult {
        guard let base = Self.apiBase(hubURL: hubURL),
              let start = URL(string: startPath, relativeTo: base)?.absoluteURL,
              start.host == base.host else {
            return .refused(nil)
        }
        signingIn = true
        lastError = nil
        defer { signingIn = false }
        return await withCheckedContinuation { (continuation: CheckedContinuation<LinkResult, Never>) in
            let session = ASWebAuthenticationSession(
                url: start,
                callbackURLScheme: Self.callbackScheme
            ) { [weak self] callback, error in
                if let error {
                    let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                    if !cancelled { self?.log.error("google link failed: \(String(describing: error))") }
                    return continuation.resume(returning: cancelled ? .cancelled : .refused(nil))
                }
                continuation.resume(returning: callback.map(Self.linkResult(from:)) ?? .refused(nil))
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                continuation.resume(returning: .refused(nil))
            }
        }
    }

    public nonisolated static func linkResult(from callback: URL) -> LinkResult {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let token = items.first(where: { $0.name == "link_result" })?.value, !token.isEmpty {
            return .confirm(token)
        }
        if items.contains(where: { $0.name == "linked" }) { return .linked }
        return .refused(items.first { $0.name == "link_error" }?.value)
    }

    /// `wss://code.acme.test/mobile/ui` → `https://code.acme.test/api/auth/google/start?native=1`
    public nonisolated static func ssoStartURL(hubURL: String) -> URL? {
        guard var comps = URLComponents(string: hubURL) else { return nil }
        comps.scheme = (comps.scheme == "ws") ? "http" : "https"
        comps.path = "/api/auth/google/start"
        comps.queryItems = [URLQueryItem(name: "native", value: "1")]
        return comps.url
    }

    /// `wss://hub.acme.io/mobile/ui` → `https://hub.acme.io/native-signin?native=1`:
    /// the hub's own sign-in page for the app's auth browser.
    public nonisolated static func hubSignInURL(hubURL: String) -> URL? {
        guard var comps = URLComponents(string: hubURL) else { return nil }
        comps.scheme = (comps.scheme == "ws") ? "http" : "https"
        comps.path = "/native-signin"
        comps.queryItems = [URLQueryItem(name: "native", value: "1")]
        return comps.url
    }

    /// A page of the configured hub (`/api/privacy`, `/api/support`): the links
    /// in Settings point at the hub the app is signed in to, not at ours.
    /// Falls back to the production hub only when the address cannot be read.
    public nonisolated static func hubPageURL(hubURL: String, path: String) -> URL {
        let fallback = URL(string: "https://code.acme.test")!
        let base = apiBase(hubURL: hubURL).flatMap { $0.host?.isEmpty == false ? $0 : nil } ?? fallback
        return URL(string: path, relativeTo: base)?.absoluteURL ?? base
    }

    /// Whether two hub addresses name the same server (scheme, host and port;
    /// the path — `/mobile/ui` or `/ui` — is not part of the identity).
    public nonisolated static func sameHub(_ a: String, _ b: String) -> Bool {
        guard let x = apiBase(hubURL: a), let y = apiBase(hubURL: b) else { return a == b }
        return x.scheme == y.scheme && x.host?.lowercased() == y.host?.lowercased()
            && (x.port ?? (x.scheme == "http" ? 80 : 443)) == (y.port ?? (y.scheme == "http" ? 80 : 443))
    }

    /// Same origin, http(s) — the base every REST call is built on.
    public nonisolated static func apiBase(hubURL: String) -> URL? {
        guard var comps = URLComponents(string: hubURL) else { return nil }
        comps.scheme = (comps.scheme == "ws") ? "http" : "https"
        comps.path = ""
        comps.query = nil
        return comps.url
    }

    public nonisolated static func sessionToken(from callback: URL) -> String? {
        URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first { $0.name == "session" }?
            .value
            .flatMap { $0.isEmpty ? nil : $0 }
    }
}

extension HegaiAuth: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // `ASPresentationAnchor` is a UIWindow on iOS and an NSWindow on macOS, so
        // the anchor is the one genuinely platform-shaped part of the SSO flow.
        #if canImport(UIKit)
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
        #elseif canImport(AppKit)
        NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #endif
    }
}
