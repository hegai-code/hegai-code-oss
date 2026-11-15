package net.hegai.code.core

/**
 * The workspace a person last picked on this phone, if the hub still lists it for them.
 * Null means "send no workspaceId and accept the hub default" (it already prefers an organization
 * when the account owns no machines). A stale value must be dropped by the caller.
 */
fun savedWorkspace(saved: String?, known: List<Workspace>): String? =
    saved?.takeIf { id -> id.isNotBlank() && known.any { it.workspaceId == id } }

/**
 * The workspaces worth offering. A team already shows the person's own machines in full (hub: an owner has full
 * access in any workspace) plus what the team shares, so with at least one team «Моя работа» is only a duplicate
 * that confuses — it is offered only to someone with no team.
 */
fun selectableWorkspaces(all: List<Workspace>): List<Workspace> = all.filter { it.kind != "personal" }.ifEmpty { all }

/** Preference key: one choice per account on one hub — workspace ids are hub-local, and signing in as someone else
 *  (or into another hub) never inherits it. */
fun workspacePrefKey(hub: String, userId: String): String = "workspace:${hub.trimEnd('/')}|$userId"
