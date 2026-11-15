import { useCallback, useEffect, useState } from 'react';
import type { AuditEvent, SupportGrant, WorkspaceSummary } from '@cc-remote/shared';
import { teamApi } from '../teamApi.js';
import { CopyButton } from './CopyButton.js';
import { Eye } from '../icons.js';
import { askConfirm } from '../dialogs.js';

/** The four lengths offered; the hub accepts 1..72. */
const HOURS = [
  { hours: 1, label: '1 час' },
  { hours: 4, label: '4 часа' },
  { hours: 24, label: '24 часа' },
  { hours: 72, label: '72 часа' },
] as const;

const ROLES: Array<{ role: SupportGrant['role']; label: string }> = [
  { role: 'member', label: 'Участник — работает в открытых проектах' },
  { role: 'manager', label: 'Менеджер — видит работу команды' },
];

const ACTION_LABEL: Record<string, string> = {
  'support.grant': 'Доступ открыт',
  'support.login': 'Вход по ссылке',
  'support.revoke': 'Доступ закрыт владельцем',
  'support.expired': 'Срок доступа вышел',
  'support.ui': 'Действие в приложении',
  'support.http': 'Изменение через API',
  'terminal.opened': 'Открыт терминал',
};

/** «3 ч 12 мин», «45 мин», «2 дн 4 ч» — the time a grant has left. */
export function leftRu(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  return `${Math.floor(hours / 24)} дн ${hours % 24} ч`;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function detail(event: AuditEvent): string {
  const m = event.metadata ?? {};
  const str = (key: string) => (typeof m[key] === 'string' ? (m[key] as string) : '');
  if (event.action === 'support.http') return `${str('method')} ${str('path')}${m.refused ? ' — отказано' : ''}`;
  if (event.action === 'support.ui') {
    const target = str('path') || str('sessionId') || str('machineId') || str('termId');
    return [str('type'), str('method'), target].filter(Boolean).join(' · ');
  }
  return str('role') || str('note');
}

/**
 * «Доступ поддержки»: the owner of a team opens a time-limited account for
 * HegAI support, passes the one-time link on, and reads what support did.
 * Closing it ends the sessions at once; if nobody does, it ends by itself.
 */
export function SupportAccess({ workspace }: { workspace: WorkspaceSummary }) {
  const workspaceId = workspace.workspaceId;
  const [grants, setGrants] = useState<SupportGrant[] | undefined>();
  const [hours, setHours] = useState<number>(4);
  const [role, setRole] = useState<SupportGrant['role']>('member');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState<{ link: string; grant: SupportGrant } | null>(null);
  const [logOf, setLogOf] = useState<string | null>(null);
  const [log, setLog] = useState<AuditEvent[] | undefined>();
  const [logTotal, setLogTotal] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    () => teamApi.supportGrants(workspaceId).then((r) => setGrants(r.grants), (e: Error) => setError(e.message)),
    [workspaceId],
  );
  useEffect(() => {
    setFresh(null);
    setLogOf(null);
    void load();
  }, [load]);
  // The countdown, and a refresh when something runs out.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const open = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    teamApi
      .openSupport(workspaceId, hours, role, note.trim() || undefined)
      .then((r) => {
        setFresh(r);
        setNote('');
        return load();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const close = async (grant: SupportGrant) => {
    if (!(await askConfirm('Закрыть доступ поддержки сейчас? Её вход и открытые окна прекратятся сразу.', { confirmLabel: 'Закрыть доступ', danger: true }))) return;
    teamApi
      .closeSupport(workspaceId, grant.grantId)
      .then(() => {
        if (fresh?.grant.grantId === grant.grantId) setFresh(null);
        return load();
      })
      .catch((err: Error) => setError(err.message));
  };

  const toggleLog = (grant: SupportGrant) => {
    if (logOf === grant.grantId) {
      setLogOf(null);
      return;
    }
    setLogOf(grant.grantId);
    setLog(undefined);
    teamApi.supportLog(workspaceId, grant.grantId).then((r) => { setLog(r.events); setLogTotal(r.total); }, (err: Error) => setError(err.message));
  };

  // The log is newest first and capped per call; older rows come on request.
  // A page starts at the oldest row already shown (inclusive), so rows of the
  // same millisecond are not lost; the ones already held are dropped.
  const olderLog = (grant: SupportGrant) => {
    const last = log?.[log.length - 1];
    if (!last) return;
    teamApi.supportLog(workspaceId, grant.grantId, last.createdAt).then((r) => {
      const seen = new Set((log ?? []).map((e) => e.auditEventId));
      setLog([...(log ?? []), ...r.events.filter((e) => !seen.has(e.auditEventId))]);
      setLogTotal(r.total);
    }, (err: Error) => setError(err.message));
  };

  return (
    <section className="team-card settings-section" aria-label="Доступ поддержки">
      <h3>Доступ поддержки</h3>
      <p className="team-help">
        Если нужна помощь, откройте поддержке Hegai Code временный доступ к этой команде. Вы выбираете срок и роль, получаете одноразовую ссылку и
        передаёте её нам. Доступ закроется сам, а действия поддержки сохраняются, и вы видите их здесь. Проекты и машины поддержка видит только те, которыми вы поделились с командой.
      </p>
      <form className="team-form support-form" onSubmit={open}>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Срок доступа">
          {HOURS.map((h) => <option key={h.hours} value={h.hours}>{h.label}</option>)}
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value as SupportGrant['role'])} aria-label="Роль поддержки">
          {ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Что случилось (по желанию)" maxLength={500} aria-label="Заметка" />
        <button className="btn primary" disabled={busy}>Открыть доступ</button>
      </form>
      {fresh && (
        <div className="support-link">
          <p className="team-help">
            Ссылка показана один раз. Она сработает один раз и до {when(fresh.grant.linkExpiresAt)}; доступ действует до {when(fresh.grant.expiresAt)}.
          </p>
          <pre className="install-command">{fresh.link}</pre>
          <div className="team-actions">
            <CopyButton text={fresh.link} className="btn primary" label="Скопировать ссылку" />
            <button className="btn" type="button" onClick={() => setFresh(null)}>Скрыть</button>
          </div>
        </div>
      )}
      {grants?.length === 0 && <p className="team-help">Доступ не открывали.</p>}
      {grants?.map((g) => {
        const live = g.status === 'active' && g.expiresAt > now;
        const status = g.status === 'revoked' ? 'закрыт' : live ? `осталось ${leftRu(g.expiresAt - now)}` : 'срок вышел';
        return (
          <div key={g.grantId}>
            <div className="team-row static">
              <Eye size={16} />
              <span>
                <b>Поддержка · {g.role === 'manager' ? 'менеджер' : 'участник'}</b>
                <small>{status}{live ? (g.linkUsed ? ' · ссылку открыли' : ' · ссылку ещё не открывали') : ''}{g.note ? ` · ${g.note}` : ''}</small>
              </span>
              <div className="team-actions">
                <button className="btn" onClick={() => toggleLog(g)} aria-expanded={logOf === g.grantId}>Что делала поддержка</button>
                {live && <button className="btn danger" onClick={() => close(g)}>Закрыть доступ</button>}
              </div>
            </div>
            {logOf === g.grantId && (
              <div className="support-log">
                {log === undefined && <p className="team-help">Загружаю…</p>}
                {log?.length === 0 && <p className="team-help">Пока ничего.</p>}
                {log?.map((event) => (
                  <div className="team-row static audit-row" key={event.auditEventId}>
                    <span>
                      <b>{ACTION_LABEL[event.action] ?? event.action}</b>
                      <small>{detail(event)}</small>
                    </span>
                    <time>{when(event.createdAt)}</time>
                  </div>
                ))}
                {log !== undefined && log.length < logTotal && (
                  <div className="team-actions"><button className="btn" onClick={() => olderLog(g)}>Показать более ранние ({logTotal - log.length})</button></div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {error && <div className="team-note">{error}</div>}
    </section>
  );
}
