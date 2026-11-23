import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { sessionCategory, type AuditEvent, type MemberSummary, type ProjectInfo, type ProjectShare, type ViewerContext } from '@cc-remote/shared';
import type { CentralState } from './useCentral.js';
import { Briefcase, DownloadIcon, Eye, MonitorIcon, PhoneIcon, Plus, Trash2 } from './icons.js';
import { APP_INSTALL_COMMAND, attentionLabel, displayName, guessDesktopOs, pluralRu, relTimeRu, sessionAuthor, type DesktopOs } from './lib.js';
import { CopyButton } from './components/CopyButton.js';
import { parseInviteTarget } from './inviteTarget.js';
import { teamApi, type SignInSession } from './teamApi.js';
import type { WorkspaceSummary } from '@cc-remote/shared';
import { navigate, pathFor, type SettingsTab, type TeamTab } from './router.js';
import { SETTINGS_TABS, TEAM_TABS } from './shell/navModel.js';
import { useBrowserInfo } from './components/browser/browserApi.js';
import { canCreateOrg, canGrantSupport, rememberWorkspace, teamsOf, WORKSPACE_KEY } from './shell/workspace.js';
import { resetWelcome } from './components/Welcome.js';
import { SignInMethods } from './components/SignInMethods.js';
import { SupportAccess } from './components/SupportAccess.js';
import { TwoFactorCard } from './MfaScreen.js';
import { RepoGrantCard } from './components/RepoGrantCard.js';
import { storageGet, storageRemove } from './storage.js';
import { MyUsageCard, PeriodSwitch, UsageList, useUsage } from './UsageViews.js';
import { canSeeUsageTab, type UsagePeriod } from './usageModel.js';
import { askConfirm, askText, showNotice } from './dialogs.js';
import { isExternal, usePublicConfig } from './publicConfig.js';

/**
 * Props every team screen shares beyond its own data: who is looking (the
 * REST identity, available before the socket says hello) and how to switch
 * the workspace the shell works in. Both are optional so the screens stay
 * renderable in isolation (tests, storybook-style previews).
 */
export interface TeamShellProps {
  viewer?: ViewerContext | null;
  /** Pin `workspaceId` and reconnect the shell to it. */
  onSelectWorkspace?: (workspaceId: string) => void;
  /** Re-read `/api/me` — after a team is created, transferred, left or deleted. */
  onWorkspaceCreated?: () => void;
}

/**
 * The team screens are reports on one organization — same layout, same scope,
 * same data source — so they are tabs of one destination rather than separate
 * places in the navigation. «Доступ» joined them for the same reason and is
 * exported for it: it used to be a rail destination of its own, seen by one
 * person on the whole platform.
 *
 * `admin` unlocks the `adminOnly` tabs. A boolean rather than the viewer,
 * because that is all this component decides; the viewer stays where the data
 * is (`TeamSelect`).
 */
export function Panel({ title, subtitle, tab, admin, usage, head, children }: { title: string; subtitle?: string; tab?: TeamTab; admin?: boolean; usage?: boolean; head?: React.ReactNode; children: React.ReactNode }) {
  return <div className="team-page">
    <div className="team-head"><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}{head}</div>
    {tab && <div className="tabs team-tabs">{TEAM_TABS.filter((t) => (!t.adminOnly || admin) && (!t.usage || usage)).map((t) => (
      <button key={t.id} className={`tab ${t.id === tab ? 'active' : ''}`} onClick={() => navigate({ kind: 'team', tab: t.id })}>{t.label}</button>
    ))}</div>}
    {children}
  </div>;
}

/**
 * The tab strip of Настройки, on the same classes as the team one.
 *
 * It is a separate component rather than another optional prop on `Panel`
 * because the four screens under it do NOT share a layout: «Аккаунт» is a
 * `Panel`, and Железо, Память and Профиль each bring their own `.board-head`
 * and their own toolbars. What they share is the strip, so that is all this is.
 */
export function SettingsTabs({ active }: { active: SettingsTab }) {
  const browser = useBrowserInfo() !== null;
  return <div className="tabs team-tabs settings-tabs">
    {SETTINGS_TABS.filter((t) => !t.browser || browser || t.id === active).map((t) => (
      <button key={t.id} className={`tab ${t.id === active ? 'active' : ''}`} onClick={() => navigate({ kind: 'settings', tab: t.id })}>{t.label}</button>
    ))}
  </div>;
}

/**
 * The team switcher in the panel head. Only drawn when there is a choice: one
 * team is not a menu. `current` is the workspace the SOCKET is on — that is
 * the one every list below is scoped to — so the select never claims a team
 * the data has not switched to yet.
 */
function TeamSelect({ viewer, current, onSelect }: { viewer?: ViewerContext | null; current?: WorkspaceSummary; onSelect?: (id: string) => void }) {
  const teams = teamsOf(viewer);
  if (teams.length < 2 || !onSelect) return null;
  const value = current && teams.some((t) => t.workspaceId === current.workspaceId) ? current.workspaceId : '';
  return <select className="team-select" value={value} aria-label="Команда" onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}>
    {value === '' && <option value="">Выбрать команду…</option>}
    {teams.map((t) => <option value={t.workspaceId} key={t.workspaceId}>{t.name}</option>)}
  </select>;
}

/**
 * «Создать команду». One card, used from Team → Люди (when the person has no
 * team yet) and from Settings. The explanation says what a team IS in this
 * product — people who may run sessions in the folders you open, on your
 * machine — because the word alone suggests a chat room.
 */
