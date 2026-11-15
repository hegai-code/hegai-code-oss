package net.hegai.code

import android.content.Context
import net.hegai.code.core.HubUrl

/**
 * The one place that remembers which hub this phone talks to (iOS: `AppSettings.hubURL`).
 * Not a secret, so plain SharedPreferences; the session token lives in [SessionVault].
 * Workers and receivers read it too, hence the static accessors.
 */
object HubConfig {
    private const val FILE = "hub-config"
    private const val KEY = "base"

    /** Canonical `https://host[:port]`; the production hub until the person picks another. */
    fun base(context: Context): String {
        val stored = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null)
        return stored?.let(HubUrl::normalize) ?: HubUrl.DEFAULT
    }

    fun save(context: Context, base: String) {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
        if (HubUrl.isDefault(base)) prefs.remove(KEY) else prefs.putString(KEY, base)
        check(prefs.commit()) { "Не удалось сохранить адрес сервера" }
    }
}
