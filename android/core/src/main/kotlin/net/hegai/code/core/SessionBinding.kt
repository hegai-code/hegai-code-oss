package net.hegai.code.core

/**
 * A session token is only good at the hub that issued it. Stored next to the hub's origin, so a phone
 * that was pointed at another hub (a half-finished switch, a killed process, a restored preference)
 * never sends the old bearer to a server that did not mint it.
 *
 * Format: `<hub origin>\n<token>`. A bare token is from a build before this binding: released
 * builds only knew the production hub, so on it the token is valid. On any other hub its origin is
 * unproven, and it is dropped — not sent there, and not revoked anywhere (that would send a live
 * token to a server that may not have issued it).
 */
object SessionBinding {
    sealed interface Opened {
        /** The session was issued by the hub the app is on. */
        data class Valid(val token: String) : Opened
        /** It was issued by [hub] (null: unreadable origin) — not the current one; never send it. */
        data class Foreign(val hub: String?, val token: String) : Opened
    }

    /** A hub and the session it issued, read together: use BOTH from this value, never re-read either half. */
    data class Bound(val hub: String, val token: String)

    /** The pair for [currentHub], or null when nothing is stored or the stored session belongs to another hub. */
    fun bound(stored: String?, currentHub: String): Bound? =
        (stored?.let { open(it, currentHub) } as? Opened.Valid)?.let { Bound(currentHub, it.token) }

    fun seal(hub: String, token: String): String {
        require(token.isNotEmpty() && '\n' !in token) { "Некорректная сессия" }
        return "$hub\n$token"
    }

    fun open(stored: String, currentHub: String): Opened {
        val split = stored.indexOf('\n')
        // A bare token predates the binding. Released builds before it only knew the production
        // hub, so there it is valid; anywhere else its origin is unproven — never sent, never revoked.
        val hub = if (split < 0) (if (currentHub == HubUrl.DEFAULT) currentHub else null) else HubUrl.normalize(stored.substring(0, split))
        val token = if (split < 0) stored else stored.substring(split + 1)
        return if (hub != null && hub == currentHub) Opened.Valid(token) else Opened.Foreign(hub, token)
    }
}
