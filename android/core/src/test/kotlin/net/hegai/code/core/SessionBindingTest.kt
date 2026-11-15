package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

/** A stored session is only ever opened for the hub that issued it. */
class SessionBindingTest {
    private val acme = "https://code.acme.test"

    @Test fun roundTripsForTheSameHub() {
        val sealed = SessionBinding.seal(acme, "tok-123")
        assertEquals(SessionBinding.Opened.Valid("tok-123"), SessionBinding.open(sealed, acme))
    }

    @Test fun aSessionOfAnotherHubIsForeignAndNeverValid() {
        val sealed = SessionBinding.seal(acme, "tok-123")
        assertEquals(SessionBinding.Opened.Foreign(acme, "tok-123"), SessionBinding.open(sealed, HubUrl.DEFAULT))
        assertEquals(SessionBinding.Opened.Foreign(acme, "tok-123"), SessionBinding.open(sealed, "https://code.acme.test:8443"))
        // the production session does not follow the phone to a customer's hub
        val production = SessionBinding.seal(HubUrl.DEFAULT, "tok-prod")
        assertEquals(SessionBinding.Opened.Foreign(HubUrl.DEFAULT, "tok-prod"), SessionBinding.open(production, acme))
    }

    @Test fun aBareLegacyTokenIsValidOnlyOnTheProductionHub() {
        assertEquals(SessionBinding.Opened.Valid("old-token"), SessionBinding.open("old-token", HubUrl.DEFAULT))
        // Elsewhere its origin is unproven: neither sent to this hub nor revoked at another one.
        assertEquals(SessionBinding.Opened.Foreign(null, "old-token"), SessionBinding.open("old-token", acme))
    }

    @Test fun anUnreadableOriginIsForeignEverywhere() {
        val opened = SessionBinding.open("http://evil.test\ntok", HubUrl.DEFAULT)
        assertEquals(SessionBinding.Opened.Foreign(null, "tok"), opened)
        assertTrue(SessionBinding.open("\ntok", acme) is SessionBinding.Opened.Foreign)
    }

    @Test fun refusesATokenThatCouldBreakTheFormat() {
        assertThrows(IllegalArgumentException::class.java) { SessionBinding.seal(acme, "a\nb") }
        assertThrows(IllegalArgumentException::class.java) { SessionBinding.seal(acme, "") }
    }
}
