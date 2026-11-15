import { useCallback, useEffect, useRef, useState } from 'react';
import { isExternal, usePublicConfig } from './publicConfig.js';
import type {
  AccessRow,
  GithubGrant,
  PreauthorizedEmail,
  ProvisionJob,
  SandboxStatus,
  SeatStatus,
  ViewerContext,
} from '@cc-remote/shared';
import { ApiError, teamApi, type AccessCounts, type AccessState, type GithubRevocation } from './teamApi.js';
import { Panel } from './TeamViews.js';
import { AgentRelease } from './AgentRelease.js';
import { accountAge, displayName, toMillis } from './lib.js';
import { askConfirm, askText } from './dialogs.js';

/**
 * «Доступ» — the fifth tab of Команда, platform admins only.
 *
 * Three lists of people (waiting, active, suspended) and the one action each
 * list is for. It is deliberately a table, not a funnel: the numbers here are
 * for the person opening access, and the only thing that should be fast is
 * adding one address. Nothing on this page is shown to the people in it.
 *
 * Access used to be opened in waves — a cohort label plus «активировать N
 * старейших». It is one account at a time now, and the address does not have
 * to belong to anyone yet: an email nobody has signed in with is remembered
 * and activated at that person's first login through HegAI.
 */

const LISTS: { id: AccessState; label: string }[] = [
  { id: 'waitlist', label: 'В списке' },
  { id: 'active', label: 'Активные' },
  { id: 'suspended', label: 'Приостановленные' },
];

/** Hub reasons, in the words of the person reading them. An unknown reason is
 *  shown raw rather than swallowed — a silent refusal is the worse failure. */
const REFUSAL: Record<string, string> = {
  already_active: 'уже активен',
  suspended: 'приостановлен — верни его во вкладке «Приостановленные»',
  not_found: 'не найден',
};

const PAGE = 100;

