import { ApiError, apiJson } from './api.js';
import { forgetTelegramSignIn } from './telegramLogin.js';
import { LAST_ROUTE_KEY, RESTORE_PAUSED } from './router.js';
import { storageRemove } from './storage.js';
import { AgentReleaseStatus, UsageReport } from '@cc-remote/shared';
import type { AccessRow, AuditEvent, BoardCardPatch, DeviceSummary, MemberSummary, PreauthorizedEmail, ProjectShare, ProvisionJob, SupportGrant, SupportGrantCreated, SupportGrantLog, ViewerContext, WorkspaceRole, WorkspaceSummary } from '@cc-remote/shared';

export { ApiError };

/** One sign-in: `id` is the token's hash — it names the session, it cannot open it. */
export type SignInSession = {
  id: string;
  label?: string | null;
  createdAt: number;
  lastSeen?: number | null;
  expiresAt: number;
  current?: boolean;
};

/** The registration form a newcomer fills in while they wait. Optional answers
 *  are left out when empty. */
export type RegistrationForm = { role: string; purpose: string; company?: string; telegram?: string; source?: string };
/** Repository access still owed back for a deleted account (a tombstone the hub is working off). */
export type GithubRevocation = { githubId: string; login?: string; repo: string; attempts: number; error?: string };
export type AccessState = 'waitlist' | 'active' | 'suspended';
export type AccessCounts = { waitlist: number; active: number; suspended: number };
export type ActivateResult = {
  // `email` absent for an account without an address (Telegram-only).
  activated: Array<{ userId: string; email?: string }>;
  skipped: Array<{ email?: string; userId?: string; reason: string }>;
};
/** One answer to `grant`: the account existed and is open now (`activated`),
 *  nobody has signed in with that address so the promise waits (`pending`), or
 *  it was refused (`skipped` + a reason the page translates). */
export type GrantResult = {
  status: 'activated' | 'pending' | 'skipped';
  email: string;
  userId?: string;
  reason?: string;
  pending?: PreauthorizedEmail;
};

export type LocalSetupLink = { userId: string; email: string; setupUrl: string; expiresAt: number };

