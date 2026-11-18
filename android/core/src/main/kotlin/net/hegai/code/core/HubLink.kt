package net.hegai.code.core

import java.net.URI
import java.net.URLDecoder

/**
 * A "server code" (QR or link) only PROPOSES a hub; the app confirms before switching. Accepted:
 * `ccremote://connect?hub=<https origin>`, `https://host[:port]/app[/]` (the hub's own QR), and anything
 * [HubUrl.normalize] takes (`host`, `https://host`, legacy `wss://host/mobile/ui`).
 */
object HubLink {
    /** The hub origin the text points at, or null when it is not a hub address. */
    fun parse(text: String): String? {
        val raw = text.trim()
        if (raw.isEmpty() || raw.length > 2048) return null
        if (raw.startsWith("ccremote:", ignoreCase = true)) {
            val uri = runCatching { URI(raw) }.getOrNull() ?: return null
            if (uri.host?.lowercase() != "connect" || uri.rawUserInfo != null) return null
            val hub = uri.rawQuery?.split('&')
                ?.map { it.substringBefore('=') to it.substringAfter('=', "") }
                ?.firstOrNull { it.first == "hub" }?.second ?: return null
            val decoded = runCatching { URLDecoder.decode(hub, "UTF-8") }.getOrNull() ?: return null
            return HubUrl.normalize(decoded)
        }
        val uri = runCatching { URI(if (raw.contains("://")) raw else "https://$raw") }.getOrNull()
        if (uri != null && uri.scheme?.lowercase() == "https" && uri.rawPath in setOf("/app", "/app/")
            && uri.rawQuery == null && uri.rawFragment == null && uri.rawUserInfo == null) {
            val port = if (uri.port == -1) "" else ":${uri.port}"
            return uri.host?.let { HubUrl.normalize("https://$it$port") }
        }
        return HubUrl.normalize(raw)
    }

    fun connectUrl(hub: String): String = "ccremote://connect?hub=" + java.net.URLEncoder.encode(hub, "UTF-8")
}
