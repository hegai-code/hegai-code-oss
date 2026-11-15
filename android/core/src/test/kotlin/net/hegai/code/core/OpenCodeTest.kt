package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

class OpenCodeTest {
    private fun row(id: String) = ModelChoice(id, resolved = id)
    private val rows = listOf(row("default"), row("gpt-5.6-sol"), row("pool-go/kimi-k3"), row("pool-go/glm-5.3"))

    @Test fun startModelKeepsAListedRememberedGoPick() =
        assertEquals("pool-go/kimi-k3", OpenCode.startModel("pool-go/kimi-k3", rows))

    @Test fun startModelNeverFallsBackToNoModelOrANativeOne() {
        assertEquals("pool-go/glm-5.3", OpenCode.startModel(null, rows))
        assertEquals("pool-go/glm-5.3", OpenCode.startModel("gpt-5.6-sol", rows))
        assertEquals("pool-go/glm-5.3", OpenCode.startModel("pool-go/gone", rows))
        assertEquals("pool-go/kimi-k3", OpenCode.startModel(null, listOf(row("gpt-5.6-sol"), row("pool-go/kimi-k3"))))
        assertEquals("pool-go/glm-5.3", OpenCode.startModel(null, emptyList()))
    }

    @Test fun rowsAreSplitByTheGoPrefixAndDropTheAccountDefault() {
        assertEquals(listOf("pool-go/kimi-k3", "pool-go/glm-5.3"), OpenCode.rowsFor(rows, true).map { it.id })
        assertEquals(listOf("gpt-5.6-sol"), OpenCode.rowsFor(rows, false).map { it.id })
        assertTrue(OpenCode.available(rows)); assertFalse(OpenCode.available(rows.take(2)))
    }

    @Test fun aLiveOrResumedChatFollowsItsModelNotTheTarget() {
        val live = Target("m", "/p", "s1", source = "codex")
        assertTrue(OpenCode.isOpenCodeChat(live, "pool-go/glm-5.3", null))
        assertTrue(OpenCode.isOpenCodeChat(live, null, "pool-go/glm-5.3"))
        assertFalse(OpenCode.isOpenCodeChat(live, "gpt-5.6-sol", "pool-go/glm-5.3"))
        assertFalse(OpenCode.isOpenCodeChat(live, null, null))
        assertFalse(OpenCode.isOpenCodeChat(Target("m", "/p", "s1", source = "claude"), "pool-go/x", null))
    }

    @Test fun aNewTargetFollowsTheAgentMarker() {
        assertTrue(OpenCode.isOpenCodeChat(Target("m", "/p", source = "codex", agent = OpenCode.AGENT), null, null))
        assertFalse(OpenCode.isOpenCodeChat(Target("m", "/p", source = "codex"), null, "pool-go/glm-5.3"))
        assertFalse(Target("m", "/p", source = "claude", agent = OpenCode.AGENT).isOpenCode)
    }

    @Test fun oldSavedTargetsStayReadableAndKeepTheirKey() {
        val old = wireJson.decodeFromString<Target>("""{"machineId":"m","cwd":"/p","source":"codex"}""")
        assertNull(old.agent)
        assertEquals("m:new:/p:codex", old.key)
        assertNotEquals(old.key, old.copy(agent = OpenCode.AGENT).key)
        val saved = wireJson.encodeToString(Target.serializer(), old.copy(agent = OpenCode.AGENT))
        assertEquals(OpenCode.AGENT, wireJson.decodeFromString<Target>(saved).agent)
    }
}