function CreateTeamCard({ viewer, onCreated, title = 'Создать команду' }: { viewer?: ViewerContext | null; onCreated?: () => void; title?: string }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!canCreateOrg(viewer)) return null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    teamApi.createTeam(name.trim())
      .then((ws) => { rememberWorkspace(ws.workspaceId); setName(''); onCreated?.(); })
      .catch((error) => setErr((error as Error).message))
      .finally(() => setBusy(false));
  };
  return <section className="team-card settings-section">
    <h3>{title}</h3>
    <p className="team-help">Команда — это вы и те, кого вы позвали. Они смогут запускать сессии в проектах, которые вы сделаете командными, на вашей машине.</p>
    <form className="team-form" onSubmit={submit}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название команды" minLength={2} maxLength={48} required />
      <button className="btn primary" disabled={busy}><Plus size={14} /> Создать</button>
    </form>
    {err && <div className="team-note">{err}</div>}
  </section>;
}

export function TeamOverview({ central, onOpen, viewer, onSelectWorkspace }: { central: CentralState; onOpen: (machineId: string, sessionId: string) => void } & TeamShellProps) {
  const sessions = central.machines.flatMap((m) => m.sessions.map((session) => ({ machine: m, session }))).sort((a, b) => b.session.lastModified - a.session.lastModified);
  // People who have actually done work here, not machines that exist. Counting
  // machine owners under-reports a shared sandbox to exactly one person.
  const people = new Set([
    ...central.machines.map((m) => m.owner?.userId),
    ...sessions.map(({ session }) => session.owner?.userId),
  ].filter(Boolean)).size;
  return <Panel title="Команда" tab="overview" admin={!!viewer?.platformAdmin} usage={canSeeUsageTab(viewer)} subtitle={`${people} ${pluralRu(people, ['человек', 'человека', 'человек'])} · ${central.machines.length} ${pluralRu(central.machines.length, ['машина', 'машины', 'машин'])} · ${sessionCount(sessions.length)}`}
                head={<TeamSelect viewer={viewer} current={central.viewer?.workspace} onSelect={onSelectWorkspace} />}>
    <div className="team-metrics"><article><b>{central.activeRuns.length}</b><span>в работе сейчас</span></article><article><b>{sessions.length}</b><span>общих сессий</span></article><article><b>{central.machines.filter((m) => m.online).length}</b><span>машин на связи</span></article></div>
    <section className="team-card"><h3>Последние общие сессии</h3>{sessions.slice(0, 20).map(({ machine, session }) => <button className="team-row" key={`${machine.machine.machineId}:${session.sessionId}`} onClick={() => onOpen(machine.machine.machineId, session.sessionId)}><span><b>{session.title}</b><small>{sessionAuthor(session, machine)} · {session.project ?? 'без проекта'}</small></span><time>{relTimeRu(session.lastModified)}</time></button>)}</section>
  </Panel>;
}

/**
 * One person's work, for whoever runs the workspace.
 *
 * This is deliberately a *view*, not a way to become them. Everything an
 * employee's session contains is already readable here — the boss owns the
 * machine it ran on — so a read-only lens costs nothing in access and keeps the
 * audit trail meaning what it says. Signing in as someone else would make their
 * name the author of the reader's actions, which is the one thing an audit log
 * must never allow.
 */
const ROLE_LABEL: Record<string, string> = { owner: 'владелец', manager: 'менеджер', member: 'участник' };

/** Russian counts decline by the last digits, and "3 сессий" reads as broken UI. */
function sessionCount(n: number): string {
  if (n === 0) return 'без сессий';
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? 'сессий'
    : ones === 1 ? 'сессия'
    : ones >= 2 && ones <= 4 ? 'сессии'
    : 'сессий';
  return `${n} ${word}`;
}

function MemberWork({ central, member, onOpen }: { central: CentralState; member: MemberSummary; onOpen: (machineId: string, sessionId: string) => void }) {
  const rows = central.machines
    .flatMap((m) => m.sessions.map((session) => ({ machine: m, session })))
    .filter(({ session }) => session.owner?.userId === member.userId)
    .sort((a, b) => b.session.lastModified - a.session.lastModified);
  const runs = central.activeRuns.filter((r) => r.ownerUserId === member.userId);
  const who = displayName(member);

  return <section className="team-card member-work">
    <h3>{who} · {rows.length === 0 ? 'сессий пока нет' : sessionCount(rows.length)}{runs.length > 0 && <> · <b className="live-now">{runs.length} сейчас в работе</b></>}</h3>
    {rows.length === 0
      ? <p className="team-help">
          Ничего не запускалось от этого имени. Сессии, начатые до того, как хаб
          стал записывать авторство, числятся без автора и сюда не попадают.
        </p>
      : rows.map(({ machine, session }) => {
          const cat = sessionCategory(session.category);
          const live = central.activeRuns.find((r) => r.sessionId === session.sessionId);
          return <button className="team-row" key={`${machine.machine.machineId}:${session.sessionId}`}
                         onClick={() => onOpen(machine.machine.machineId, session.sessionId)}>
            <span>
              <b>{session.title || session.sessionId.slice(0, 8)}</b>
              <small>
                {session.project ?? 'проект не определён'} · {machine.machine.name}
                {session.source === 'codex' ? ' · Codex' : ''}
                {cat ? ` · ${cat.label}` : ''}
              </small>
            </span>
            {live && <span className={`role-chip ${live.state === 'needs_attention' ? 'control' : ''}`}>
              {live.state === 'needs_attention' ? attentionLabel(live) : live.state === 'working' ? 'работает' : live.state === 'error' ? 'ошибка' : 'ждёт'}
            </span>}
            <time>{relTimeRu(session.lastModified)}</time>
          </button>;
        })}
  </section>;
}

