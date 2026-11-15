package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

class WorkspaceChoiceTest {
    private val known = listOf(Workspace("p", "Моя работа"), Workspace("t", "Hegai Team", kind = "organization"))

    @Test fun keepsSavedChoiceThatIsStillListed() = assertEquals("t", savedWorkspace("t", known))
    @Test fun dropsChoiceTheHubNoLongerLists() = assertNull(savedWorkspace("gone", known))
    @Test fun noSavedChoiceMeansHubDefault() { assertNull(savedWorkspace(null, known)); assertNull(savedWorkspace("", known)) }
    @Test fun emptyListDropsEverything() = assertNull(savedWorkspace("t", emptyList()))
    @Test fun personalIsHiddenOnceThereIsATeam() = assertEquals(listOf("t"), selectableWorkspaces(known).map { it.workspaceId })
    @Test fun personalStaysWithoutATeam() = assertEquals(listOf("p"), selectableWorkspaces(known.take(1)).map { it.workspaceId })
    @Test fun aSavedPersonalPickIsDroppedOnceThereIsATeam() = assertNull(savedWorkspace("p", selectableWorkspaces(known)))
    @Test fun keysAreSeparatePerAccount() = assertNotEquals(workspacePrefKey("https://code.acme.test", "a"), workspacePrefKey("https://code.acme.test", "b"))
    @Test fun keysAreSeparatePerHub() = assertNotEquals(workspacePrefKey("https://code.acme.test", "a"), workspacePrefKey("https://other.example", "a"))
}
