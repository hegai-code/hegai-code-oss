package net.hegai.code.core

import java.net.URLEncoder

/** The link an owner forwards to an invitee: the hub's one-time setup link when it gives one, else `<hub>/?invite=<token>`. */
object InviteLink {
    fun build(hub: String, token: String?, setupUrl: String?): String? {
        setupUrl?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        val t = token?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return "$hub/?invite=" + URLEncoder.encode(t, "UTF-8")
    }
}
