import { useEffect, useRef, useState } from 'react';
import type { TelegramLoginStart } from '@cc-remote/shared';
import { Check, X } from '../icons.js';
import { CopyButton } from './CopyButton.js';
import { teamApi } from '../teamApi.js';
import {
  finishTelegramLink,
  forgetTelegramSignIn,
  pollTelegramLogin,
  readTelegramSignIn,
  rememberTelegramSignIn,
  startTelegramLogin,
  telegramLoginError,
  telegramPollEnd,
  TELEGRAM_SIGN_IN_EVENT,
  type TelegramIntent,
  type TelegramSignIn as SignedIn,
} from '../telegramLogin.js';

type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; login: TelegramLoginStart }
  | { kind: 'confirm_link'; login: TelegramLoginStart; telegram: string }
  | { kind: 'linking'; login: TelegramLoginStart; telegram: string }
  | { kind: 'signed_in' }
  | { kind: 'failed'; message: string };

/** How long the page waits before calling a login dead on its own. Measured
 *  on THIS device from the start, not against the hub's clock (a clock ten
 *  minutes fast would otherwise never poll at all); the hub's own `expired`
 *  normally arrives first — its TTL is 10 minutes. */
const LOCAL_DEADLINE_MS = 11 * 60 * 1000;

/**
 * The dialog behind «Войти через Telegram» (and «Привязать Telegram» in
 * Настройки). The number is the point of it: the person presses the SAME
 * number in the bot, which is what stops a login someone else started from
 * going through. So it is the biggest thing on the dialog.
 */
