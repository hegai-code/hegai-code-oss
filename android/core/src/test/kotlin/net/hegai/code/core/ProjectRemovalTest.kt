package net.hegai.code.core

import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

class ProjectRemovalTest {
    private fun rows(s: String) = Json.parseToJsonElement(s).jsonArray.map { it.jsonObject }

    @Test fun onlyRootOriginIsRemovable() {
        val r = removableProjectCwds(rows("""[{"cwd":"/w/a","origin":"root"},{"cwd":"/w/b","origin":"adopted"},{"cwd":"/w/c"},{"cwd":"","origin":"root"}]"""))
        assertEquals(setOf("/w/a"), r)
    }

    @Test fun removableMatchesLikeTheMachineSpellsPaths() {
        val set = setOf("C:\\Work\\App")
        assertTrue(isRemovableProject(set, "c:/work/app/", true))
        assertFalse(isRemovableProject(set, "c:/work/app/", false))
        assertFalse(isRemovableProject(null, "/w/a", false))
        assertFalse(isRemovableProject(emptySet(), "/w/a", false))
    }

    @Test fun insideIsRootOrDescendantOnly() {
        assertTrue(cwdInside("/w/a", "/w/a/", false))
        assertTrue(cwdInside("/w/a/sub", "/w/a", false))
        assertFalse(cwdInside("/w/a-2", "/w/a", false))
        assertFalse(cwdInside("/W/a", "/w/a", false))
        assertFalse(cwdInside(null, "/w/a", false))
        assertFalse(cwdInside("/w/a", "", false))
    }

    @Test fun insideOnWindowsIgnoresCaseSeparatorsAndTrailingSpace() {
        assertTrue(cwdInside("C:\\Work\\App\\src", " c:\\work\\app\\ ", true))
        assertTrue(cwdInside("c:/work/app", "C:\\Work\\App", true))
        assertFalse(cwdInside("C:\\Work\\App2", "c:\\work\\app", true))
    }

    @Test fun heldMeansLivePidOrRunNotTheDisplayFlag() {
        val busy = Session(sessionId = "s1", title = "t", active = true)
        val state = HubState()
        assertFalse(state.sessionHeld("m", busy))
        assertTrue(state.sessionHeld("m", busy.copy(livePid = 42)))
        val withRun = state.copy(runs = listOf(Run(runId = "r", machineId = "m", sessionId = "s1", state = "idle")))
        assertTrue(withRun.sessionHeld("m", busy))
        assertFalse(withRun.sessionHeld("other", busy))
    }
}
