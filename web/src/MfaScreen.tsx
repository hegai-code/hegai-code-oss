import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { mfaApi, mfaWords, type MfaEnrolment, type MfaState } from './mfaApi.js';
import { CopyButton } from './components/CopyButton.js';

/**
 * The screen between a first-factor sign-in and the product: the hub has a
 * session for this person but it is PENDING until a second factor is shown
 * (`GET /api/auth/mfa/state`). Two shapes — type the code of the authenticator
 * the person already has, or (an admin the hub holds to a second factor, with
 * none yet) a plain «blocked» message: enrolment is never offered from a
 * pending session, only from Настройки of an open one.
 *
 * A native app's sign-in rides the same screen: `next` is the hand-off the hub
 * held back (`ccremote://…`, `hegai-code://…`) and the page goes there once
 * the factor is accepted.
 */

/** Where to go once the second factor is accepted. */
function proceed(next: string | undefined): void {
  // No hand-off: stay where the person was heading (a service sign-in deep
  // link `/w/…`), now with a session that opens.
  if (next) location.assign(next);
  else location.reload();
}

function VerifyForm({ onSignOut }: { onSignOut: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    mfaApi.verify(code.trim()).then(
      (done) => proceed(done.next),
      (err) => {
        setError(mfaWords(err));
        setBusy(false);
      },
    );
  };
  return <>
    <h1>Подтвердите вход</h1>
    <p>Введите шесть цифр из приложения-аутентификатора или один из кодов восстановления.</p>
    <form className="signin-form" onSubmit={submit}>
      <label>Код
        <input name="code" inputMode="text" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="one-time-code" autoFocus required
          placeholder="6 цифр или код восстановления" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {error && <p className="attn-text" role="alert">{error}</p>}
      <button className="btn primary" type="submit" disabled={busy || !code.trim()}>{busy ? 'Проверяем…' : 'Войти'}</button>
      <button className="btn" type="button" onClick={onSignOut}>Выйти</button>
    </form>
  </>;
}

function Blocked({ onSignOut }: { onSignOut: () => void }) {
  return <>
    <h1>Нужен второй фактор</h1>
    <p>
      Для этого аккаунта обязателен второй фактор, но аутентификатор ещё не подключён. Подключить его можно только из
      уже открытой сессии — обратитесь к администратору хаба.
    </p>
    <button className="btn" onClick={onSignOut}>Выйти</button>
  </>;
}

export function MfaScreen({ state, brand, onSignOut }: { state: MfaState; brand: string; onSignOut: () => void }) {
  return (
    <div className="auth-screen">
      <div className="auth-card signin-card">
        <span className="topbar-brand">{brand}</span>
        {state.mfa === 'blocked' ? <Blocked onSignOut={onSignOut} /> : <VerifyForm onSignOut={onSignOut} />}
      </div>
    </div>
  );
}

/**
 * «Двухфакторная защита» in Настройки: on/off, new recovery codes. Turning it
 * on keeps the other sign-ins of this person as they are — they are not asked
 * for a code until they sign in again.
 */
