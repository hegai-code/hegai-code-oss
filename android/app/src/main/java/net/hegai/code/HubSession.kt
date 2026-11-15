package net.hegai.code

import android.content.Context
import net.hegai.code.core.SessionBinding

/**
 * The stored workspace session, bound to the hub that issued it ([SessionBinding]). Reads never return a
 * session for a hub other than the one asked about; [forHub] reports a foreign one so the caller can
 * clear it and revoke it where it was issued.
 */
class HubSession(private val context: Context) {
    private val vault = SessionVault(context)
    /** null: nothing stored (or unreadable). */
    fun open(hub: String): SessionBinding.Opened? = vault.read()?.let { SessionBinding.open(it, hub) }
    /** The token if, and only if, it belongs to [hub]. */
    fun forHub(hub: String): String? = (open(hub) as? SessionBinding.Opened.Valid)?.token
    /**
     * The configured hub and its session as ONE pair (null: signed out, or the stored session belongs to another
     * hub). Workers and receivers use both halves of this value for the URL and the bearer — never a second
     * [HubConfig.base] read next to a separately read token.
     */
    fun bound(): SessionBinding.Bound? = SessionBinding.bound(vault.read(), HubConfig.base(context))
    fun write(hub: String, token: String) = vault.write(SessionBinding.seal(hub, token))
    /** false: the removal did not reach storage, so the session may still be there. */
    fun clear(): Boolean = vault.clear()
}