export function TeamMembers({ central, workspace, canInvite, onOpen, viewer, onSelectWorkspace, onWorkspaceCreated }: { central: CentralState; workspace: WorkspaceSummary; canInvite: boolean; onOpen: (machineId: string, sessionId: string) => void } & TeamShellProps) {
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'manager' | 'member'>('member');
  const [note, setNote] = useState('');
  const [invite, setInvite] = useState<{ email: string; link: string; setup?: boolean; telegram?: boolean } | null>(null);
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  // An answer is applied only while its workspace is still the one on screen:
  // after a switch, the previous team's late response must not overwrite the
  // new team's list.
  const shownWorkspace = useRef(workspace.workspaceId);
  shownWorkspace.current = workspace.workspaceId;
  const refresh = () => {
    const id = workspace.workspaceId;
    return teamApi.members(id)
      .then((r) => { if (shownWorkspace.current === id) setMembers(r.members); })
      .catch((e) => { if (shownWorkspace.current === id) setNote(e.message); });
  };
  useEffect(() => { void refresh(); }, [workspace.workspaceId]);
  const canManage = workspace.role === 'owner' && canInvite;
  // A team someone made for themselves is owner + members; the manager layer
  // (a third role, scopes, per-project assignment) is the employee model and
  // would be three controls with nothing behind them here.
  const selfServe = workspace.selfServe === true;
  const managers = members.filter((m) => m.role === 'manager');
  // Only the workspace owner reads other people's work; for everyone else the
  // row stays a row.
  const canInspect = workspace.role === 'owner';
  const sessionsBy = (userId: string) =>
    central.machines.reduce((n, m) => n + m.sessions.filter((s) => s.owner?.userId === userId).length, 0);
  const noTeamYet = !canInvite && teamsOf(viewer).length === 0;
  const sendInvite = (e: React.FormEvent) => {
    e.preventDefault();
    const invited = email.trim();
    const target = parseInviteTarget(invited);
    if (!target || ('telegram' in target && !tgInvites)) { setNote(tgInvites ? 'Введите e-mail или @username в Telegram' : 'Введите корректный e-mail'); return; }
    teamApi.invite(workspace.workspaceId, target, selfServe ? 'member' : role)
      .then((r) => {
        setEmail(''); setNote('');
        if ('telegram' in target) setInvite({ email: `@${target.telegram}`, link: r.botUrl ?? '', telegram: true });
        else setInvite({ email: invited, link: r.setupUrl ?? `${location.origin}/?invite=${encodeURIComponent(r.token ?? '')}`, setup: !!r.setupUrl });
      })
      .catch((err) => setNote(err.message));
  };
  const removeMember = async (m: MemberSummary) => {
    if (!(await askConfirm(`Убрать ${displayName(m)} из команды?`, { confirmLabel: 'Убрать', danger: true }))) return;
    teamApi.removeMember(workspace.workspaceId, m.userId).then(refresh).catch((err) => setNote(err.message));
  };
  const publicConfig = usePublicConfig();
  const external = isExternal(publicConfig);
  // «@username» works only where Telegram sign-in is on, on a self-hosted hub.
  const tgInvites = external && !!publicConfig?.auth.telegram;
  return <Panel title="Команда" tab="people" admin={!!viewer?.platformAdmin} usage={canSeeUsageTab(viewer)} subtitle={external ? 'Роли действуют только в этой команде.' : 'Роли действуют только в этой команде; роли HegAI сюда не переносятся.'}
                head={<TeamSelect viewer={viewer} current={central.viewer?.workspace} onSelect={onSelectWorkspace} />}>
    {noTeamYet && (canCreateOrg(viewer)
      ? <CreateTeamCard viewer={viewer} onCreated={onWorkspaceCreated} />
      : <div className="team-empty">Команда появится вместе с активацией доступа.</div>)}
    {canManage && <form className="team-form" onSubmit={sendInvite}>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder={tgInvites ? 'colleague@example.com или @username в Telegram' : 'colleague@example.com'} required />
      {!selfServe && <select value={role} onChange={(e) => setRole(e.target.value as 'manager' | 'member')}><option value="member">Участник</option><option value="manager">Менеджер</option></select>}
      <button className="btn primary"><Plus size={14} /> Пригласить</button>
    </form>}
    {invite && <section className="team-card settings-section">
      <h3>Приглашение для {invite.email}</h3>
      {invite.telegram
        ? <>
          <p className="team-help">Отправьте человеку: откройте приложение Hegai Code → «Другой хаб» → {location.host} → «Войти через Telegram».</p>
          {invite.link && <pre className="install-command">{invite.link}</pre>}
          <div className="settings-actions">
            {invite.link && <CopyButton className="btn primary" text={invite.link} label="Скопировать ссылку на бота" />}
            <CopyButton className="btn" text={`Откройте приложение Hegai Code → «Другой хаб» → ${location.host} → «Войти через Telegram»${invite.link ? ` (${invite.link})` : ''}`} label="Скопировать текст" />
            <button className="btn" onClick={() => setInvite(null)}>Готово</button>
          </div>
          <p className="team-help">Письмо не уходит. Человек должен войти через Telegram с именем {invite.email}; приглашение действует 7 дней.</p>
        </>
        : <>
          <pre className="install-command">{invite.link}</pre>
          <div className="settings-actions">
            <CopyButton className="btn primary" text={invite.link} label="Скопировать ссылку" />
            <button className="btn" onClick={() => setInvite(null)}>Готово</button>
          </div>
          <p className="team-help">Отправьте ссылку человеку любым способом — письмо не уходит. Ссылка одноразовая, действует 7 дней.{!invite.setup && ' Если у человека ещё нет входа на этот сервер, его заводит администратор.'}</p>
        </>}
    </section>}
    {(!noTeamYet || members.length > 0) && <section className="team-card">{members.map((m) => {
      const count = sessionsBy(m.userId);
      const open = openUserId === m.userId;
      return <div className="team-row static" key={m.userId}>
        <span className="team-avatar">{displayName(m).slice(0, 2).toUpperCase()}</span>
        <span>
          {canInspect
            ? <button className="link-name" aria-expanded={open}
                      onClick={() => setOpenUserId(open ? null : m.userId)}>{displayName(m)}</button>
            : <b>{displayName(m)}</b>}
          <small>{[m.email ?? `без почты · id ${m.userId.slice(0, 8)}`, canInspect ? sessionCount(count) : null].filter(Boolean).join(' · ')}</small>
        </span>
        {canManage && m.role !== 'owner' && !selfServe
          ? <select value={m.role} onChange={(e) => teamApi.setRole(workspace.workspaceId, m.userId, e.target.value as 'manager' | 'member').then(refresh).catch((e) => setNote(e.message))}><option value="member">Участник</option><option value="manager">Менеджер</option></select>
          : <span className="role-chip">{ROLE_LABEL[m.role] ?? m.role}</span>}
        {canManage && m.role !== 'owner' && <button className="icon-btn" title="Убрать из команды" aria-label="Убрать из команды" onClick={() => removeMember(m)}><Trash2 size={15} /></button>}
      </div>;
    })}</section>}
    {canInspect && openUserId && members.find((m) => m.userId === openUserId) &&
      <MemberWork central={central} member={members.find((m) => m.userId === openUserId)!} onOpen={onOpen} />}
    {canManage && !selfServe && managers.length > 0 && <section className="team-card"><h3>Кто кем руководит</h3><p className="team-help">Назначьте менеджера человеку. Назначения по проектам — во вкладке «Проекты».</p>{managers.map((manager) => <div className="team-form compact" key={manager.userId}><b>{displayName(manager)}</b><select defaultValue="" onChange={(e) => { if (e.target.value) teamApi.assign(workspace.workspaceId, manager.userId, 'member', e.target.value).then(() => setNote('Назначение сохранено')).catch((err) => setNote(err.message)); }}><option value="">Назначить человека…</option>{members.filter((m) => m.role === 'member').map((m) => <option value={m.userId} key={m.userId}>{displayName(m)}</option>)}</select></div>)}</section>}
    {note && <div className="team-note">{note}</div>}
  </Panel>;
}

