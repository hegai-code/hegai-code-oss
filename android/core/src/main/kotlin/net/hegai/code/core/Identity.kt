package net.hegai.code.core

import java.net.URI
import kotlinx.serialization.Serializable

@Serializable data class TelegramLogin(
    val code: String, val url: String, val bot: String, val pollToken: String,
    val match: String, val expiresAt: Double, val interval: Double,
) {
    /** Never hand an arbitrary scheme, credentials or a forged host to Android. */
    val safeLink: String? get() = runCatching { URI(url) }.getOrNull()?.takeIf {
        it.scheme == "https" && it.host?.lowercase() in setOf("t.me", "telegram.me") &&
            it.rawUserInfo == null && it.port == -1 && it.rawFragment == null &&
            bot.matches(Regex("[A-Za-z0-9_]{5,32}")) && it.path == "/$bot"
    }?.toASCIIString()
    val valid: Boolean get() = safeLink != null && match.matches(Regex("[0-9]{2}")) &&
        pollToken.isNotBlank() && pollToken.length <= 4096 && interval.isFinite() && interval > 0
}

@Serializable data class LinkedIdentity(val provider: String, val subject: String, val label: String? = null,
    val linkedAt: Double = 0.0, val lastUsedAt: Double? = null) {
    val name: String get() = when (provider) { "google" -> "Google"; "telegram" -> "Telegram"; "apple" -> "Apple"; "hegai" -> "HegAI"; else -> provider }
}
@Serializable data class IdentityProviders(val google: Boolean = false, val apple: Boolean = false, val telegram: Boolean = false)
@Serializable data class Identities(val identities: List<LinkedIdentity>, val available: IdentityProviders)

fun identityError(code: String?): String = when (code) {
    "identity_owner_has_data" -> "Этот способ входа открывает другую учётку с машинами, сессиями или командами. Для объединения обратитесь к администратору."
    "account_deleting" -> "Эта учётка удаляется. Привязать новый вход нельзя."
    "access_not_active" -> "Привязать способ входа можно после открытия доступа."
    "mfa_browser_required" -> "Включена двухфакторная защита — войдите через браузер"
    "last_identity" -> "Это последний способ входа. Сначала привяжите другой."
    "bootstrap_hegai" -> "Владельцу сервера нельзя отвязать вход через HegAI."
    "link_cancelled" -> "Привязка отменена."
    "not_linked" -> "Этот способ входа уже отвязан."
    "apple_token_changed" -> "Вход через Apple обновился. Нажмите «Отвязать» ещё раз."
    "apple_revoke_failed", "apple_revoke_unavailable" -> "Apple не подтвердил отзыв входа. Попробуйте позже."
    else -> code ?: "Не получилось. Попробуйте ещё раз."
}

fun telegramEnd(status: String): String = when (status) {
    "denied" -> "Вход отменён в Telegram: нажали «Это не я», не то число или открыли ссылку с двух аккаунтов."
    "expired" -> "Время вышло — ссылка живёт 10 минут. Начните заново."
    else -> "Этот вход уже завершён. Начните заново."
}
