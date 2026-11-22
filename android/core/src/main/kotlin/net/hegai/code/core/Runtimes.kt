package net.hegai.code.core

import kotlinx.serialization.json.*

/**
 * Which coder a machine can actually start a session on, as the agent said in `runtimes`
 * (web/src/components/runtimeChips.ts: `runtimeUsable`, `pickRuntime`). Unknown — an agent too old to
 * report, or a runtime it did not mention — reads as usable: second-guessing it would hide a working runtime.
 */
object Runtimes {
    private fun status(runtimes: JsonObject?, which: String): JsonObject? = runtimes?.get(which) as? JsonObject
    private fun JsonObject.flag(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

    /** Claude switched off on the machine by its owner: nothing to offer, nothing to warn about. */
    fun claudeOff(runtimes: JsonObject?): Boolean = status(runtimes, "claude")?.string("error") == "disabled"

    fun usable(runtimes: JsonObject?, which: String): Boolean {
        val s = status(runtimes, which) ?: return true
        val error = s.string("error").orEmpty()
        val auth = s.string("auth").orEmpty()
        if (s.flag("present") == false) return false
        if (which == "claude") return auth != "none" && error !in setOf("disabled", "sdk_binary_missing", "logged_out", "token_expired", "token_rejected")
        if (error == "not_found") return false
        if (s.string("provider") == "gateway") return true // a gateway machine needs no login of its own
        return auth != "none" && error != "not_logged_in"
    }

    /** The preferred runtime unless it cannot start and the other can; with neither usable the preference stands. */
    fun pick(runtimes: JsonObject?, preferred: String): String {
        val other = if (preferred == "claude") "codex" else "claude"
        return if (!usable(runtimes, preferred) && usable(runtimes, other)) other else preferred
    }

    /** One line for a person who picked a runtime that cannot start here; null when it can (or is unknown). */
    fun problem(runtimes: JsonObject?, which: String): String? {
        if (usable(runtimes, which)) return null
        val s = status(runtimes, which)
        val name = if (which == "claude") "Claude" else "Codex"
        return when {
            which == "claude" && claudeOff(runtimes) -> "Claude выключен на этой машине."
            s?.flag("present") == false || s?.string("error") == "not_found" -> "$name не установлен на этой машине — выберите другого агента или установите его на машине."
            else -> "$name не вошёл на этой машине — выберите другого агента или войдите на машине (${if (which == "claude") "claude" else "codex login"})."
        }
    }
}
