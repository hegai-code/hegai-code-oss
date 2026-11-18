package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

class HubLinkTest {
    @Test fun connectLink() {
        assertEquals("https://code.acme.com", HubLink.parse("ccremote://connect?hub=https%3A%2F%2Fcode.acme.com"))
        assertEquals("https://code.acme.com:8443", HubLink.parse("ccremote://connect?x=1&hub=https%3A%2F%2Fcode.acme.com%3A8443"))
        assertEquals("https://code.acme.com", HubLink.parse(HubLink.connectUrl("https://code.acme.com")))
    }
    @Test fun appUrl() {
        assertEquals("https://code.acme.com", HubLink.parse("https://code.acme.com/app"))
        assertEquals("https://code.acme.com:8443", HubLink.parse("https://code.acme.com:8443/app/"))
    }
    @Test fun bareAndLegacy() {
        assertEquals("https://code.acme.com", HubLink.parse("code.acme.com"))
        assertEquals("https://code.acme.com", HubLink.parse("https://code.acme.com"))
        assertEquals("https://code.acme.com", HubLink.parse("wss://code.acme.com/mobile/ui"))
    }
    @Test fun rejects() {
        listOf(
            "", "garbage words", "http://code.acme.com/app", "ccremote://connect?hub=http%3A%2F%2Fcode.acme.com",
            "ccremote://connect", "ccremote://auth?hub=https%3A%2F%2Fcode.acme.com", "ftp://code.acme.com",
            "javascript:alert(1)", "https://code.acme.com/other", "https://u:p@code.acme.com/app",
        ).forEach { assertNull(it, HubLink.parse(it)) }
    }
}
