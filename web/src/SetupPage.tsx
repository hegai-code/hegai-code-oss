import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { LocalSetupBegin } from '@cc-remote/shared';
import { ApiError } from './api.js';
import { beginSetup, finishSetup } from './localAuth.js';
import { usePublicConfig } from './publicConfig.js';
import { rememberWorkspace } from './shell/workspace.js';
import { teamApi } from './teamApi.js';
import { CopyButton } from './components/CopyButton.js';
import { appConnectLink, isAndroidUa, isIosUa } from './lib.js';

/**
 * `/setup#token=…` — the page the owner's (or an employee's) setup link opens
 * on a customer's own hub: scan the QR code with an authenticator app, choose a
 * password, confirm with the first code, and keep the recovery codes.
 *
 * The token lives in the URL FRAGMENT, so it is never sent to any server by the
 * browser itself; it is read once and the address bar is wiped.
 */

const MIN_PASSWORD = 12;

type Phase =
  | { kind: 'loading' }
  | { kind: 'dead' }
  | { kind: 'form'; info: LocalSetupBegin }
  | { kind: 'recovery'; codes: string[] }
  | { kind: 'done' };

function tokenFromHash(): string {
  return new URLSearchParams(location.hash.replace(/^#/, '')).get('token') ?? '';
}

/** The invitation the setup link carries (`#token=…&invite=…`), if any. */
function inviteFromHash(): string {
  return new URLSearchParams(location.hash.replace(/^#/, '')).get('invite') ?? '';
}

/** On a phone the next step is usually the app, not this tab. Desktop goes
 *  straight in, as before. */
function finish(setPhase: (p: Phase) => void) {
  if (isIosUa() || isAndroidUa()) setPhase({ kind: 'done' });
  else location.assign('/');
}

function words(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Нет связи с сервером. Проверьте сеть и попробуйте ещё раз.';
}

/** `initialPhase` is for `screens.tsx` only (photograph the phone «Готово»). */
export function SetupPage({ initialPhase }: { initialPhase?: Phase } = {}) {
  const config = usePublicConfig();
  const brand = config?.brandName ?? 'Hegai Code';
  // Read before the first paint of the form, then wipe: a reload of this page
  // needs the link again, which is the point.
  const token = useMemo(tokenFromHash, []);
  const invite = useMemo(inviteFromHash, []);
  const [invitedTo, setInvitedTo] = useState<{ workspaceName: string; inviterName: string } | null>(null);
  const [phase, setPhase] = useState<Phase>(initialPhase ?? { kind: 'loading' });
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialPhase) return;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (!token) {
      setPhase({ kind: 'dead' });
      return;
    }
    let live = true;
    if (invite) teamApi.invitePreview(invite).then((p) => live && setInvitedTo(p), () => undefined);
    beginSetup(token).then(
      (info) => live && setPhase({ kind: 'form', info }),
      () => live && setPhase({ kind: 'dead' }),
    );
    return () => {
      live = false;
    };
  }, [token, invite]);

  const submit = (e: FormEvent, enrolled: boolean) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`Пароль короче ${MIN_PASSWORD} символов.`);
      return;
    }
    if (password !== again) {
      setError('Пароли не совпадают.');
      return;
    }
    setBusy(true);
    setError('');
    finishSetup(token, password, code.trim()).then(
      (done) => {
        setBusy(false);
        // The hub accepted the invitation together with the setup; only the
        // team to open first is left to remember.
        if (done.workspaceId) rememberWorkspace(done.workspaceId);
        // No codes were issued when the authenticator already existed.
        if (done.recoveryCodes.length) setPhase({ kind: 'recovery', codes: done.recoveryCodes });
        else finish(setPhase);
      },
      (err) => {
        setError(words(err));
        setBusy(false);
        if (err instanceof ApiError && err.status === 410) setPhase({ kind: 'dead' });
      },
    );
  };

  let body;
  if (phase.kind === 'loading') {
    body = <p>Проверяем ссылку…</p>;
  } else if (phase.kind === 'dead') {
    body = <>
      <h1>Ссылка не подошла</h1>
      <p>Она устарела, уже использована или скопирована не целиком. Попросите владельца сервера выдать новую.</p>
      <a className="btn" href="/">На страницу входа</a>
    </>;
  } else if (phase.kind === 'done') {
    body = <>
      <h1>Готово</h1>
      <p>Вход настроен. Теперь можно открыть приложение {brand} на этом телефоне или продолжить в браузере.</p>
      <div className="signin-methods">
        <a className="btn primary" href={appConnectLink(location.origin)}>Открыть в приложении</a>
        <button className="btn" onClick={() => location.assign('/')}>Продолжить в браузере</button>
      </div>
    </>;
  } else if (phase.kind === 'recovery') {
    const text = phase.codes.join('\n');
    body = <>
      <h1>Коды восстановления</h1>
      <p>
        Если потеряете телефон, войти можно одним из этих кодов — каждый работает один раз. Сохраните их в менеджере
        паролей: больше они нигде не покажутся.
      </p>
      <div className="recovery-codes">{phase.codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div className="signin-methods">
        <CopyButton className="btn" text={text} label="Скопировать коды" />
        <button className="btn primary" onClick={() => finish(setPhase)}>Я сохранил</button>
      </div>
    </>;
  } else {
    const { info } = phase;
    body = <>
      {invitedTo ? <>
        <h1>Приглашение в {invitedTo.workspaceName}</h1>
        <p>{invitedTo.inviterName ? `${invitedTo.inviterName} зовёт` : 'Вас зовут'} вас в команду. Задайте пароль и код — и вы внутри.</p>
      </> : <h1>Настройка входа</h1>}
      <p>Учётная запись: <b>{info.email}</b></p>
      <form className="signin-form" onSubmit={(e) => submit(e, info.enrolled)}>
        {!info.enrolled && <>
          <p>
            1. Откройте приложение-аутентификатор (Google Authenticator, 1Password, Яндекс Ключ…) и отсканируйте код.
          </p>
          {info.qrSvg && (
            <img className="setup-qr" alt="QR-код для приложения-аутентификатора"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(info.qrSvg)}`} width={224} height={224} />
          )}
          {info.secret && (
            <p className="team-help">
              Не получается отсканировать — введите ключ вручную: <code className="setup-secret">{info.secret}</code>
            </p>
          )}
        </>}
        <p>{info.enrolled ? 'Задайте пароль.' : '2. Придумайте пароль.'}</p>
        <label>Пароль (не короче {MIN_PASSWORD} символов)
          <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>Пароль ещё раз
          <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        {info.enrolled ? <>
          <p>Введите шесть цифр из уже подключённого приложения-аутентификатора.</p>
          <label>Код из приложения
            <input inputMode="numeric" autoComplete="one-time-code" required placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        </> : <>
          <p>3. Введите шесть цифр из приложения.</p>
          <label>Код из приложения
            <input inputMode="numeric" autoComplete="one-time-code" required placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        </>}
        {error && <p className="attn-text" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Готово'}</button>
      </form>
    </>;
  }
  return (
    <div className="auth-screen">
      <div className="auth-card signin-card">
        <span className="topbar-brand">{brand}</span>
        {body}
      </div>
    </div>
  );
}