export function TwoFactorCard() {
  const [state, setState] = useState<MfaState | undefined>();
  const [info, setInfo] = useState<MfaEnrolment | undefined>();
  const [codes, setCodes] = useState<string[] | undefined>();
  const [action, setAction] = useState<'disable' | 'recovery' | undefined>();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => mfaApi.state().then(setState, () => undefined);
  useEffect(() => { void load(); }, []);
  if (!state) return null;
  const fail = (err: unknown) => {
    setError(mfaWords(err));
    setBusy(false);
  };
  const begin = () => {
    setError('');
    mfaApi.begin().then(setInfo, fail);
  };
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    mfaApi.confirm(code.trim()).then((r) => {
      setBusy(false);
      setCodes(r.recoveryCodes);
      setInfo(undefined);
      setCode('');
      void load();
    }, fail);
  };
  const run = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const c = code.trim();
    const done = action === 'disable'
      ? mfaApi.disable(c).then(() => setCodes(undefined))
      : mfaApi.newRecoveryCodes(c).then((r) => setCodes(r.recoveryCodes));
    done.then(() => {
      setBusy(false);
      setAction(undefined);
      setCode('');
      void load();
    }, fail);
  };
  return <section className="team-card settings-section">
    <h3>Двухфакторная защита</h3>
    {!state.enrolled && !info && <>
      <p className="team-help">
        Код из приложения-аутентификатора при каждом входе. На других устройствах при следующем действии попросим
        код. Администратору подключить аутентификатор можно только по одноразовой ссылке от оператора хаба.
      </p>
      <div className="team-actions"><button className="btn primary" onClick={begin}>Включить</button></div>
    </>}
    {info && <form className="signin-form" onSubmit={confirm}>
      <p>Отсканируйте код приложением-аутентификатором и введите шесть цифр.</p>
      {info.qrSvg && <img className="setup-qr" alt="QR-код для приложения-аутентификатора"
        src={`data:image/svg+xml;utf8,${encodeURIComponent(info.qrSvg)}`} width={224} height={224} />}
      <p className="team-help">Ключ для ручного ввода: <code className="setup-secret">{info.secret}</code></p>
      <label>Код из приложения
        <input inputMode="numeric" autoComplete="one-time-code" required placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <div className="team-actions">
        <button className="btn primary" type="submit" disabled={busy || !code.trim()}>Подтвердить</button>
        <button className="btn" type="button" onClick={() => { setInfo(undefined); setCode(''); setError(''); }}>Отмена</button>
      </div>
    </form>}
    {state.enrolled && !action && <>
      <p className="team-help">
        Включена{state.adminRequired ? ' (для администратора обязательна)' : ''}.
        {state.recoveryLeft != null && ` Кодов восстановления осталось: ${state.recoveryLeft}.`}
      </p>
      <div className="team-actions">
        <button className="btn" onClick={() => { setAction('recovery'); setError(''); }}>Новые коды восстановления</button>
        {state.canDisable && <button className="btn danger" onClick={() => { setAction('disable'); setError(''); }}>Отключить</button>}
      </div>
    </>}
    {action && <form className="signin-form" onSubmit={run}>
      <p>{action === 'disable' ? 'Чтобы отключить защиту, введите текущий код из приложения.' : 'Введите текущий код из приложения — старые коды восстановления перестанут работать.'}</p>
      <label>Код из приложения
        <input inputMode="text" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="one-time-code" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <div className="team-actions">
        <button className={`btn ${action === 'disable' ? 'danger' : 'primary'}`} type="submit" disabled={busy || !code.trim()}>
          {action === 'disable' ? 'Отключить' : 'Выпустить новые'}
        </button>
        <button className="btn" type="button" onClick={() => { setAction(undefined); setCode(''); setError(''); }}>Отмена</button>
      </div>
    </form>}
    {codes && <>
      <p className="team-help">Коды восстановления — каждый работает один раз. Сохраните их: больше они нигде не покажутся. На других устройствах при следующем действии попросим код.</p>
      <div className="recovery-codes">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div className="team-actions">
        <CopyButton className="btn" text={codes.join('\n')} label="Скопировать коды" />
        <button className="btn" onClick={() => setCodes(undefined)}>Я сохранил</button>
      </div>
    </>}
    {error && <div className="team-note">{error}</div>}
  </section>;
}

/**
 * `/mfa-enroll#token=…` — the one-time link an operator of the hub prints
 * (`cc-remote-server mfa-enroll-link`). A platform admin may attach an
 * authenticator only from the ten-minute session this opens. The token is in the
 * URL fragment, read once, and the address bar is wiped.
 */
export function MfaEnrollPage() {
  const token = useMemo(() => new URLSearchParams(location.hash.replace(/^#/, '')).get('token') ?? '', []);
  const [phase, setPhase] = useState<'opening' | 'open' | 'dead'>('opening');
  // Once per mount (React StrictMode runs effects twice in dev): the link is
  // single use, so a second request would answer «dead» for a live session.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    // A reload after the link was spent: the ten-minute session cookie is
    // still there and says so.
    mfaApi.state().then(
      (s) => s.canEnrol,
      () => false,
    ).then((already) => {
      if (already) {
        setPhase('open');
        return;
      }
      if (!token) {
        setPhase('dead');
        return;
      }
      mfaApi.openEnrollLink(token).then(() => setPhase('open'), () => setPhase('dead'));
    });
  }, [token]);
  return (
    <div className="auth-screen">
      <div className="auth-card signin-card">
        <span className="topbar-brand">Hegai Code</span>
        {phase === 'opening' && <p>Проверяем ссылку…</p>}
        {phase === 'dead' && <>
          <h1>Ссылка не подошла</h1>
          <p>Она устарела, уже использована или скопирована не целиком. Попросите оператора хаба выдать новую.</p>
          <a className="btn" href="/">На главную</a>
        </>}
        {phase === 'open' && <>
          <h1>Подключение аутентификатора</h1>
          <p>Сессия открыта на 10 минут — этого хватит, чтобы подключить приложение.</p>
          <TwoFactorCard />
        </>}
      </div>
    </div>
  );
}
