package net.hegai.code.core

import java.net.URI
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The hub a customer runs is addressed by one origin (`https://host[:port]`). Everything else the
 * app needs — the WebSocket endpoint, sign-in, push, privacy links — is derived from it here, so
 * no screen assembles a hub URL by hand. iOS keeps the same choice in `AppSettings.hubURL`.
 */
object HubUrl {
    const val DEFAULT = "https://code.acme.test"
    /** Pre-rename production host: still the same hub, still accepted in report links. */
    const val LEGACY_HOST = "claude.acme.test"

    /**
     * Turns what a person typed (`hub.acme.io`, `https://hub.acme.io/`, `wss://hub.acme.io/mobile/ui`)
     * into the canonical origin, or null when it is not an https hub address. Plain http, credentials,
     * queries, fragments and any other path are refused: the bearer token travels to this host.
     */
    fun normalize(raw: String): String? {
        var text = raw.trim()
        if (text.isEmpty() || text.length > 253 || text.any { it.isWhitespace() }) return null
        if (!text.contains("://")) text = "https://$text"
        val uri = runCatching { URI(text) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() !in setOf("https", "wss")) return null
        val host = uri.host?.lowercase()?.trimEnd('.')?.takeIf { it.isNotEmpty() } ?: return null
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
        if (uri.rawPath !in setOf("", "/", "/mobile/ui", "/mobile/ui/")) return null
        val port = uri.port
        if (port != -1 && port !in 1..65535) return null
        return if (port == -1 || port == 443) "https://$host" else "https://$host:$port"
    }

    fun isDefault(base: String) = base == DEFAULT

    /** `host` or `host:port` — what Settings shows. */
    fun label(base: String): String = base.removePrefix("https://")

    fun ui(base: String) = "$base/mobile/ui"
    fun health(base: String) = "$base/health"
    fun googleStart(base: String) = "$base/api/auth/google/start"
    fun publicConfig(base: String) = "$base/api/public-config"
    /** The hub's own sign-in page for the Custom Tab (customer hubs; see [HubPublicConfig]). */
    fun nativeSignIn(base: String) = "$base/native-signin"
    fun exchange(base: String) = "$base/api/auth/android/exchange"
    fun reviewLogin(base: String) = "$base/api/auth/review-login"
    fun telegram(base: String, path: String) = "$base/api/auth/telegram/$path"
    fun logout(base: String) = "$base/api/logout"
    fun privacy(base: String) = "$base/privacy/"
    fun deleteAccount(base: String) = "$base/delete-account/"
    fun install(base: String) = "$base/install"
    fun report(base: String, id: String) = "$base/w/reports/$id"

    /** `/health` answers `{"ok":true}`; anything else is not one of our hubs. */
    fun isHealthy(body: String): Boolean = runCatching {
        ((wireJson.parseToJsonElement(body) as? JsonObject)?.get("ok") as? JsonPrimitive)?.content == "true"
    }.getOrDefault(false)

    /** Whether a link's host/port is this hub (the pre-rename production host counts for the default hub). */
    fun matches(base: String, host: String?, port: Int): Boolean {
        val target = runCatching { URI(base) }.getOrNull() ?: return false
        val wanted = target.host?.lowercase() ?: return false
        val allowed = if (isDefault(base)) setOf(wanted, LEGACY_HOST) else setOf(wanted)
        val effective = if (target.port == -1) 443 else target.port
        val given = if (port == -1) 443 else port
        return host?.lowercase() in allowed && given == effective
    }
}
