package net.hegai.code.core

import kotlinx.serialization.json.JsonObject

/** A project another person shared into the organization workspace with `control` access. */
data class SharedProject(val machineId: String, val root: String, val name: String)

/** `GET /api/workspaces/<id>/projects` rows → start targets (web: App.tsx keeps access === "control"). */
fun parseSharedProjects(rows: List<JsonObject>): List<SharedProject> = rows.mapNotNull { row ->
    if (row.string("access") != "control") return@mapNotNull null
    val machineId = row.string("machineId")?.takeIf(String::isNotBlank) ?: return@mapNotNull null
    val root = row.string("root")?.takeIf(String::isNotBlank) ?: return@mapNotNull null
    SharedProject(machineId, root, row.string("name")?.takeIf(String::isNotBlank) ?: Target(machineId, root).project)
}.distinctBy { it.machineId to it.root }

/** Project folders of one machine from several sources (session cwds, catalog, shares), blank dropped, first spelling wins. */
fun mergeProjectPaths(vararg sources: List<String>, ignoreCase: Boolean = false): List<String> {
    val seen = HashSet<String>()
    return sources.flatMap { it }.filter { it.isNotBlank() && seen.add(if (ignoreCase) it.lowercase() else it) }
}
