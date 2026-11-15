package net.hegai.code.core

import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.assertEquals

class SharedProjectsTest {
    private fun row(access: String, machine: String, root: String, name: String? = null) = buildJsonObject {
        put("access", access); put("machineId", machine); put("root", root); if (name != null) put("name", name)
    }

    @Test fun keepsControlSharesOnly() {
        val parsed = parseSharedProjects(listOf(row("control", "m1", "/home/x/art", "ArtRussia"), row("view", "m1", "/home/x/other")))
        assertEquals(listOf(SharedProject("m1", "/home/x/art", "ArtRussia")), parsed)
    }

    @Test fun nameFallsBackToFolderAndDuplicatesCollapse() {
        val parsed = parseSharedProjects(listOf(row("control", "m1", "/a/b/site"), row("control", "m1", "/a/b/site", "Dup"), row("control", "", "/x")))
        assertEquals(listOf(SharedProject("m1", "/a/b/site", "site")), parsed)
    }

    @Test fun mergeDedupesAcrossSources() {
        assertEquals(listOf("/a", "/b", "/c"), mergeProjectPaths(listOf("/a", ""), listOf("/b", "/a"), listOf("/c")))
        assertEquals(listOf("C:\\A"), mergeProjectPaths(listOf("C:\\A"), listOf("c:\\a"), ignoreCase = true))
    }
}
