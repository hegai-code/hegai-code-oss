package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

/** A hub switch that fails to commit leaves the app on the old hub with its session; one that commits never
 *  lets the old session reach the new hub. */
class HubSwitchTest {
    private val acme = "https://code.acme.test"

    @Test fun commitsTheHubBeforeTheCredentialIsCleared() {
        val log = mutableListOf<String>()
        val outcome = HubSwitch.run(
            commit = { log += "commit" },
            clearCredential = { log += "clear"; true },
        )
        assertEquals(HubSwitch.Outcome.Committed, outcome)
        assertEquals(listOf("commit", "clear"), log)
    }

    @Test fun aFailedCommitTouchesNothing() {
        val log = mutableListOf<String>()
        val outcome = HubSwitch.run(
            commit = { log += "commit"; throw IllegalStateException("диск") },
            clearCredential = { log += "clear"; true },
        )
        assertEquals(HubSwitch.Outcome.Failed("диск"), outcome)
        assertEquals(listOf("commit"), log)
    }

    @Test fun aCredentialLeftBehindAfterTheCommitIsForeignOnTheNewHub() {
        // Process death (or a failed clear) after the commit: the old session is still sealed for the old hub.
        val outcome = HubSwitch.run(commit = {}, clearCredential = { throw IllegalStateException("хранилище") })
        assertEquals(HubSwitch.Outcome.Committed, outcome)
        val left = SessionBinding.seal(HubUrl.DEFAULT, "old")
        assertEquals(SessionBinding.Opened.Foreign(HubUrl.DEFAULT, "old"), SessionBinding.open(left, acme))
    }

    @Test fun boundPairIsTheHubAndItsOwnSessionOnly() {
        val sealed = SessionBinding.seal(acme, "tok")
        assertEquals(SessionBinding.Bound(acme, "tok"), SessionBinding.bound(sealed, acme))
        assertNull(SessionBinding.bound(sealed, HubUrl.DEFAULT))
        assertNull(SessionBinding.bound(null, acme))
    }
}
