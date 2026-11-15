package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

class RevokeQueueTest {
    private val acme = "https://code.acme.test"

    @Test fun aSecondEntryDoesNotOverwriteTheFirst() {
        val one = RevokeQueue.add(null, HubUrl.DEFAULT, "a")
        val two = RevokeQueue.add(one, acme, "b")
        assertEquals(listOf(HubUrl.DEFAULT to "a", acme to "b"), RevokeQueue.decode(two))
    }

    @Test fun legacyEntriesStillRead() {
        assertEquals(listOf(HubUrl.DEFAULT to "tok"), RevokeQueue.decode("tok"))
        assertEquals(listOf(acme to "tok"), RevokeQueue.decode("$acme\ntok"))
        assertTrue(RevokeQueue.decode(null).isEmpty())
    }

    @Test fun doneEntriesLeaveTheRest() {
        val q = RevokeQueue.add(RevokeQueue.add(null, HubUrl.DEFAULT, "a"), acme, "b")
        assertEquals(listOf(acme to "b"), RevokeQueue.decode(RevokeQueue.without(q, listOf(HubUrl.DEFAULT to "a"))))
        assertNull(RevokeQueue.without(q, RevokeQueue.decode(q)))
    }
}
