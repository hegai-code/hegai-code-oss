import Foundation

// «Способы входа» — mirrors of `GET /api/me/identities` (hub:
// server-rs/src/identity.rs, `api_my_identities` in workspace_api.rs).
// Foundation only, so the Linux protocol check compiles them.

/// One way into the signed-in account. `label` and `lastUsedAt` are absent
/// when the hub has nothing to say (never `null` on the wire).
public struct LinkedIdentity: Codable, Hashable, Sendable, Identifiable {
    public let provider: String
    public let subject: String
    public var label: String?
    public let linkedAt: Double
    public var lastUsedAt: Double?

    public var id: String { "\(provider):\(subject)" }

    /// What the person calls this way in.
    public var providerName: String {
        switch provider {
        case "hegai": return "HegAI"
        case "google": return "Google"
        case "telegram": return "Telegram"
        case "apple": return "Apple"
        default: return provider
        }
    }
}

public struct IdentityProviders: Codable, Hashable, Sendable {
    public var google: Bool
    public var apple: Bool
    public var telegram: Bool
}

public struct IdentitiesResponse: Codable, Hashable, Sendable {
    public let identities: [LinkedIdentity]
    public let available: IdentityProviders
}

/// `POST /api/auth/google/link` — a one-use ticket and the start path to open
/// in the web sheet (`/api/auth/google/start?native=1&link=<ticket>`).
public struct GoogleLinkTicket: Codable, Hashable, Sendable {
    public let ticket: String
    public let path: String
}

/// Words for a link or unlink the hub refused, by its stable code — the same
/// words as web/src/identities.ts.
public enum IdentityWords {
    public static func error(_ code: String?) -> String {
        switch code {
        case "identity_owner_has_data":
            return "Этот способ входа уже открывает другую учётку Hegai Code, и в ней есть машины, сессии или команды — перенести его сюда нельзя. Напишите администратору, чтобы объединить учётки."
        case "account_deleting":
            return "Эта учётка удаляется — новые способы входа к ней не привязываются."
        case "access_not_active":
            return "Привязать способ входа можно после того, как администратор откроет доступ."
        case "mfa_browser_required":
            return "Включена двухфакторная защита — войдите через браузер"
        case "last_identity":
            return "Это последний способ входа — без него в учётку будет не войти. Сначала привяжите другой."
        case "bootstrap_hegai":
            return "Это владелец сервера: вход через HegAI у него отвязать нельзя."
        case "link_cancelled":
            return "Привязка отменена."
        case "apple_token_changed":
            return "Вход через Apple только что обновился — нажмите «Отвязать» ещё раз."
        case "not_linked":
            return "Этот способ входа уже отвязан."
        case "apple_revoke_failed", "apple_revoke_unavailable":
            return "Apple не подтвердил отзыв входа — ничего не отвязано. Попробуйте позже."
        default:
            return "Не получилось. Попробуйте ещё раз."
        }
    }
}
