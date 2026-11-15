import Foundation

/// «Войти через Telegram» for the native client — the transport half. The
/// hub's side is server-rs/src/telegram_login{,_api}.rs; the models are in
/// `Protocol/TelegramLogin.swift`. Foundation only (the UI lives in the app).
///
/// Unauthenticated on purpose: this is how a person without a session gets
/// one. `start` asks for `client: "native"`, so the approved poll carries the
/// session in its BODY — there is no cookie jar on the hub's origin here.
///
/// LINKING (Telegram as another way into the signed-in account) is the one
/// authenticated use: `startLink` and `finishLink` carry the app's session as
/// a bearer, and the hub binds the link to THAT account at the start.
public struct TelegramAuthClient: Sendable {
    public struct Refused: Error, Sendable {
        public let status: Int
        public let error: String?
        public var words: String { TelegramLoginWords.refusal(status: status, error: error) }
    }

    public let base: URL
    private let session: URLSession

    /// `hubURL` is the ws endpoint the app is configured with.
    public init?(hubURL: String, session: URLSession = .shared) {
        guard let base = HegaiAuth.apiBase(hubURL: hubURL) else { return nil }
        self.base = base
        self.session = session
    }

    /// `device` is shown on the bot's card — one of the hub's allowed labels
    /// («iPhone», «iPad»); anything else falls back to the User-Agent there.
    public func start(device: String) async throws -> TelegramLoginStart {
        let data = try await post("api/auth/telegram/start", ["client": "native", "device": device])
        return try JSONDecoder().decode(TelegramLoginStart.self, from: data)
    }

    public func poll(_ pollToken: String) async throws -> TelegramLoginPoll {
        let data = try await post("api/auth/telegram/poll", ["pollToken": pollToken])
        return try JSONDecoder().decode(TelegramLoginPoll.self, from: data)
    }

    /// Begin adding Telegram to the account `session` signs into. The poll
    /// answers `confirm_link` with who pressed; `finishLink` makes the link.
    public func startLink(device: String, session: String) async throws -> TelegramLoginStart {
        let data = try await post(
            "api/auth/telegram/start",
            ["intent": "link", "client": "native", "device": device],
            bearer: session
        )
        return try JSONDecoder().decode(TelegramLoginStart.self, from: data)
    }

    /// «Да, это мой @username». Answers the `@username` that was linked.
    public func finishLink(_ pollToken: String, session: String) async throws -> String {
        let data = try await post("api/auth/telegram/link", ["pollToken": pollToken], bearer: session)
        struct Linked: Decodable { let telegram: String? }
        return (try? JSONDecoder().decode(Linked.self, from: data))?.telegram ?? ""
    }

    private func post(_ path: String, _ body: [String: String], bearer: String? = nil) async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer, !bearer.isEmpty {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            struct ErrorBody: Decodable { let error: String? }
            throw Refused(status: status, error: (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error)
        }
        return data
    }
}
