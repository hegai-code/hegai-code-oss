import { useEffect, useRef, useState } from 'react';
import type { ViewerContext } from '@cc-remote/shared';
import { HegaiMark } from './HegaiMark.js';
import { teamApi, type RegistrationForm } from '../teamApi.js';
import { toMillis, viewerName } from '../lib.js';

/**
 * What a signed-in person sees before their access is active.
 *
 * It replaces the whole shell, rail included: there is nothing behind the rail
 * yet (the hub answers `/ui` with an empty snapshot and refuses every
 * mutation), and six destinations that all open on «Нет подключённых машин»
 * would say the product is broken rather than that their turn has not come
 * yet. One card in the sign-in layout says the true thing.
 *
 * The copy has no queue position, no timer and no «успейте». The mechanism is
 * an admin opening access by hand, one person at a time, and the person cannot
 * hurry it; a number that never moves
 * would only teach them to reload. What they CAN do here — say what they want
 * to build, accept an invitation — is on the card.
 *
 * `access` absent altogether means an older hub, where everyone is an employee
 * — App never renders this in that case (see `isAccessActive`).
 */
export function AccessGate({
  viewer,
  onRefresh,
  onLogout,
}: {
  viewer: ViewerContext;
  /** Re-reads `/api/me`. Polled every 60 s; the gate drops when the state flips. */
  onRefresh: () => Promise<unknown>;
  onLogout: () => void;
}) {
  const access = viewer.access;
  const state = access?.state ?? 'active';
  // First name, else the address's local part; a Telegram-only account may
  // have neither.
  const firstName = viewerName(viewer, 'друг');

  // The poll. `onRefresh` is a fresh closure on every App render; holding it in
  // a ref keeps one interval alive instead of restarting it each render.
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    const t = window.setInterval(() => { void refresh.current(); }, 60_000);
    return () => window.clearInterval(t);
  }, []);

  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      await teamApi.requestAccess(note.trim());
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  // The form comes first for someone who has not filled it in: the admin who
  // opens access reads these answers. `filled` flips the moment the hub
  // accepts them, before the next `/api/me` poll says so.
  const [filled, setFilled] = useState(false);
  const needsRegistration = state === 'waitlist' && access?.registered === false && !filled;
  const register = async (form: RegistrationForm) => {
    await teamApi.submitRegistration(form);
    setFilled(true);
    void refresh.current();
  };

  return (
    <div className="auth-screen">
      <div className="auth-card access-gate">
        <span className="topbar-brand"><HegaiMark size={18} mono="var(--action)" /> heg<b>ai</b> remote</span>

        {state === 'suspended' ? (
          <>
            <h1>Доступ приостановлен.</h1>
            <p>Песочница выключена; код и память остаются твоими — напиши Владельцу, включим на час, чтобы забрать.</p>
            {access?.sandbox?.machineName && (
              <div className="gate-status">{access.sandbox.machineName} · приостановлена</div>
            )}
          </>
        ) : needsRegistration ? (
          <>
            <h1>Здравствуй, {firstName}. Расскажи о себе.</h1>
            <p>
              Доступ открываем руками, по одному человеку. Пара строк о тебе — и мы поймём, кого пускаем
              и чем можем быть полезны. Это читает человек, не бот.
            </p>
            <RegistrationFormView onSubmit={register} />
          </>
        ) : (
          <>
            <h1>Здравствуй, {firstName}. Ты в списке.</h1>
            <p>
              Доступ открываем руками, по одному человеку — чтобы каждому хватало моделей
              и нашего внимания. Когда дойдём до тебя, здесь появится твоя машина; напишем в Telegram.
            </p>
            <div className="gate-status">в списке с {sinceLabel(access?.requestedAt)}</div>

            {sent ? (
              <p className="gate-sent">Записали. Спасибо — мы это читаем: по таким строчкам понятно, кого с кем знакомить и чего людям не хватает в продукте.</p>
            ) : (
              <form className="gate-form" onSubmit={submit}>
                <label htmlFor="gate-note">Что хочешь собрать?</label>
                <textarea
                  id="gate-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Пара строк: продукт, идея, что уже есть…"
                  rows={3}
                  maxLength={2000}
                />
                <button className="btn primary" disabled={!note.trim() || sending}>Отправить</button>
              </form>
            )}
            {error && <div className="team-note">{error}</div>}

            <p className="gate-hint">
              Если тебя пригласили в команду — открой ссылку из приглашения: она примется сейчас,
              а заработает после активации.
            </p>
          </>
        )}

        <details className="gate-how">
          <summary>Как это устроено</summary>
          <p>
            Песочница — обычный Linux-сервер в нашем облаке: отдельный пользователь и свой агент.
            Активация — два шага: очередь на создание машины, и агент сам подключается к хабу под
            твоим именем. Кодера в ней ты заводишь свой — заходишь в терминал и логинишься своей
            подпиской. Чудес нет: сессия — процесс Codex или Claude Code в папке проекта, а эта
            вкладка — пульт к нему.
          </p>
          {/* The one thing waiting does not have to block. Said here rather
              than as a button, because the honest half of it — that the
              enrollment code is refused until activation (`403
              access_not_active`) — matters more than the offer: someone who
              installs the agent now and cannot enroll it concludes the product
              is broken, not that they are early. */}
          <p>
            Пока ждёшь, можно поставить приложения — <a href="/#apps">Mac, Windows и iPhone</a>.
            Они дождутся активации вместе с тобой. А вот подключить свою машину заранее не выйдет:
            код подключения выдаётся только после активации.
          </p>
        </details>

        <button className="gate-out" onClick={onLogout}>Выйти</button>
      </div>
    </div>
  );
}

