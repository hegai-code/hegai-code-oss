import Foundation

/// `GET /api/public-config` — which ways in a hub offers, readable before anyone
/// is signed in (server-rs/src/public_config.rs). The app asks it to decide
/// what the sign-in screen draws: the internal hub keeps Google / Apple /
/// Telegram; a customer's own hub (external edition) has its own sign-in page
/// (`/native-signin`: password + authenticator code, OIDC), which the app opens
/// in the same `ASWebAuthenticationSession` and which ends in the same
/// `ccremote://auth?session=…` callback.
public struct HubPublicConfig: Decodable, Equatable, Sendable {
    public struct Oidc: Decodable, Equatable, Sendable {
        public let name: String
        public init(name: String) { self.name = name }
    }

    public struct Auth: Decodable, Equatable, Sendable {
        public let local: Bool
        public let google: Bool
        public let telegram: Bool
        public let apple: Bool
        public let oidc: Oidc?
        public let hegaiSso: Bool

        public init(local: Bool = false, google: Bool = false, telegram: Bool = false,
                    apple: Bool = false, oidc: Oidc? = nil, hegaiSso: Bool = false) {
            self.local = local
            self.google = google
            self.telegram = telegram
            self.apple = apple
            self.oidc = oidc
            self.hegaiSso = hegaiSso
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            local = try c.decodeIfPresent(Bool.self, forKey: .local) ?? false
            google = try c.decodeIfPresent(Bool.self, forKey: .google) ?? false
            telegram = try c.decodeIfPresent(Bool.self, forKey: .telegram) ?? false
            apple = try c.decodeIfPresent(Bool.self, forKey: .apple) ?? false
            oidc = try c.decodeIfPresent(Oidc.self, forKey: .oidc)
            hegaiSso = try c.decodeIfPresent(Bool.self, forKey: .hegaiSso) ?? false
        }

        private enum CodingKeys: String, CodingKey { case local, google, telegram, apple, oidc, hegaiSso }
    }

    public let edition: String
    public let brandName: String
    public let auth: Auth

    public init(edition: String, brandName: String = "Hegai Code", auth: Auth) {
        self.edition = edition
        self.brandName = brandName
        self.auth = auth
    }

    /// Whether the way in is the hub's own sign-in page rather than the
    /// built-in «Войти через Google». True for a customer's hub, and for any
    /// hub that has no Google and no Apple but does offer a password or OIDC
    /// login (a dev hub). Everything else — the internal hub, and any hub that
    /// did not answer (`nil` config) — keeps the buttons the app has always had.
    public var usesHubSignInPage: Bool {
        if edition == "external" { return true }
        return !auth.google && !auth.apple && (auth.local || auth.oidc != nil)
    }

    /// `wss://host/mobile/ui` → `https://host/api/public-config`.
    public nonisolated static func url(hubURL: String) -> URL? {
        guard var comps = URLComponents(string: hubURL) else { return nil }
        comps.scheme = (comps.scheme == "ws") ? "http" : "https"
        comps.path = "/api/public-config"
        comps.query = nil
        return comps.url
    }

    public nonisolated static func decode(_ data: Data) -> HubPublicConfig? {
        try? JSONDecoder().decode(HubPublicConfig.self, from: data)
    }

    /// The hub's answer, or nil when it gave none (an older hub, no network, an
    /// error page): the caller then behaves as it always has.
    /// The largest public config the app accepts (it is a few hundred bytes).
    public static let maxBytes = 16 * 1024

    public nonisolated static func fetch(hubURL: String, session: URLSession = .shared) async -> HubPublicConfig? {
        guard let url = url(hubURL: hubURL) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Read at most `maxBytes`: a hub (possibly not ours) must not be able
        // to make the app buffer an unbounded answer. Android caps it the same.
        guard let (bytes, response) = try? await session.bytes(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxBytes { return nil }
            }
        } catch {
            return nil
        }
        return decode(data)
    }
}