export const teamApi = {
  /** «Расходы» of a team (owner: everyone, manager: assigned, member: self). */
  usage: (workspaceId: string, from: string, to: string) =>
    apiJson<unknown>(`/api/workspaces/${workspaceId}/usage?from=${from}&to=${to}`).then((r) => UsageReport.parse(r)),
  /** The signed-in person's own «Расходы». */
  myUsage: (from: string, to: string) => apiJson<unknown>(`/api/me/usage?from=${from}&to=${to}`).then((r) => UsageReport.parse(r)),
  me: () => apiJson<ViewerContext>('/api/me'),
  /** The task board. `qs` starts with `?` or is empty; the caller parses the
   *  answer with `BoardResponse` — a scan-derived payload is exactly where a
   *  shape drift would surface, and the wire rule is that zod catches it. */
  board: (qs: string) => apiJson<unknown>(`/api/board${qs}`),
  patchBoardCard: (cardId: string, patch: BoardCardPatch) =>
    apiJson<unknown>(`/api/board/cards/${encodeURIComponent(cardId)}`, { method: 'POST', body: JSON.stringify(patch) }),
  // Signing out ends whatever «Вы вошли через Telegram» was waiting to say:
  // it must never reappear over the NEXT sign-in in this tab.
  logout: () =>
    apiJson<void>('/api/logout', { method: 'POST', body: '{}' }).then(() => {
      forgetTelegramSignIn();
      // Before the reload every caller does next: the shell's next start must
      // not reopen this person's last screen (`RESTORE_FLAG`, router.ts).
      storageRemove(LAST_ROUTE_KEY);
      try {
        sessionStorage.setItem(RESTORE_PAUSED, '1');
      } catch {
        /* no storage */
      }
    }),
  /** Where this person is signed in («Где я вошёл»). */
  sessions: () => apiJson<{ sessions: SignInSession[] }>('/api/auth/sessions'),
  revokeSession: (id: string) => apiJson<{ revoked: boolean }>('/api/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ id }) }),
  revokeOtherSessions: () => apiJson<{ revoked: number }>('/api/auth/sessions/revoke-others', { method: 'POST', body: '{}' }),
  /** Delete the caller's own account on the hub — every session token dies
   *  with it. 409 carries the hub's reason (owner of a team with members). */
  deleteAccount: () =>
    apiJson<{ deleted: boolean }>('/api/account/delete', { method: 'POST', body: JSON.stringify({ confirm: 'DELETE' }) }).then(() => forgetTelegramSignIn()),
  /** Platform-admin form: creates an organization for someone else. */
  createWorkspace: (name: string, ownerUserId?: string) =>
    apiJson<WorkspaceSummary>('/api/admin/workspaces', { method: 'POST', body: JSON.stringify({ name, ownerUserId }) }),
  /** Self-serve: the caller becomes the owner of a new team. */
  createTeam: (name: string) =>
    apiJson<WorkspaceSummary>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
  transferOwnership: (workspaceId: string, newOwnerUserId: string) =>
    apiJson<void>(`/api/workspaces/${workspaceId}/transfer`, { method: 'POST', body: JSON.stringify({ newOwnerUserId }) }),
  removeMember: (workspaceId: string, userId: string) =>
    apiJson<void>(`/api/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE', body: '{}' }),
  /** Leaving is removing yourself — the hub's member-removal route accepts the
   *  caller's own id (an owner has to transfer first; the hub refuses otherwise). */
  leaveTeam: (workspaceId: string, selfUserId: string) =>
    apiJson<void>(`/api/workspaces/${workspaceId}/members/${selfUserId}`, { method: 'DELETE', body: '{}' }),
  /** `confirm` is the team's name, typed — required once the team has members. */
  deleteTeam: (workspaceId: string, confirm?: string) =>
    apiJson<void>(`/api/workspaces/${workspaceId}`, { method: 'DELETE', body: JSON.stringify(confirm ? { confirm } : {}) }),
  members: (workspaceId: string) => apiJson<{ members: MemberSummary[] }>(`/api/workspaces/${workspaceId}/members`),
  invite: (workspaceId: string, email: string, role: Exclude<WorkspaceRole, 'owner'>) =>
    apiJson<{ invitationId: string; token: string; expiresAt: number; setupUrl?: string }>(`/api/workspaces/${workspaceId}/invitations`, { method: 'POST', body: JSON.stringify({ email, role }) }),
  /** Before sign-in: who invites to which team (the token is the credential). */
  invitePreview: (token: string) => apiJson<{ workspaceName: string; inviterName: string; email: string }>('/api/invitations/preview', { method: 'POST', body: JSON.stringify({ token }) }),
  acceptInvitation: (token: string) => apiJson<{ workspaceId: string }>('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }),
  setRole: (workspaceId: string, userId: string, role: Exclude<WorkspaceRole, 'owner'>) =>
    apiJson<void>(`/api/workspaces/${workspaceId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  assign: (workspaceId: string, managerUserId: string, targetKind: 'member' | 'project', targetId: string) =>
    apiJson<void>(`/api/workspaces/${workspaceId}/assignments`, { method: 'POST', body: JSON.stringify({ managerUserId, targetKind, targetId }) }),
  projects: (workspaceId: string) => apiJson<{ projects: ProjectShare[] }>(`/api/workspaces/${workspaceId}/projects`),
  shareProject: (workspaceId: string, machineId: string, root: string, name: string, access: 'view' | 'control' = 'view', visibility?: 'team' | 'everyone') =>
    apiJson<ProjectShare>(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', body: JSON.stringify({ machineId, root, name, access, ...(visibility ? { visibility } : {}) }) }),
  removeProject: (workspaceId: string, shareId: string) =>
    apiJson<void>(`/api/workspaces/${workspaceId}/projects/${shareId}`, { method: 'DELETE', body: '{}' }),
  audit: (workspaceId: string) => apiJson<{ events: AuditEvent[] }>(`/api/workspaces/${workspaceId}/audit`),

  // ---- support access on request (owner only) -------------------------------
  supportGrants: (workspaceId: string) => apiJson<{ grants: SupportGrant[] }>(`/api/workspaces/${workspaceId}/support-grants`),
  /** The link is in this answer and nowhere else. */
  openSupport: (workspaceId: string, hours: number, role: SupportGrant['role'], note?: string) =>
    apiJson<SupportGrantCreated>(`/api/workspaces/${workspaceId}/support-grants`, { method: 'POST', body: JSON.stringify(note ? { hours, role, note } : { hours, role }) }),
  closeSupport: (workspaceId: string, grantId: string) =>
    apiJson<{ grant: SupportGrant }>(`/api/workspaces/${workspaceId}/support-grants/${grantId}/revoke`, { method: 'POST', body: '{}' }),
  /** `before` (a `createdAt`, inclusive) pages back past the newest 1000. */
  supportLog: (workspaceId: string, grantId: string, before?: number) =>
    apiJson<SupportGrantLog>(`/api/workspaces/${workspaceId}/support-grants/${grantId}/log${before === undefined ? '' : `?before=${before}`}`),
  enrollment:() => apiJson<{ code: string; expiresAt: number }>('/api/enrollments', { method: 'POST', body: '{}' }),
  devices: () => apiJson<{ devices: Array<DeviceSummary & { revoked?: boolean; agentVersion?: string }> }>('/api/devices'),
  revokeDevice: (machineId: string) => apiJson<void>(`/api/devices/${machineId}`, { method: 'DELETE', body: '{}' }),
  restoreDevice: (machineId: string) => apiJson<void>(`/api/devices/${machineId}/restore`, { method: 'POST', body: '{}' }),

  // ---- community access (waitlist → active → suspended) ----------------------
  /** The waiting person's «Что хочешь собрать?» note. */
  requestAccess: (note?: string) =>
    apiJson<void>('/api/access/request', { method: 'POST', body: JSON.stringify(note ? { note } : {}) }),
  /** The newcomer's registration form (`POST /api/access/registration`); answers `viewer.access`. */
  submitRegistration: (form: RegistrationForm) =>
    apiJson<unknown>('/api/access/registration', { method: 'POST', body: JSON.stringify(form) }),
  /** Start the repository invitation over (an active member with a GitHub sign-in). */
  retryGithubGrant: (userId: string) =>
    apiJson<unknown>(`/api/admin/access/${encodeURIComponent(userId)}/retry-github-grant`, { method: 'POST', body: '{}' }),
  adminAccess: (state: AccessState, limit = 100, offset = 0) =>
    apiJson<{ users: AccessRow[]; counts: AccessCounts; pending?: PreauthorizedEmail[]; githubRevocations?: GithubRevocation[] }>(`/api/admin/access?state=${state}&limit=${limit}&offset=${offset}`),
  /** External edition, local login: a person outside any team invite. The
   *  answer carries the one-time setup link — the hub sends no email. */
  createLocalUser: (email: string, fullName?: string) =>
    apiJson<LocalSetupLink>('/api/admin/local-users', { method: 'POST', body: JSON.stringify(fullName ? { email, fullName } : { email }) }),
  /** Drops password + authenticator, ends their sessions, returns a fresh link. */
  resetLocalUser: (userId: string) =>
    apiJson<LocalSetupLink>(`/api/admin/local-users/${encodeURIComponent(userId)}/reset`, { method: 'POST', body: '{}' }),
  /** Row buttons. Opening the product for an ADDRESS is `grant`. */
  activate: (userIds: string[]) =>
    apiJson<ActivateResult>('/api/admin/access/activate', { method: 'POST', body: JSON.stringify({ userIds }) }),
  /** One address, whether or not anyone has ever signed in with it. */
  grant: (email: string, note?: string) =>
    apiJson<GrantResult>('/api/admin/access/grant', { method: 'POST', body: JSON.stringify(note ? { email, note } : { email }) }),
  /** Take back a promise nobody has used yet. */
  revokePreauth: (email: string) =>
    apiJson<{ removed: boolean; email: string }>('/api/admin/access/revoke', { method: 'POST', body: JSON.stringify({ email }) }),
  suspend: (userIds: string[], reason?: string) =>
    apiJson<void>('/api/admin/access/suspend', { method: 'POST', body: JSON.stringify(reason ? { userIds, reason } : { userIds }) }),
  reactivate: (userIds: string[]) =>
    apiJson<void>('/api/admin/access/reactivate', { method: 'POST', body: JSON.stringify({ userIds }) }),
  // ---- external edition: which agent build the hub hands out ------------------
  /** 404 on the internal hub — the page hides the section then. */
  agentRelease: async () => AgentReleaseStatus.parse(await apiJson<unknown>('/api/admin/agent-release')),
  approveAgentRelease: async (sha: string, code: string) =>
    AgentReleaseStatus.parse(await apiJson<unknown>('/api/admin/agent-release/approve', { method: 'POST', body: JSON.stringify({ sha, code }) })),
  rollbackAgentRelease: async (code: string) =>
    AgentReleaseStatus.parse(await apiJson<unknown>('/api/admin/agent-release/rollback', { method: 'POST', body: JSON.stringify({ code }) })),
  /** Self-service authenticator for the signed-in admin (external edition). */
  totpBegin: () => apiJson<{ secret: string; otpauthUri: string; qrSvg?: string }>('/api/auth/totp/begin', { method: 'POST', body: '{}' }),
  totpConfirm: (code: string) =>
    apiJson<{ recoveryCodes: string[] }>('/api/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  /** 404 until the provisioning queue ships — callers hide the section then. */
  failedJobs: () => apiJson<{ jobs: ProvisionJob[] }>('/api/admin/provisioning/jobs?status=failed'),
  retryJob: (jobId: string) =>
    apiJson<void>(`/api/admin/provisioning/jobs/${jobId}/retry`, { method: 'POST', body: '{}' }),
};
