package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

class HubUrlTest {
    @Test fun normalizesWhatPeopleType() {
        assertEquals("https://hub.acme.io", HubUrl.normalize("hub.acme.io"))
        assertEquals("https://hub.acme.io", HubUrl.normalize("  HTTPS://Hub.Acme.io/ "))
        assertEquals("https://hub.acme.io", HubUrl.normalize("wss://hub.acme.io/mobile/ui"))
        assertEquals("https://hub.acme.io", HubUrl.normalize("https://hub.acme.io:443"))
        assertEquals("https://hub.acme.io:8443", HubUrl.normalize("hub.acme.io:8443"))
        assertEquals("https://code.acme.test", HubUrl.normalize("https://code.acme.test/"))
    }

    @Test fun refusesAnythingThatCouldLeakTheToken() {
        listOf(
            "", "   ", "http://hub.acme.io", "ws://hub.acme.io/mobile/ui", "ftp://hub.acme.io",
            "https://user:pw@hub.acme.io", "https://hub.acme.io/other", "https://hub.acme.io/?a=1",
            "https://hub.acme.io/#x", "https://hub acme.io", "https://", "https://hub.acme.io:0", "https://hub.acme.io:70000",
            "https://hub_acme.io", "javascript:alert(1)",
        ).forEach { assertNull(it, HubUrl.normalize(it)) }
    }

    @Test fun derivesEveryEndpointFromTheBase() {
        val base = "https://hub.acme.io:8443"
        assertEquals("https://hub.acme.io:8443/mobile/ui", HubUrl.ui(base))
        assertEquals("https://hub.acme.io:8443/health", HubUrl.health(base))
        assertEquals("https://hub.acme.io:8443/api/auth/google/start", HubUrl.googleStart(base))
        assertEquals("https://hub.acme.io:8443/api/auth/android/exchange", HubUrl.exchange(base))
        assertEquals("https://hub.acme.io:8443/api/auth/review-login", HubUrl.reviewLogin(base))
        assertEquals("https://hub.acme.io:8443/api/auth/telegram/start", HubUrl.telegram(base, "start"))
        assertEquals("https://hub.acme.io:8443/api/logout", HubUrl.logout(base))
        assertEquals("https://hub.acme.io:8443/privacy/", HubUrl.privacy(base))
        assertEquals("https://hub.acme.io:8443/delete-account/", HubUrl.deleteAccount(base))
        assertEquals("https://hub.acme.io:8443/install", HubUrl.install(base))
        assertEquals("hub.acme.io:8443", HubUrl.label(base))
        assertEquals("https://code.acme.test/mobile/ui", HubUrl.ui(HubUrl.DEFAULT))
        assertTrue(HubUrl.isDefault(HubUrl.DEFAULT)); assertFalse(HubUrl.isDefault(base))
    }

    @Test fun healthMustBeOkTrue() {
        assertTrue(HubUrl.isHealthy("""{"ok":true}"""))
        listOf("""{"ok":false}""", """{"ok":"yes"}""", "ok", "", "[]", "<html>").forEach { assertFalse(it, HubUrl.isHealthy(it)) }
    }

    @Test fun reportLinksFollowTheChosenHub() {
        val id = "a".repeat(32)
        val hub = "https://hub.acme.io"
        assertEquals(id, ReportLink.parse("https://hub.acme.io/w/reports/$id", hub)?.id)
        assertEquals("https://hub.acme.io/w/reports/$id", ReportLink.parse("https://hub.acme.io/w/reports/$id", hub)?.webUrl(hub))
        assertNull(ReportLink.parse("https://code.acme.test/w/reports/$id", hub))
        assertNull(ReportLink.parse("https://claude.acme.test/w/reports/$id", hub))
        assertNull(ReportLink.parse("https://hub.acme.io:444/w/reports/$id", hub))
        assertEquals(id, ReportLink.parse("https://hub.acme.io:8443/w/reports/$id", "https://hub.acme.io:8443")?.id)
        assertEquals(id, ReportLink.parse("https://claude.acme.test/w/reports/$id")?.id)
        assertEquals("https://code.acme.test/w/reports/$id", ReportLink.parse("https://code.acme.test/w/reports/$id")?.webUrl())
    }
}