/** «2 сент.» — the same tolerance for seconds as the gate. */
function fmtDate(ts?: number): string {
  if (!ts) return '—';
  return new Date(toMillis(ts)).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

function initials(name: string): string {
  return name.trim().split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

/** Seat on the LLM gateway. `none` draws nothing: an employee row has no seat. */
function SeatChip({ status }: { status: SeatStatus }) {
  switch (status) {
    case 'ready': return <span className="role-chip control">ключ</span>;
    case 'pending': return <span className="role-chip">ключ: создаётся</span>;
    case 'failed': return <span className="role-chip attn">ключ: ошибка</span>;
    case 'inactive': return <span className="role-chip">ключ выключен</span>;
    default: return null;
  }
}

/** Where the invitation to the private repository stands. Absent = the hub
 *  grants nothing, or this person did not sign in with GitHub. */
function GrantChip({ grant }: { grant?: GithubGrant }) {
  if (!grant) return null;
  const title = grant.error ? `${grant.error} (попыток: ${grant.attempts ?? 0})` : grant.repo;
  switch (grant.status) {
    case 'granted': return <span className="role-chip control" title={title}>репозиторий: есть доступ</span>;
    case 'invited': return <span className="role-chip" title={title}>репозиторий: приглашён</span>;
    case 'pending': return <span className="role-chip" title={title}>репозиторий: в очереди</span>;
    case 'failed': return <span className="role-chip attn" title={title}>репозиторий: ошибка</span>;
    case 'revoking': return <span className="role-chip attn" title={title}>репозиторий: снимается</span>;
    case 'revoked': return <span className="role-chip" title={title}>репозиторий: доступ снят</span>;
  }
}

/** Only http(s) links are made clickable: a blog field is free text. */
function safeUrl(value: string): string | undefined {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The registration answers and the GitHub profile, for the admin deciding. */
function RowDetails({ row }: { row: AccessRow }) {
  const { registration: reg, github: gh } = row;
  if (!reg && !gh) return null;
  const age = accountAge(gh?.createdAt);
  const blog = gh?.blog ? safeUrl(gh.blog) : undefined;
  return (
    <details className="access-detail">
      <summary>{reg ? 'Анкета' : 'Профиль'}{gh ? ` · GitHub ${gh.login}` : ''}</summary>
      {reg && (
        <dl>
          <dt>Кто</dt><dd>{reg.role}</dd>
          <dt>Зачем</dt><dd>{reg.purpose}</dd>
          {reg.company && <><dt>Компания</dt><dd>{reg.company}</dd></>}
          {reg.telegram && <><dt>Telegram</dt><dd>{reg.telegram}</dd></>}
          {reg.source && <><dt>Откуда узнал</dt><dd>{reg.source}</dd></>}
        </dl>
      )}
      {gh && (
        <dl>
          <dt>GitHub</dt>
          <dd>
            <a href={`https://github.com/${encodeURIComponent(gh.login)}`} target="_blank" rel="noreferrer">{gh.login}</a>
            {gh.name ? ` · ${gh.name}` : ''}
          </dd>
          <dt>Аккаунту</dt><dd>{age ?? '—'}</dd>
          <dt>Репозитории</dt><dd>{gh.publicRepos ?? '—'} публичных · {gh.followers ?? '—'} подписчиков</dd>
          {gh.bio && <><dt>О себе</dt><dd>{gh.bio}</dd></>}
          {gh.company && <><dt>Компания</dt><dd>{gh.company}</dd></>}
          {gh.blog && <><dt>Сайт</dt><dd>{blog ? <a href={blog} target="_blank" rel="noreferrer">{gh.blog}</a> : gh.blog}</dd></>}
        </dl>
      )}
    </details>
  );
}

function SandboxChip({ status }: { status: SandboxStatus }) {
  switch (status) {
    case 'ready': return <span className="role-chip control">песочница</span>;
    case 'queued': return <span className="role-chip">песочница: в очереди</span>;
    case 'running': return <span className="role-chip">песочница: ставится</span>;
    case 'failed': return <span className="role-chip attn">песочница: ошибка</span>;
    case 'suspended': return <span className="role-chip attn">песочница: пауза</span>;
    default: return null;
  }
}

function dateLine(row: AccessRow): string {
  switch (row.state) {
    case 'active':
      return `активирован ${fmtDate(row.activatedAt)}`;
    case 'suspended':
      return `приостановлен ${fmtDate(row.suspendedAt)}${row.suspendReason ? ` · ${row.suspendReason}` : ''}`;
    default:
      return `в списке с ${fmtDate(row.requestedAt)}`;
  }
}

/**
 * The tab itself. Everyone else gets the stub — and no redirect: a URL that
 * silently turns into another URL is how one spends an hour deciding whether
 * the deploy landed.
 */
export function TeamAccess({ viewer }: { viewer?: ViewerContext | null }) {
  if (!viewer?.platformAdmin) {
    return (
      <Panel title="Команда" tab="access" subtitle="Доступ к песочницам.">
        <div className="team-empty">Эта страница — для администраторов платформы.</div>
      </Panel>
    );
  }
  return <AccessAdmin />;
}

function AccessAdmin() {
  const external = isExternal(usePublicConfig());
  const [list, setList] = useState<AccessState>('waitlist');
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [counts, setCounts] = useState<AccessCounts>({ waitlist: 0, active: 0, suspended: 0 });
  // `null` = this hub predates the field (or the provisioning endpoint), so the
  // section stays hidden rather than showing an empty one.
  const [pending, setPending] = useState<PreauthorizedEmail[] | null>(null);
  const [revocations, setRevocations] = useState<GithubRevocation[]>([]);
  const [jobs, setJobs] = useState<ProvisionJob[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const listRef = useRef(list);
  listRef.current = list;
  // The 30 s tick must not land mid-mutation and paint a page that predates it.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const load = useCallback(async (offset = 0) => {
    try {
      const r = await teamApi.adminAccess(listRef.current, PAGE, offset);
      setCounts(r.counts);
      setPending(r.pending ?? null);
      setRevocations(r.githubRevocations ?? []);
      setRows((prev) => (offset === 0 ? r.users : [...prev, ...r.users]));
    } catch (e) {
      setNote((e as Error).message);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const r = await teamApi.failedJobs();
      setJobs(r.jobs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setJobs(null);
      else setNote((e as Error).message);
    }
  }, []);

  // Reload on list change and every 30 s: seat and sandbox chips flip on their
  // own as the provisioner works, and this page is where one watches that.
  useEffect(() => {
    setRows([]);
    void load();
    void loadJobs();
    const t = window.setInterval(() => {
      if (busyRef.current) return;
      void load();
      void loadJobs();
    }, 30_000);
    return () => window.clearInterval(t);
  }, [list, load, loadJobs]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      await fn();
      setNote(`${label}: готово`);
      await load();
      await loadJobs();
    } catch (e) {
      setNote(`${label}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** The page's primary verb. Three outcomes, and the admin must be able to
   *  tell them apart — so this one formats its own answer instead of going
   *  through `run`. The field keeps its text on a refusal (a typo is worth
   *  fixing in place) and clears on either success. */
  const addOne = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!value || busy) return;
    setBusy(true);
    setNote('');
    try {
      const r = await teamApi.grant(value);
      if (r.status === 'activated') {
        setNote(`${value} — активирован. Ключ и песочница ставятся, обычно это пара минут.`);
        setEmail('');
      } else if (r.status === 'pending') {
        setNote(`${value} — в списке разрешённых. Доступ включится сам при первом входе через HegAI.`);
        setEmail('');
      } else if (r.reason === 'already_pending') {
        setNote(`${value} — уже добавлен ${fmtDate(r.pending?.createdAt)}, ждёт первого входа.`);
      } else {
        setNote(`${value} — ${REFUSAL[r.reason ?? ''] ?? `не добавлен: ${r.reason ?? 'причина неизвестна'}`}.`);
      }
      await load();
      await loadJobs();
    } catch (err) {
      setNote(`${value}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const activateOne = (row: AccessRow) =>
    void run(`Активирован ${displayName(row)}`, () => teamApi.activate([row.userId]));
  const suspendOne = async (row: AccessRow) => {
    const reason = await askText(`Приостановить ${displayName(row)}?\n\nПричина (видна только администраторам):`, '');
    if (reason === null) return;
    void run(`Приостановлен ${displayName(row)}`, () => teamApi.suspend([row.userId], reason.trim() || undefined));
  };
  const reactivateOne = (row: AccessRow) =>
    void run(`Возвращён ${displayName(row)}`, () => teamApi.reactivate([row.userId]));
  const removePending = async (p: PreauthorizedEmail) => {
    if (!(await askConfirm(`Убрать ${p.email} из списка разрешённых?\n\nОн не получит доступ при входе.`, { confirmLabel: 'Убрать', danger: true }))) return;
    void run(`Убран ${p.email}`, () => teamApi.revokePreauth(p.email));
  };
  const retryGrant = (row: AccessRow) =>
    void run(`Приглашение в репозиторий: ${displayName(row)}`, () => teamApi.retryGithubGrant(row.userId));
  const retryJob = (job: ProvisionJob) =>
    void run(`Повтор ${job.email ?? job.userId}`, () => teamApi.retryJob(job.jobId));

  const total = counts[list];

  return (
    <Panel title="Команда" tab="access" admin subtitle={external ? 'Кто может входить на этот сервер: ждут, работают, на паузе.' : 'Доступ участников сообщества: кто ждёт, кто в работе, кто на паузе.'}>
      <div className="team-metrics">
        <article><b>{counts.waitlist}</b><span>в списке</span></article>
        <article><b>{counts.active}</b><span>активных</span></article>
        <article className={counts.suspended > 0 ? 'attn' : ''}><b>{counts.suspended}</b><span>приостановлено</span></article>
      </div>

      {/* Above the three lists, not inside «В списке»: the address of someone
          who has never signed in belongs to no list, and hiding the field
          under one of them makes it reachable only from a list that person is
          by definition not in. */}
      <form className="team-form access-add" onSubmit={addOne}>
        <input
          type="email"
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@company.com"
          autoComplete="off"
          spellCheck={false}
          aria-label="Адрес"
          required
        />
        <button className="btn primary" disabled={busy || !email.trim()}>Добавить</button>
      </form>

      {pending && pending.length > 0 && (
        <section className="team-card">
          <h3>Ждут первого входа</h3>
          {pending.map((p) => (
            <div className="team-row static access-row" key={p.email}>
              <span className="team-avatar">{initials(p.email)}</span>
              <span>
                <b>{p.email}</b>
                <small>добавлен <span className="access-date">{fmtDate(p.createdAt)}</span></small>
                {p.note && <small className="access-note" title={p.note}>«{p.note}»</small>}
              </span>
              <span className="role-chip">активируется при входе</span>
              <div className="access-actions">
                <button className="btn" disabled={busy} onClick={() => removePending(p)}>Убрать</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {revocations.length > 0 && (
        <section className="team-card">
          <h3>Доступ к репозиторию ещё не снят</h3>
          {revocations.map((v) => (
            <div className="team-row static access-row" key={v.githubId}>
              <span>
                <b>{v.login ?? `GitHub id ${v.githubId}`}</b>
                <small>{v.repo} · аккаунт удалён · попыток {v.attempts}</small>
                {v.error && <small className="access-note" title={v.error}>{v.error}</small>}
              </span>
              <span className="role-chip attn">снимается</span>
            </div>
          ))}
        </section>
      )}

      {/* A segmented control, not a second underlined strip: the tabs above
          are the destination, these three are one exhaustive switch. */}
      <div className="install-os-tabs access-switch" role="group" aria-label="Состояние доступа">
        {LISTS.map((l) => (
          <button key={l.id} className={l.id === list ? 'active' : ''} aria-pressed={l.id === list} onClick={() => setList(l.id)}>{l.label}</button>
        ))}
      </div>

      <section className="team-card">
        {rows.length === 0 && <div className="team-empty">{list === 'waitlist' ? 'Никто не ждёт.' : list === 'active' ? 'Пока никого.' : 'Никто не приостановлен.'}</div>}
        {rows.map((r) => (
          <div className="team-row static access-row" key={r.userId}>
            <span className="team-avatar">{initials(displayName(r))}</span>
            <span>
              <b>{displayName(r)}</b>
              <small>{r.email ? (r.fullName ? `${r.email} · ` : '') : `без почты · id ${r.userId.slice(0, 8)} · `}<span className="access-date">{dateLine(r)}</span>{r.plan === 'employee' ? ' · сотрудник' : ''}</small>
              {r.note && <small className="access-note" title={r.note}>«{r.note}»</small>}
              <RowDetails row={r} />
            </span>
            {r.invitedTo?.map((team) => <span className="role-chip invited" key={team} title="Приглашён в команду — откройте ему доступ первым">→ {team}</span>)}
            <SeatChip status={r.seat.status} />
            <SandboxChip status={r.sandbox.status} />
            <GrantChip grant={r.githubGrant} />
            <div className="access-actions">
              {r.githubGrant && list === 'active' && r.githubGrant.status !== 'revoking' && (
                <button className="btn" disabled={busy} onClick={() => retryGrant(r)}>{r.githubGrant.status === 'granted' ? 'Проверить доступ' : 'Пригласить снова'}</button>
              )}
              {list === 'waitlist' && <button className="btn primary" disabled={busy} onClick={() => activateOne(r)}>Активировать</button>}
              {list === 'active' && <button className="btn" disabled={busy} onClick={() => suspendOne(r)}>Приостановить</button>}
              {list === 'suspended' && <button className="btn primary" disabled={busy} onClick={() => reactivateOne(r)}>Вернуть</button>}
            </div>
          </div>
        ))}
        {rows.length > 0 && rows.length < total && (
          <div className="team-row static"><button className="btn" onClick={() => void load(rows.length)}>Показать ещё ({total - rows.length})</button></div>
        )}
      </section>

      {jobs && jobs.length > 0 && (
        <section className="team-card">
          <h3>Не удалось поднять</h3>
          {jobs.map((j) => (
            <div className="team-row static access-row" key={j.jobId}>
              <span>
                <b>{j.email ?? j.userId}</b>
                <small>{j.kind} · попыток {j.attempts}{j.host ? ` · ${j.host}` : ''} · <span className="access-date">{fmtDate(j.finishedAt ?? j.createdAt)}</span></small>
                {j.error && <small className="access-note" title={j.error}>{j.error}</small>}
              </span>
              <div className="access-actions">
                <button className="btn" disabled={busy} onClick={() => retryJob(j)}>Повторить</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* External edition only: the section draws nothing when the hub has no such page. */}
      <AgentRelease />

      {note && <div className="team-note">{note}</div>}
    </Panel>
  );
}