const SHARE_ROLE = { lead: 'ведёт', member: 'участник', partner: 'партнёр' } as const;

export function TeamProjects({ central, workspace, viewer, onSelectWorkspace }: { central: CentralState; workspace: WorkspaceSummary } & TeamShellProps) {
  const [shares, setShares] = useState<ProjectShare[]>([]);
  const [managers, setManagers] = useState<MemberSummary[]>([]);
  const [recent, setRecent] = useState<Array<ProjectInfo & { machineId: string; machineName: string }>>([]);
  const [machineId, setMachineId] = useState(''); const [root, setRoot] = useState(''); const [name, setName] = useState(''); const [note, setNote] = useState('');
  const [access, setAccess] = useState<'view' | 'control'>('view');
  // Which sessions inside the root a member sees. On a hosted sandbox the
  // owner's own work IS the team's work (one box, one owner), so it defaults to
  // everyone; on a personal machine the owner's other sessions stay private.
  const [visibility, setVisibility] = useState<'team' | 'everyone'>('team');
  const ownMachines = central.machines.filter((m) => m.canControl);
  const selfServe = workspace.selfServe === true;
  // Same rule as TeamMembers: a late answer for a workspace that is no longer
  // on screen is dropped.
  const shownWorkspace = useRef(workspace.workspaceId);
  shownWorkspace.current = workspace.workspaceId;
  const refresh = () => {
    const id = workspace.workspaceId;
    return teamApi.projects(id)
      .then((r) => { if (shownWorkspace.current === id) setShares(r.projects); })
      .catch((e) => { if (shownWorkspace.current === id) setNote(e.message); });
  };
  useEffect(() => { void refresh(); }, [workspace.workspaceId]);
  useEffect(() => {
    if (workspace.role !== 'owner' || selfServe) return;
    let live = true;
    teamApi.members(workspace.workspaceId)
      .then((r) => { if (live) setManagers(r.members.filter((m) => m.role === 'manager')); })
      .catch((e) => { if (live) setNote(e.message); });
    return () => { live = false; };
  }, [workspace.workspaceId, workspace.role, selfServe]);
  // Re-scan when a machine is added, removed or changes its online state — not
  // merely when the COUNT changes (one going offline while another arrives left
  // the list stale).
  const machinesKey = ownMachines.map((m) => `${m.machine.machineId}:${m.online ? 1 : 0}`).join(',');
  useEffect(() => {
    let live = true;
    Promise.all(ownMachines.map(async (m) => { try { const r = await central.rpc<{ projects: ProjectInfo[] }>(m.machine.machineId, 'projects.list', {}); return r.projects.map((p) => ({ ...p, machineId: m.machine.machineId, machineName: m.machine.name })); } catch { return []; } })).then((rows) => { if (live) setRecent(rows.flat()); });
    return () => { live = false; };
  }, [machinesKey, workspace.workspaceId]);
  useEffect(() => {
    const picked = central.machines.find((m) => m.machine.machineId === machineId);
    setVisibility(picked?.kind === 'sandbox' ? 'everyone' : 'team');
  }, [machineId, central.machines]);
  const submit = (e: React.FormEvent) => { e.preventDefault(); teamApi.shareProject(workspace.workspaceId, machineId, root, name || root.split(/[\\/]/).pop() || 'Проект', access, visibility).then(() => { setRoot(''); setName(''); refresh(); }).catch((err) => setNote(err.message)); };
  return <Panel title="Команда" tab="projects" admin={!!viewer?.platformAdmin} usage={canSeeUsageTab(viewer)} subtitle="Команде видны только явно опубликованные папки."
                head={<TeamSelect viewer={viewer} current={central.viewer?.workspace} onSelect={onSelectWorkspace} />}>
    {ownMachines.length > 0 && <form className="team-form project-share" onSubmit={submit}>
      <select required value={machineId} onChange={(e) => setMachineId(e.target.value)}><option value="">Машина…</option>{ownMachines.map((m) => <option value={m.machine.machineId} key={m.machine.machineId}>{m.machine.name}{m.kind === 'sandbox' ? ' · песочница' : ''}</option>)}</select>
      <input list="recent-projects" value={root} onChange={(e) => { setRoot(e.target.value); const p = recent.find((x) => x.cwd === e.target.value); if (p) { setMachineId(p.machineId); setName(p.label); } }} placeholder="C:\work\project" required />
      <datalist id="recent-projects">{recent.map((p) => <option value={p.cwd} key={`${p.machineId}:${p.cwd}`}>{p.machineName} · {p.label}</option>)}</datalist>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название" />
      <select value={access} onChange={(e) => setAccess(e.target.value as 'view' | 'control')} aria-label="Уровень доступа"><option value="view">Только просмотр</option><option value="control">Команда ведёт сессии</option></select>
      <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'team' | 'everyone')} aria-label="Сессии владельца"><option value="team">Сессии владельца: скрыть</option><option value="everyone">Сессии владельца: показывать</option></select>
      <button className="btn primary"><Plus size={14} /> Опубликовать</button>
    </form>}
    <section className="team-card">{shares.length === 0 && <div className="team-empty">Опубликованных проектов нет.</div>}{shares.map((p) => <div className="team-row static" key={p.projectShareId}><Briefcase size={18} /><span><b>{p.name}</b><small>{p.root}</small>{p.members && p.members.length > 0 && <small>{`Допущены: ${p.members.map((m) => `${m.name ?? m.userId.slice(0, 8)} (${SHARE_ROLE[m.role]})`).join(', ')}`}</small>}</span>{workspace.role === 'owner' && !selfServe && managers.length > 0 && <select defaultValue="" aria-label={`Назначить менеджера на ${p.name}`} onChange={(e) => { if (e.target.value) teamApi.assign(workspace.workspaceId, e.target.value, 'project', p.projectShareId).then(() => setNote('Назначение на проект сохранено')).catch((err) => setNote(err.message)); }}><option value="">Назначить менеджера…</option>{managers.map((manager) => <option value={manager.userId} key={manager.userId}>{displayName(manager)}</option>)}</select>}{p.access === 'control' && <span className="role-chip control">команда ведёт</span>}{p.visibility === 'everyone' && <span className="role-chip">все сессии</span>}<span className="role-chip">{p.machineId.slice(0, 8)}</span>{(workspace.role === 'owner' || p.ownerUserId === central.viewer?.userId) && <button className="icon-btn" onClick={() => teamApi.removeProject(workspace.workspaceId, p.projectShareId).then(refresh).catch((e) => setNote(e.message))}><Trash2 size={15} /></button>}</div>)}</section>{note && <div className="team-note">{note}</div>}
  </Panel>;
}

