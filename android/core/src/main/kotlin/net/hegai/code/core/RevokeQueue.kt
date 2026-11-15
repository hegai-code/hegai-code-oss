package net.hegai.code.core

/**
 * Sessions still to be revoked at the hub that issued them, as ONE stored string: entries `<hub>\n<token>`
 * separated by the ASCII record separator. A queue, not a slot — a second sign-out or hub switch while the
 * first revocation is still pending (offline) must not drop the first token, which would leave that session
 * alive with no local copy to revoke it. A bare token (old builds) is an entry of the production hub.
 */
object RevokeQueue {
    private const val RS = '\u001e'

    fun decode(stored: String?): List<Pair<String, String>> =
        stored.orEmpty().split(RS).filter { it.isNotEmpty() }.map { entry ->
            if ('\n' in entry) entry.substringBefore('\n') to entry.substringAfter('\n') else HubUrl.DEFAULT to entry
        }.filter { it.second.isNotEmpty() }

    fun encode(entries: List<Pair<String, String>>): String? =
        entries.distinct().takeIf { it.isNotEmpty() }?.joinToString(RS.toString()) { (hub, token) -> "$hub\n$token" }

    fun add(stored: String?, hub: String, token: String): String =
        encode(decode(stored) + (hub to token))!!

    /** What is left after [done] were revoked. */
    fun without(stored: String?, done: Collection<Pair<String, String>>): String? =
        encode(decode(stored).filterNot { it in done })
}
