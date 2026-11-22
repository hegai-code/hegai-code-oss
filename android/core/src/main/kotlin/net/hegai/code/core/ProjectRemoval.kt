package net.hegai.code.core

import kotlinx.serialization.json.JsonObject

/** Folder key for comparing paths: separators unified, trailing ones dropped, case folded on win32. */
fun cwdKey(path: String, win32: Boolean): String {
    val p = path.trim().replace('\\', '/').trimEnd('/')
    return if (win32) p.lowercase() else p
}

/** True when [path] is [root] or lies under it (web/agent `within`; on win32 case and separators do not matter). */
fun cwdInside(path: String?, root: String, win32: Boolean): Boolean {
    if (path == null) return false
    val r = cwdKey(root, win32)
    if (r.isEmpty()) return false
    val p = cwdKey(path, win32)
    return p == r || p.startsWith("$r/")
}

/**
 * Folders `projects.list` marks `origin: "root"` — the only ones the agent may move to its trash
 * (web StartScreen: «Удалить с машины» is offered for `origin === 'root'` alone).
 */
fun removableProjectCwds(rows: List<JsonObject>): Set<String> =
    rows.filter { it.string("origin") == "root" }.mapNotNull { it.string("cwd")?.takeIf(String::isNotBlank) }.toSet()

/** Is [cwd] removable on [machine]; [removable] is that machine's `removableProjectCwds`. */
fun isRemovableProject(removable: Set<String>?, cwd: String, win32: Boolean): Boolean =
    removable != null && removable.any { cwdKey(it, win32) == cwdKey(cwd, win32) }

/** Web `sessionIsActive`: an editor's `livePid` or a run of ours (NOT `Session.active`, which is display-only). */
fun HubState.sessionHeld(machineId: String, session: Session): Boolean =
    session.livePid != null || runs.any { it.machineId == machineId && it.sessionId == session.sessionId }