export function TeamUsage({ central, workspace, viewer, onSelectWorkspace }: { central: CentralState; workspace: WorkspaceSummary } & TeamShellProps) {
  const [period, setPeriod] = useState<UsagePeriod>(7);
  const { report, error } = useUsage((from, to) => teamApi.usage(workspace.workspaceId, from, to), period, workspace.workspaceId);
  return <Panel title="Команда" tab="usage" admin={!!viewer?.platformAdmin} usage={canSeeUsageTab(viewer)}
                subtitle="Токены шлюза и лимиты подписок по людям."
                head={<TeamSelect viewer={viewer} current={central.viewer?.workspace} onSelect={onSelectWorkspace} />}>
    <PeriodSwitch value={period} onChange={setPeriod} />
    {error && <div className="team-note">{error}</div>}
    {!report && !error && <div className="team-empty">Загружаю…</div>}
    {report && <UsageList report={report} />}
  </Panel>;
}

export function TeamAudit({ central, workspace, viewer, onSelectWorkspace }: { central: CentralState; workspace: WorkspaceSummary } & TeamShellProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  useEffect(() => {
    let live = true;
    teamApi.audit(workspace.workspaceId).then((r) => { if (live) setEvents(r.events); });
    return () => { live = false; };
  }, [workspace.workspaceId]);
  return <Panel title="Команда" tab="audit" admin={!!viewer?.platformAdmin} usage={canSeeUsageTab(viewer)} subtitle="Просмотры и изменения доступа видны команде."
                head={<TeamSelect viewer={viewer} current={central.viewer?.workspace} onSelect={onSelectWorkspace} />}><section className="team-card">{events.map((event) => <div className="team-row static audit-row" key={event.auditEventId}><Eye size={16} /><span><b>{event.actorName ?? event.actorUserId}</b><small>{event.action} · {event.targetKind} {event.targetId.slice(0, 12)}</small></span><time>{relTimeRu(event.createdAt)}</time></div>)}</section></Panel>;
}

/**
 * Where someone already signed in gets the desktop client.
 *
 * Until now the only address for this was `/install/app` — a public page reached
 * by a link pasted into a chat. A person working in the browser tab had no way
 * to discover that a Mac or a Windows app exists at all, which is why it is
 * the first thing on the Приложения tab: you install the client, and it connects
 * the machine you work on.
 *
 * The copy leads with what a browser tab cannot do rather than with the word
 * "download", because for most of this the tab is already fine. What it cannot
 * do is count waiting sessions while it is closed, raise a system notification,
 * or restart a fallen agent — and that last one is not a nicety on Windows: the
 * scheduled task there is `ONLOGON` (deploy/install-win.ps1), so unlike launchd
 * and systemd it never restarts anything until the next sign-in.
 */
