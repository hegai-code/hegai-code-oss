import type { ViewerContext, WorkspaceSummary } from '@cc-remote/shared';
import { storageGet, storageRemove, storageSet } from '../storage.js';

/** Where the last explicitly chosen workspace is remembered. Written when an
 *  invitation is accepted, a team is created, or «Открыть» is pressed in
 *  Settings → «Мои команды»; read first by `pickWorkspace`. */
export const WORKSPACE_KEY = 'cc-workspace';

function storedWorkspaceId(): string | null {
  return storageGet(WORKSPACE_KEY);
}

/** Where the workspace the app last WORKED in is remembered — not a pin (that
 *  is `WORKSPACE_KEY`), just the answer `pickWorkspace` gave last time. The app
 *  opens its hub socket with it at once instead of waiting for `/api/me`: that
 *  wait used to be spent on a socket scoped to the PERSONAL workspace, which
 *  then had to be torn down and re-opened on the organization — two full
 *  snapshots per reload, and «Эта машина недоступна» flashing in between.
 *  When `/api/me` picks something else the app simply switches, as before. */
const LAST_WORKSPACE_KEY = 'cc-last-workspace';

export function lastWorkspaceId(): string {
  return storageGet(LAST_WORKSPACE_KEY) ?? '';
}

export function noteWorkspace(workspaceId: string): void {
  // Private mode: the app still works, it just waits for /api/me.
  if (workspaceId) storageSet(LAST_WORKSPACE_KEY, workspaceId);
  else storageRemove(LAST_WORKSPACE_KEY);
}

/** Pin a workspace so the next `pickWorkspace` lands there. */
export function rememberWorkspace(workspaceId: string): void {
  // Storage may be unavailable (private mode); the fallback order still works.
  storageSet(WORKSPACE_KEY, workspaceId);
}

/**
 * Which workspace the UI works in.
 *
 * There used to be a switcher, and picking a different entry swapped the whole
 * application: `isOrganization` selected between two disjoint nav lists, so
 * "Моя работа" and the organization looked like two different products. They
 * are not — they are one person's work, and which row in the `workspaces` table
 * backs it is a detail of access control, not a mode the user should operate.
 *
 * So the UI prefers the organization and stops branching on `kind`. Nothing is
 * lost by defaulting there: in an organization workspace the hub already grants
 * a device's owner full access to their own machines
 * (server-rs/src/workspace.rs:955) — `roots: None`, view, control and start —
 * so a person's own machines are visible either way, with no data migration.
 *
 * One override sits in front of that order: a workspace the person chose
 * explicitly (accepted an invitation into it, created it, or opened it from
 * «Мои команды»). Without it the owner of their own empty team would never see
 * the team that invited them — "org I own" always won. The override only
 * counts while it names a workspace the viewer still belongs to, so leaving a
 * team falls back to the default order rather than pinning a ghost.
 *
 * This mirrors the server's own idiom at workspace_api.rs:459
 * (`pick("organization").or_else(|| pick("personal"))`). The server-side
 * ordering in workspace.rs:365 is deliberately left personal-first: it is also
 * the fallback for `ui_access`, and flipping it would silently change /api/me
 * for iOS and every other consumer. Preferring the org is a product decision
 * and belongs here.
 */
export function pickWorkspace(viewer: ViewerContext): WorkspaceSummary {
  const list = viewer.workspaces ?? [];
  const stored = storedWorkspaceId();
  return (
    (stored ? list.find((w) => w.workspaceId === stored) : undefined) ??
    list.find((w) => w.kind === 'organization' && w.role === 'owner') ??
    list.find((w) => w.kind === 'organization') ??
    viewer.workspace
  );
}

/**
 * Whether inviting people can actually work here.
 *
 * The hub gates `invite()` on `require_role(actor, ws, ["owner"])`
 * (server-rs/src/workspace.rs:462) and every user owns their own personal
 * workspace — so an invite into a personal workspace is accepted, the invitee
 * accepts it, and then `machine_access` hands them `can_view: false` on
 * everything. A silent no-op. Computing this once here keeps the check out of
 * the components, which must not branch on `kind` themselves.
 */
export function canInviteTo(workspace: WorkspaceSummary): boolean {
  return workspace.kind === 'organization' && workspace.role === 'owner';
}

/** Support access is granted per organisation (the hub refuses it on a
 *  personal space), and only by its owner. */
export function canGrantSupport(workspace: WorkspaceSummary): boolean {
  return workspace.role === 'owner' && workspace.kind === 'organization';
}

/**
 * Whether the viewer is past the community gate. Hubs that predate the rollout
 * send no `access` at all, and every one of their users is an employee — so
 * absence means active, never "unknown".
 */
export function isAccessActive(viewer: ViewerContext | null | undefined): boolean {
  return !viewer?.access || viewer.access.state === 'active';
}

/**
 * Whether «Создать команду» should be offered. The hub caps the number of
 * teams one person owns (`CC_REMOTE_ORG_CAP_PER_USER`) and answers with an
 * error past it; the form stays visible and shows that error rather than
 * guessing the cap here.
 */
export function canCreateOrg(viewer: ViewerContext | null | undefined): boolean {
  return !!viewer && isAccessActive(viewer);
}

/**
 * The teams a viewer belongs to — every workspace that is not their personal
 * one. Kept here for the same reason as `canInviteTo`: the components list and
 * switch between teams without knowing what a `kind` is.
 */
export function teamsOf(viewer: ViewerContext | null | undefined): WorkspaceSummary[] {
  return (viewer?.workspaces ?? []).filter((w) => w.kind === 'organization');
}

/**
 * May this viewer switch the session lists between «Мои · Команда · Все»
 * (`ScopeSwitch`)?
 *
 * The switch is for the people who run a team: the owner or a manager of the
 * organization the socket is scoped to, or a platform admin. A member keeps
 * «Мои» as the rule (see `MineOnly.tsx` for why it once became one) and finds
 * colleagues under «Команда». Role only — whether there is anybody else's work
 * to look at is `hasOthersWork` in lib.ts, kept apart because the snapshot
 * empties for a moment on every reconnect and that must not throw the viewer
 * back to «Мои» mid-look.
 */
export function canSwitchScope(
  viewer: Pick<ViewerContext, 'platformAdmin' | 'workspace'> | null | undefined,
): boolean {
  if (!viewer) return false;
  if (viewer.platformAdmin) return true;
  const w = viewer.workspace;
  return !!w && w.kind === 'organization' && (w.role === 'owner' || w.role === 'manager');
}