/** «2 сентября» from a hub timestamp. The hub writes milliseconds everywhere
 *  else (`lastSeen`, `joinedAt`); seconds are tolerated in case this row is
 *  the one that does not. */
function sinceLabel(ts?: number): string {
  if (!ts) return 'сегодня';
  return new Date(toMillis(ts)).toLocaleDateString('ru', { day: 'numeric', month: 'long' });
}

/** The registration form: who you are and why you want Hegai Code. */
export function RegistrationFormView({ onSubmit }: { onSubmit: (form: RegistrationForm) => Promise<void> }) {
  const [role, setRole] = useState('');
  const [purpose, setPurpose] = useState('');
  const [company, setCompany] = useState('');
  const [telegram, setTelegram] = useState('');
  const [source, setSource] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const ready = role.trim() !== '' && purpose.trim() !== '';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    setError('');
    const form: RegistrationForm = { role: role.trim(), purpose: purpose.trim() };
    if (company.trim()) form.company = company.trim();
    if (telegram.trim()) form.telegram = telegram.trim();
    if (source.trim()) form.source = source.trim();
    try {
      await onSubmit(form);
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
    }
  };
  return (
    <form className="gate-form" onSubmit={submit}>
      <label htmlFor="reg-role">Кто ты и чем занимаешься</label>
      <input id="reg-role" value={role} onChange={(e) => setRole(e.target.value)} maxLength={100} required placeholder="Например: разработчик, основатель студии" />
      <label htmlFor="reg-purpose">Зачем тебе Hegai Code</label>
      <textarea id="reg-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={1000} rows={4} required placeholder="Что хочешь делать: какие проекты, какие агенты, что уже пробовал…" />
      <label htmlFor="reg-company">Компания <small>(если есть)</small></label>
      <input id="reg-company" value={company} onChange={(e) => setCompany(e.target.value)} maxLength={100} />
      <label htmlFor="reg-telegram">Telegram <small>(напишем, когда откроем доступ)</small></label>
      <input id="reg-telegram" value={telegram} onChange={(e) => setTelegram(e.target.value)} maxLength={33} placeholder="@username" autoComplete="off" spellCheck={false} />
      <label htmlFor="reg-source">Откуда узнал о нас <small>(если помнишь)</small></label>
      <input id="reg-source" value={source} onChange={(e) => setSource(e.target.value)} maxLength={100} />
      {error && <div className="team-note" role="alert">{error}</div>}
      <button className="btn primary" disabled={!ready || sending}>{sending ? 'Отправляем…' : 'Отправить'}</button>
    </form>
  );
}