export function DesktopApps({ bare }: { bare?: boolean } = {}) {
  const [os, setOs] = useState<DesktopOs>(guessDesktopOs);
  const command = APP_INSTALL_COMMAND[os](location.origin);
  const body = <>
    <div className="install-os-tabs" role="group" aria-label="Операционная система">
      <button className={os === 'mac' ? 'active' : ''} aria-pressed={os === 'mac'} onClick={() => setOs('mac')}>macOS</button>
      <button className={os === 'win' ? 'active' : ''} aria-pressed={os === 'win'} onClick={() => setOs('win')}>Windows</button>
    </div>
    <pre className="install-command">{command}</pre>
    <p className="team-help">{os === 'mac'
      ? 'Вставьте в Терминал. Нужна macOS 13 или новее; сборка подписана Developer ID и нотаризована, Gatekeeper пропустит её без вопросов.'
      : 'Вставьте в PowerShell — права администратора не нужны. Windows предупредит, что издатель неизвестен: сборка пока без сертификата, нажмите «Подробнее» → «Выполнить в любом случае».'}</p>
    <div className="settings-actions">
      <CopyButton className="btn primary" text={command} label="Скопировать команду"><DownloadIcon size={15} /></CopyButton>
      {!bare && <a className="btn" href="/#apps">Полная инструкция</a>}
    </div>
  </>;
  if (bare) return <div className="settings-section">{body}</div>;
  return <section className="team-card settings-section">
    <h3>Приложение на компьютер</h3>
    <p className="team-help">Приложение после входа само ставит и запускает агента на этом компьютере — отдельно подключать машину не нужно. Ещё оно показывает счётчик ждущих ответа сессий в строке меню и в трее даже при закрытом окне, присылает системные уведомления о вопросах агента, а на Windows поднимает агента, если тот упал.</p>
    {body}
    <p className="team-help">Дальше приложение обновляется само — в меню значка есть «Обновить приложение». Эта команда нужна для первой установки и если что-то сломалось. Для Linux клиента нет — там работает только агент (блок «Подключить машину» на вкладке «Машины»), а пультом остаётся браузер.</p>
  </section>;
}

/**
 * The viewer's hosted sandbox as a device row, before and after it exists.
 *
 * While the provisioner works the machine is not in `/api/devices` yet, so the
 * row is drawn from `viewer.access.sandbox` alone. Once it is `ready` the real
 * device row takes over (see the chip in `WorkspaceSettings`) and this renders
 * nothing — unless the device list has not caught up, in which case the ready
 * row here keeps the promise visible. `failed` says only that we know: the
 * error text is for the admin page, not for the person waiting.
 */
function SandboxRow({ sandbox, listed }: { sandbox: NonNullable<ViewerContext['access']>['sandbox']; listed: boolean }) {
  if (!sandbox || sandbox.status === 'none') return null;
  const name = sandbox.machineName ?? 'песочница';
  switch (sandbox.status) {
    case 'queued':
      return <div className="team-row static"><span className="sb-dot busy" /><span><b>Песочница готовится…</b><small>{name} · обычно 2–5 минут, появится сама</small></span></div>;
    case 'running':
      return <div className="team-row static"><span className="sb-dot busy" /><span><b>Песочница устанавливается…</b><small>{name} · ещё минута-другая</small></span></div>;
    case 'failed':
      return <div className="team-row static"><span className="sb-dot off" /><span><b>Не получилось — мы уже знаем</b><small>{name} · поднимем и напишем</small></span></div>;
    case 'suspended':
      return <div className="team-row static"><span className="sb-dot off" /><span><b>{name}</b><small>песочница</small></span><span className="role-chip attn">приостановлена</span></div>;
    case 'ready':
      return listed ? null : <div className="team-row static"><span className="sb-dot" /><span><b>{name}</b><small>подключается…</small></span><span className="role-chip">песочница</span></div>;
    default:
      return null;
  }
}

/**
 * One row of «Мои команды». The actions are the four the hub offers, gated by
 * role: an owner transfers or deletes, everyone else leaves. Deleting asks for
 * the name typed back — the hub requires it once the team has members, and
 * asking always keeps the dialog the same shape.
 */