export function TelegramSignInDialog({
  intent,
  onClose,
  onLinked,
}: {
  intent: TelegramIntent;
  onClose: () => void;
  /** A link was made; the `@username` it was made with, and the account it
   *  was moved off when it used to open another (empty) one. */
  onLinked?: (telegram: string, movedFrom?: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  // Set on EVERY mount: StrictMode mounts, unmounts and mounts again, and a
  // flag only ever cleared would leave the dialog stuck on «Готовим вход…».
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Start (and restart) a login. A superseded start is dropped, so a second
  // mount's request cannot overwrite the first one's state.
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'starting' });
    startTelegramLogin(intent)
      .then((login) => { if (!cancelled) setPhase({ kind: 'waiting', login }); })
      .catch((error) => { if (!cancelled) setPhase({ kind: 'failed', message: telegramLoginError(error) }); });
    return () => { cancelled = true; };
  }, [intent, attempt]);

  // Poll while waiting. A failed poll (network) just tries again; the hub
  // decides when the login is over.
  const login = phase.kind === 'waiting' ? phase.login : undefined;
  useEffect(() => {
    if (!login) return;
    const deadline = Date.now() + LOCAL_DEADLINE_MS;
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (Date.now() > deadline) {
        setPhase({ kind: 'failed', message: telegramPollEnd('expired') });
        return;
      }
      try {
        const result = await pollTelegramLogin(login.pollToken);
        // An approval is acted on even if the dialog was closed meanwhile:
        // the hub has ALREADY set the session cookie with this very answer,
        // and the tab must not drift into that account without the banner
        // saying whose it is.
        if (result.status === 'approved') {
          rememberTelegramSignIn({ telegram: result.telegram, name: result.account.displayName, userId: result.userId });
          if (alive.current) setPhase({ kind: 'signed_in' });
          location.reload();
          return;
        }
        if (stopped || !alive.current) return;
        if (result.status === 'confirm_link') {
          setPhase({ kind: 'confirm_link', login, telegram: result.telegram });
          return;
        }
        if (result.status !== 'pending') {
          setPhase({ kind: 'failed', message: telegramPollEnd(result.status) });
          return;
        }
      } catch {
        // offline for a moment: keep waiting
      }
      if (!stopped) timer = window.setTimeout(tick, Math.max(1, login.interval) * 1000);
    };
    timer = window.setTimeout(tick, Math.max(1, login.interval) * 1000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [login]);

  const confirmLink = (current: { login: TelegramLoginStart; telegram: string }) => {
    setPhase({ kind: 'linking', ...current });
    finishTelegramLink(current.login.pollToken)
      .then(({ telegram, movedFrom }) => {
        if (!alive.current) return;
        onLinked?.(telegram || current.telegram, movedFrom);
        onClose();
      })
      .catch((error) => { if (alive.current) setPhase({ kind: 'failed', message: telegramLoginError(error) }); });
  };

  // Escape closes, like every other dialog here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = intent === 'link' ? 'Привязка Telegram' : 'Вход через Telegram';
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal tg-login" role="dialog" aria-modal="true" aria-labelledby="tg-login-title">
        <div className="eyebrow eyebrow--mark" id="tg-login-title">{title}</div>

        {phase.kind === 'starting' && <p className="tg-login-lead">Готовим вход…</p>}

        {phase.kind === 'waiting' && <>
          <p className="tg-login-lead">
            Откройте бота <b>@{phase.login.bot}</b> и нажмите в нём это число:
          </p>
          <div className="tg-login-match" aria-label={`Число для Telegram: ${phase.login.match.split('').join(' ')}`}>
            {phase.login.match}
          </div>
          <div className="tg-login-actions">
            <a className="btn primary" href={phase.login.url} target="_blank" rel="noopener noreferrer" autoFocus>Открыть Telegram</a>
          </div>
          <p className="tg-login-wait" role="status">Ждём подтверждения в Telegram…</p>
          <p className="tg-login-hint">
            Telegram только на телефоне? Откройте эту ссылку там — число то же:
          </p>
          <div className="tg-login-link">
            <code>{phase.login.url}</code>
            <CopyButton className="btn" text={phase.login.url} label="Скопировать" />
          </div>
        </>}

        {(phase.kind === 'confirm_link' || phase.kind === 'linking') && <>
          <p className="tg-login-lead">
            В Telegram подтвердил <b>{phase.telegram}</b>. Это ваш аккаунт? После привязки в эту учётку
            можно будет входить через него.
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={onClose} disabled={phase.kind === 'linking'}><X size={15} /> Нет, не мой</button>
            <button className="btn primary" onClick={() => confirmLink(phase)} disabled={phase.kind === 'linking'}>
              <Check size={15} /> Да, привязать
            </button>
          </div>
        </>}

        {phase.kind === 'signed_in' && <p className="tg-login-lead">Вход подтверждён, открываем…</p>}

        {phase.kind === 'failed' && <>
          <p className="tg-login-lead" role="alert">{phase.message}</p>
          <div className="modal-actions">
            <button className="btn primary" onClick={() => setAttempt((n) => n + 1)}>Начать заново</button>
          </div>
        </>}

        {phase.kind !== 'confirm_link' && phase.kind !== 'linking' && (
          <div className="modal-actions tg-login-close">
            <button className="btn" onClick={onClose}>Отмена</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A «Войти через Telegram» button with its dialog. */
export function TelegramSignInButton({ className = 'btn', label = 'Войти через Telegram' }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
    {open && <TelegramSignInDialog intent="login" onClose={() => setOpen(false)} />}
  </>;
}

/** The remembered Telegram sign-in that has not been acknowledged yet, kept
 *  in step with the banner (a page can hold back an action until it is). */
export function useUnacknowledgedTelegramSignIn(): SignedIn | null {
  const [info, setInfo] = useState<SignedIn | null>(() => readTelegramSignIn());
  useEffect(() => {
    const sync = () => setInfo(readTelegramSignIn());
    window.addEventListener(TELEGRAM_SIGN_IN_EVENT, sync);
    return () => window.removeEventListener(TELEGRAM_SIGN_IN_EVENT, sync);
  }, []);
  return info;
}

/**
 * «Вы вошли через Telegram как @x» — once, right after a Telegram sign-in,
 * with a way out. The last line against a code seen on someone else's
 * screen: if a stranger pressed first, this page is now signed into THEIR
 * account, and this is where the person finds out. `userId`, when the page
 * knows who is signed in, keeps it from ever showing over another account.
 */
export function TelegramSignedInBanner({ userId }: { userId?: string }) {
  const info = useUnacknowledgedTelegramSignIn();
  const [error, setError] = useState('');
  const mismatch = !!info && !!userId && info.userId !== userId;
  useEffect(() => { if (mismatch) forgetTelegramSignIn(); }, [mismatch]);
  if (!info || mismatch) return null;
  const notMe = () => {
    setError('');
    // The flag goes only once the session is really gone: if signing out
    // failed, the way out must still be on the screen.
    teamApi.logout().then(
      () => location.reload(),
      () => setError('Не получилось выйти — нажмите ещё раз.'),
    );
  };
  return (
    <div className="tg-signed-in" role="status">
      <span>
        Вы вошли через Telegram как <b>{info.telegram}</b>{info.name ? <> · {info.name}</> : null}.
        {error && <> <span className="attn-text">{error}</span></>}
      </span>
      <span className="tg-signed-in-actions">
        <button className="btn" onClick={notMe}>Это не я — выйти</button>
        <button className="btn primary" onClick={forgetTelegramSignIn}>Понятно</button>
      </span>
    </div>
  );
}
