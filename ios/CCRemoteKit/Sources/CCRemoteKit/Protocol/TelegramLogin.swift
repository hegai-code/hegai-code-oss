import Foundation

// «Войти через Telegram» — mirrors of `TelegramLoginStart` / `TelegramLoginPoll`
// in shared/src/web-protocol.ts (hub: server-rs/src/telegram_login_api.rs).
// Foundation only, so the Linux protocol check compiles and tests them.

/// `POST /api/auth/telegram/start` with `client: "native"`.
/// `match` is the number the app MUST show: the person presses the same one
/// in the bot, and a wrong one kills the login — that is what stops a login
/// someone else started (phishing) from going through.
public struct TelegramLoginStart: Codable, Hashable, Sendable {
    public let code: String
    public let url: String
    public let bot: String
    public let pollToken: String
    public let match: String
    public let expiresAt: Double
    public let interval: Double

    /// Only ever a Telegram bot link. The hub builds `https://t.me/<bot>…`
    /// itself, but the hub address is editable in the app, and a URL handed
    /// straight to `openURL` could be any scheme (another app, `ccremote://`).
    public var link: URL? {
        guard let u = URL(string: url), u.scheme == "https",
              let host = u.host?.lowercased(), host == "t.me" || host == "telegram.me" else { return nil }
        return u
    }
}

public struct TelegramLoginAccount: Codable, Hashable, Sendable {
    public let userId: String
    public let displayName: String
    public var state: String?
}

/// `POST /api/auth/telegram/poll`. A native client gets its session in the
/// body of `approved` (there is no cookie jar on the hub's origin), exactly
/// once. Unknown statuses decode as `.other` so a newer hub never breaks the
/// poll loop.
public enum TelegramLoginPoll: Decodable, Hashable, Sendable {
    case pending
    case denied
    case expired
    case used
    case unknown
    case confirmLink(telegram: String)
    case approved(session: String, userId: String, telegram: String, account: TelegramLoginAccount)
    case other(String)

    private enum Keys: String, CodingKey { case status, session, userId, telegram, account }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let status = try c.decode(String.self, forKey: .status)
        switch status {
        case "pending": self = .pending
        case "denied": self = .denied
        case "expired": self = .expired
        case "used": self = .used
        case "unknown": self = .unknown
        case "confirm_link": self = .confirmLink(telegram: try c.decode(String.self, forKey: .telegram))
        case "approved":
            self = .approved(
                session: try c.decode(String.self, forKey: .session),
                userId: try c.decode(String.self, forKey: .userId),
                telegram: try c.decode(String.self, forKey: .telegram),
                account: try c.decode(TelegramLoginAccount.self, forKey: .account)
            )
        default: self = .other(status)
        }
    }

    /// The poll is over and the login did not happen.
    public var isDeadEnd: Bool {
        switch self {
        case .denied, .expired, .used, .unknown, .other: return true
        default: return false
        }
    }
}

/// What the person reads when a Telegram sign-in ends without a session.
/// One place, so the words match the web's (web/src/telegramLogin.ts).
public enum TelegramLoginWords {
    public static func end(_ poll: TelegramLoginPoll) -> String {
        switch poll {
        case .denied:
            return "Вход отменён в Telegram: там нажали «Это не я», не то число, или ссылку открыли с двух аккаунтов."
        case .expired:
            return "Время вышло — ссылка живёт 10 минут. Начните заново."
        default:
            return "Этот вход уже завершён. Начните заново."
        }
    }

    /// A hub refusal of `start` / `poll`, by HTTP status and `{"error": …}`.
    public static func refusal(status: Int, error: String?) -> String {
        if status == 404, error?.contains("not configured") == true {
            return "Вход через Telegram на этом сервере выключен."
        }
        if status == 429 {
            return "Слишком много попыток с этого адреса. Подождите немного и начните заново."
        }
        switch error {
        case "identity_owner_has_data", "account_deleting", "access_not_active", "mfa_browser_required":
            return IdentityWords.error(error)
        case "expired":
            return "Время вышло. Начните заново."
        case "decided":
            return "Этот вход уже завершён. Начните заново."
        default:
            return "Не получилось. Попробуйте ещё раз."
        }
    }
}