function TeamRow({ team, current, viewer, onSelect, onChanged, setNote }: { team: WorkspaceSummary; current: boolean; viewer: ViewerContext; onSelect?: (id: string) => void; onChanged?: () => void; setNote: (s: string) => void }) {
  const [transferOpen, setTransferOpen] = useState(false);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [target, setTarget] = useState('');
  const owner = team.role === 'owner';
  const forget = () => { if (storageGet(WORKSPACE_KEY) === team.workspaceId) storageRemove(WORKSPACE_KEY); };
  const openTransfer = () => {
    setTransferOpen((v) => !v);
    if (!transferOpen) teamApi.members(team.workspaceId).then((r) => setMembers(r.members.filter((m) => m.userId !== viewer.userId))).catch((e) => setNote(e.message));
  };
  const transfer = async (e: React.FormEvent) => {
    e.preventDefault();
    const who = members.find((m) => m.userId === target);
    if (!who || !(await askConfirm(`Передать «${team.name}» — ${displayName(who)}? Вы останетесь в команде участником.`, { confirmLabel: 'Передать' }))) return;
    teamApi.transferOwnership(team.workspaceId, target).then(() => { setTransferOpen(false); setNote(`«${team.name}» теперь ведёт ${displayName(who)}.`); onChanged?.(); }).catch((err) => setNote(err.message));
  };
  const leave = async () => {
    if (!(await askConfirm(`Покинуть «${team.name}»? Вернуться можно только по новому приглашению.`, { confirmLabel: 'Покинуть', danger: true }))) return;
    teamApi.leaveTeam(team.workspaceId, viewer.userId).then(() => { forget(); onChanged?.(); }).catch((err) => setNote(err.message));
  };
  const remove = async () => {
    const typed = await askText(`Удалить «${team.name}»? Проекты перестанут быть командными, приглашения сгорят. Код на машинах остаётся.\n\nЧтобы подтвердить, введите название команды:`);
    if (typed === null) return;
    if (typed.trim() !== team.name) { setNote('Название не совпало — команда на месте.'); return; }
    teamApi.deleteTeam(team.workspaceId, typed.trim()).then(() => { forget(); onChanged?.(); }).catch((err) => setNote(err.message));
  };
  return <>
    <div className="team-row static wrap">
      <Briefcase size={18} />
      <span><b>{team.name}</b><small>{owner ? 'владелец' : ROLE_LABEL[team.role] ?? team.role}{team.slug ? ` · ${team.slug}` : ''}</small></span>
      {current ? <span className="role-chip control">открыта</span> : onSelect && <button className="btn" onClick={() => onSelect(team.workspaceId)}>Открыть</button>}
      <div className="team-actions">
        {owner
          ? <><button className="btn primary" onClick={() => { if (!current) onSelect?.(team.workspaceId); navigate({ kind: 'team', tab: 'people' }); }}>Пригласить</button><button className="btn" onClick={openTransfer} aria-expanded={transferOpen}>Передать владение</button><button className="btn danger" onClick={remove}>Удалить команду</button></>
          : <button className="btn" onClick={leave}>Покинуть команду</button>}
      </div>
    </div>
    {transferOpen && <form className="team-form compact" onSubmit={transfer}>
      <b>Кому</b>
      <select value={target} onChange={(e) => setTarget(e.target.value)} required>
        <option value="">Выбрать участника…</option>
        {members.map((m) => <option value={m.userId} key={m.userId}>{displayName(m)}</option>)}
      </select>
      <button className="btn primary" disabled={!target}>Передать</button>
      {members.length === 0 && <small className="team-help">В команде пока никого, передавать некому.</small>}
    </form>}
  </>;
}

/** The account itself, deleted from here (the Android app has the same in
 *  Настройки → Аккаунт). Typed confirmation, like deleting a team. */
/**
 * «Где я вошёл»: every live sign-in of this person, and the way to end one —
 * or all but this one. Ending a session on the hub also closes the sockets it
 * already holds open, so this is what to press after a lost phone or a token
 * seen where it should not be. Sessions end on their own 180 days after
 * sign-in however much they are used.
 */
