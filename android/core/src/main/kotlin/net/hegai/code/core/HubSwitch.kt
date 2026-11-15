package net.hegai.code.core

/**
 * Pointing the app at another hub as a transaction. The old hub's session, caches and drafts are the person's
 * data: they must survive a switch that does not happen, so nothing is destroyed before the new address is stored.
 *
 * Order: commit the new hub FIRST, keeping the old hub-bound credential -> then clear the credential. A process
 * death between the two leaves a session sealed for the OLD hub while the new one is configured; [SessionBinding]
 * opens it as foreign, so it is never sent to the new server — it is cleared and revoked where it was issued.
 * A failed commit changes nothing. The caller clears caches and drafts and revokes the old session at the old hub
 * only after [Outcome.Committed].
 */
object HubSwitch {
    sealed interface Outcome {
        data object Committed : Outcome
        /** Nothing changed: the app is still on the old hub with its session ([message] is shown to the person). */
        data class Failed(val message: String) : Outcome
    }

    fun run(commit: () -> Unit, clearCredential: () -> Boolean): Outcome {
        try {
            commit()
        } catch (e: Exception) {
            return Outcome.Failed(e.message ?: "Не удалось сохранить адрес сервера")
        }
        // Best effort: a credential left behind is bound to the old hub and is refused on the new one.
        runCatching { clearCredential() }
        return Outcome.Committed
    }
}
