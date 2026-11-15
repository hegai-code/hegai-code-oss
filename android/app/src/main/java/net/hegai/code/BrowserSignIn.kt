package net.hegai.code

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.serialization.json.*
import net.hegai.code.core.*
import java.security.MessageDigest
import java.security.SecureRandom

/** The scheme is public. Only the private verifier can exchange its one-use code. */
class BrowserSignIn(context: Context) {
    private val vault = SessionVault(context, "browser-sign-in")
    private fun random(): String = ByteArray(32).also(SecureRandom()::nextBytes).let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
    /** [hubPage]: a customer's hub — its own `/native-signin` instead of the Google hop; the hand-off is identical. */
    fun launch(context: Context, hub: String, hubPage: Boolean = false) {
        val verifier = random(); val state = random()
        val challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        vault.write(buildJsonObject { put("verifier", verifier); put("state", state); put("created", System.currentTimeMillis()) }.toString())
        val uri = Uri.parse(if (hubPage) HubUrl.nativeSignIn(hub) else HubUrl.googleStart(hub)).buildUpon()
            .appendQueryParameter("android", "1").appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("client_state", state).build()
        CustomTabsIntent.Builder().build().launchUrl(context, uri)
    }
    fun exchangeBody(uri: Uri): JsonObject? {
        if (uri.scheme != "hegai-code" || uri.host != "auth" || !uri.path.isNullOrEmpty() || uri.fragment != null || uri.port != -1 || uri.userInfo != null) return null
        if (uri.getQueryParameters("state").size != 1 || uri.getQueryParameters("code").size != 1) return null
        val pending = runCatching { wireJson.parseToJsonElement(vault.read() ?: return null).jsonObject }.getOrNull() ?: return null
        val age = System.currentTimeMillis() - (pending["created"]?.jsonPrimitive?.longOrNull ?: return null)
        if (age !in 0..600_000 || pending.string("state") != uri.getQueryParameter("state")) return null
        val code = uri.getQueryParameter("code")?.takeIf { it.length == 64 && it.all { c -> c.isDigit() || c in 'a'..'f' } } ?: return null
        return buildJsonObject { put("code", code); put("code_verifier", pending.string("verifier")) }
    }
    fun clear() = vault.clear()
}
