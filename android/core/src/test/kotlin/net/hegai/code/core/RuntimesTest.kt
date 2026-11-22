package net.hegai.code.core

import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

class RuntimesTest {
    private fun rt(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test fun unknownIsUsable() {
        assertTrue(Runtimes.usable(null, "claude"))
        assertTrue(Runtimes.usable(rt("""{"codex":{"present":true,"auth":"chatgpt"}}"""), "claude"))
        assertEquals("claude", Runtimes.pick(null, "claude"))
    }

    @Test fun missingClaudeFallsBackToCodex() {
        val r = rt("""{"claude":{"present":false,"auth":"none","error":"not_found"},"codex":{"present":true,"auth":"chatgpt","provider":"own"}}""")
        assertFalse(Runtimes.usable(r, "claude"))
        assertEquals("codex", Runtimes.pick(r, "claude"))
        assertNotNull(Runtimes.problem(r, "claude"))
        assertNull(Runtimes.problem(r, "codex"))
    }

    @Test fun loggedOutClaudeFallsBack() {
        val r = rt("""{"claude":{"present":true,"auth":"oauth","error":"logged_out"},"codex":{"present":true,"auth":"apikey"}}""")
        assertEquals("codex", Runtimes.pick(r, "claude"))
    }

    @Test fun neitherUsableKeepsPreference() {
        val r = rt("""{"claude":{"present":true,"auth":"none"},"codex":{"present":false,"auth":"none"}}""")
        assertEquals("claude", Runtimes.pick(r, "claude"))
    }

    @Test fun gatewayCodexNeedsNoLoginAndTokenExpiringStaysUsable() {
        assertTrue(Runtimes.usable(rt("""{"codex":{"present":true,"auth":"none","provider":"gateway"}}"""), "codex"))
        assertTrue(Runtimes.usable(rt("""{"claude":{"present":true,"auth":"token","error":"token_expiring"}}"""), "claude"))
    }

    @Test fun disabledClaude() {
        val r = rt("""{"claude":{"present":true,"auth":"oauth","error":"disabled"},"codex":{"present":true,"auth":"chatgpt"}}""")
        assertTrue(Runtimes.claudeOff(r))
        assertEquals("codex", Runtimes.pick(r, "claude"))
    }
}