function SignIns() {
  const [sessions, setSessions] = useState<SignInSession[] | undefined>();
  const [error, setError] = useState('');
  const load = () => teamApi.sessions().then((r) => setSessions(r.sessions), (e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const revoke = (id: string) => teamApi.revokeSession(id).then(load, (e: Error) => setError(e.message));
  const revokeOthers = async () => {
    if (!(await askConfirm('Выйти на всех остальных устройствах? Приложения и вкладки там попросят войти заново.', { confirmLabel: 'Выйти', danger: true }))) return;
    void teamApi.revokeOtherSessions().then(load, (e: Error) => setError(e.message));
  };
  const others = sessions?.filter((s) => !s.current).length ?? 0;
  return <section className="team-card settings-section">
    <h3>Где я вошёл</h3>
    <p className="team-help">Каждый вход — браузер, приложение, бот. Незнакомый — завершите его. Вход сам истекает через 180 дней.</p>
    {sessions === undefined && !error && <p className="team-help">Загружаю…</p>}
    {sessions?.map((s) => <div className="team-row static" key={s.id}>
      {/phone|ios|android|приложение/i.test(s.label ?? '') ? <PhoneIcon size={16} /> : <MonitorIcon size={16} />}
      <span><b>{s.label || 'Неизвестное устройство'}</b>
        <small>{s.current ? 'это устройство · ' : ''}вход {relTimeRu(s.createdAt)}{s.lastSeen ? ` · был ${relTimeRu(s.lastSeen)}` : ''}</small></span>
      {!s.current && <button className="btn" onClick={() => void revoke(s.id)}>Завершить</button>}
    </div>)}
    {others > 0 && <div className="team-actions"><button className="btn danger" onClick={revokeOthers}>Выйти на остальных устройствах ({others})</button></div>}
    {error && <div className="team-note">{error}</div>}
  </section>;
}

async function deleteAccount(setNote: (s: string) => void) {
  const typed = await askText('Удалить аккаунт Hegai Code? Это нельзя отменить.\n\nС сервера удалятся: аккаунт и все входы в него, личное пространство и команды, где вы единственный участник, подключённые машины и копия истории их сессий, память, ключ доступа к моделям. Файлы на самих машинах останутся.\n\nЧтобы подтвердить, введите УДАЛИТЬ:');
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'УДАЛИТЬ') { setNote('Слово не совпало — аккаунт на месте.'); return; }
  teamApi.deleteAccount().then(async () => { await showNotice('Аккаунт удалён.'); location.reload(); }).catch((err) => setNote(err.message));
}
const Memory = lazy(() => import('./components/Memory.js').then((m) => ({ default: m.Memory })));
const Profile = lazy(() => import('./Profile.js').then((m) => ({ default: m.Profile })));

/** A folded section of Аккаунт. Its body mounts only when opened: Память and
 *  Профиль each fetch from machines on mount, and most visits never read them. */
function AccountFold({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="acc-fold" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>{title}</summary>
    {open && <Suspense fallback={<p className="team-help">Загружаем…</p>}>{children}</Suspense>}
  </details>;
}

/**
 * «Мои устройства»: the machines enrolled to this person (and the sandbox), with
 * «Отозвать» / «Вернуть». Lives on Настройки → Машины, under the fleet cards.
 * Connecting a machine is `ConnectMachine` (`/go`), which needs no code minted
 * here.
 */
export function MyDevices({ central, viewer }: { central: CentralState; viewer?: ViewerContext | null }) {
  const [note, setNote] = useState('');
  const [devices, setDevices] = useState<Array<{ machineId: string; name: string; os: string; lastSeen: number; revoked?: boolean }>>([]);
  const refreshDevices = () => teamApi.devices().then((r) => setDevices(r.devices)).catch((e) => setNote(e.message));
  useEffect(() => { void refreshDevices(); }, []);
  const who = viewer ?? central.viewer;
  const sandbox = who?.access?.sandbox;
  const sandboxId = sandbox?.machineId;
  // The cap counts personal devices only — the sandbox is ours, not theirs.
  const personal = devices.filter((d) => !d.revoked && d.machineId !== sandboxId);
  const cap = who?.access?.deviceCap;
  const sandboxListed = !!sandboxId && devices.some((d) => d.machineId === sandboxId);
  return <>
    <section className="team-card hw-devices"><h3>Мои устройства{cap != null && <span className="devices-count"> {personal.length} / {cap}</span>}</h3>
      <SandboxRow sandbox={sandbox} listed={sandboxListed} />
      {devices.map((device) => {
        const isSandbox = device.machineId === sandboxId;
        return <div className="team-row static" key={device.machineId}>
          <MonitorIcon size={17} />
          <span><b>{device.name}</b><small>{device.os} · {relTimeRu(device.lastSeen)}</small></span>
          {isSandbox
            ? <span className={`role-chip ${sandbox?.status === 'suspended' ? 'attn' : ''}`}>{sandbox?.status === 'suspended' ? 'песочница · приостановлена' : 'песочница'}</span>
            : device.revoked
              ? <button className="btn" onClick={() => teamApi.restoreDevice(device.machineId).then(refreshDevices).catch((e) => setNote(e.message))}>Вернуть</button>
              : <button className="btn revoke" onClick={() => teamApi.revokeDevice(device.machineId).then(refreshDevices).catch((e) => setNote(e.message))}>Отозвать</button>}
        </div>;
      })}
    </section>
    {note && <div className="team-note">{note}</div>}
  </>;
}

export function WorkspaceSettings({ central, viewer, onWorkspaceCreated, onSelectWorkspace }: { central: CentralState; onWorkspaceCreated: () => void } & TeamShellProps) {
  const [orgName, setOrgName] = useState(''); const [note, setNote] = useState('');
  // One entity on a self-hosted hub: a team. The platform «организация» is ours.
  const external = isExternal(usePublicConfig());
  const who = viewer ?? central.viewer;
  const access = who?.access;
  const teams = teamsOf(who);
  const currentId = central.viewer?.workspace.workspaceId;
  return <Panel title="Настройки" subtitle="Вход, команда и безопасность.">
    {access?.githubGrant && <RepoGrantCard grant={access.githubGrant} />}
    {who && teams.length > 0 && <section className="team-card"><h3>Мои команды</h3>
      {teams.map((t) => <TeamRow key={t.workspaceId} team={t} current={t.workspaceId === currentId} viewer={who} onSelect={onSelectWorkspace} onChanged={onWorkspaceCreated} setNote={setNote} />)}
    </section>}
    <CreateTeamCard viewer={who} onCreated={onWorkspaceCreated} />
    {viewer?.llmUsage && <MyUsageCard />}
    {/* Support access belongs to the team that is open now, and to its owner. */}
    {central.viewer && canGrantSupport(central.viewer.workspace) && <SupportAccess workspace={central.viewer.workspace} />}
    {access?.plan === 'community' && <section className="team-card settings-section"><h3>Как это устроено</h3>
      <p className="team-help">Песочница — обычный Linux-сервер с агентом и Codex; сессия — процесс в папке проекта, а эта вкладка — пульт к нему. Проект ваш: его можно отправить в свой репозиторий или забрать на свою машину в любой момент.</p>
      <div className="team-actions">
        {/* Both used to point at Главная, which carried the welcome card and
            ate a `#take` hash. They live on the start screen now. */}
        <button className="btn" onClick={() => { resetWelcome(); navigate(pathFor({ kind: 'new' })); }}>Показать приветствие ещё раз</button>
        <button className="btn" onClick={() => navigate(`${pathFor({ kind: 'new' })}#take`)}>Забрать своё</button>
      </div>
    </section>}
    {who?.platformAdmin && !external && <section className="team-card settings-section"><h3>Создать организацию (админ)</h3><form className="team-form" onSubmit={(e) => { e.preventDefault(); teamApi.createWorkspace(orgName).then(() => { setOrgName(''); onWorkspaceCreated(); }).catch((err) => setNote(err.message)); }}><input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Название организации" required /><button className="btn primary">Создать</button></form></section>}
    <section className="team-card settings-section"><h3>Сессия</h3><p>{displayName(who)}</p><div className="team-actions"><button className="btn" onClick={() => teamApi.logout().then(() => location.reload())}>Выйти</button><button className="btn danger quiet" onClick={() => deleteAccount(setNote)}>Удалить аккаунт</button></div></section>
    <SignInMethods onChanged={onWorkspaceCreated} />
    <TwoFactorCard /><SignIns />
    {/* Память and Профиль were tabs of their own; they are sections of the
        account now, folded, because they are read rarely and are long. */}
    <AccountFold title="Что помнит хаб"><Memory central={central} /></AccountFold>
    <AccountFold title="Моя активность"><Profile central={central} /></AccountFold>
    {note && <div className="team-note">{note}</div>}
  </Panel>;
}
