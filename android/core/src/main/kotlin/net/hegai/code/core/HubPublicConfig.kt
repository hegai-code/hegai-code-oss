package net.hegai.code.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject

/**
 * `GET /api/public-config` — which ways in a hub offers (server-rs/src/public_config.rs). Decides the
 * sign-in screen: the internal hub keeps Google / Telegram; a customer's hub (external edition) has its
 * own page, `/native-signin`, opened in a Custom Tab — password + authenticator code, OIDC — and ending
 * in the same `hegai-code://auth?code=…` PKCE hand-off. iOS twin: `HubPublicConfig.swift`.
 */
data class HubPublicConfig(
    val edition: String,
    val brandName: String,
    val local: Boolean,
    val google: Boolean,
    val telegram: Boolean,
    val apple: Boolean,
    val oidcName: String?,
) {
    /**
     * True for a customer's hub, and for any hub without Google but with a password or OIDC login (Android
     * has no Apple sign-in, so Apple does not count). Everything else — the internal hub, and a hub that gave
     * no answer (null) — keeps the buttons the app has always had.
     */
    val usesHubSignInPage: Boolean
        get() = edition == "external" || (!google && (local || oidcName != null))

    companion object {
        fun parse(body: String): HubPublicConfig? = runCatching {
            val root = wireJson.parseToJsonElement(body).jsonObject
            val auth = root["auth"] as? JsonObject ?: return null
            fun flag(key: String) = (auth[key] as? JsonPrimitive)?.booleanOrNull ?: false
            HubPublicConfig(
                edition = (root["edition"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null,
                brandName = (root["brandName"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "Hegai Code",
                local = flag("local"), google = flag("google"), telegram = flag("telegram"), apple = flag("apple"),
                oidcName = ((auth["oidc"] as? JsonObject)?.get("name") as? JsonPrimitive)?.takeIf { it.isString }?.content,
            )
        }.getOrNull()
    }
}
