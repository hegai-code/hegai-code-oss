import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { PublicConfig } from '@cc-remote/shared';
import { ApiError } from './api.js';
import { githubStartHref, googleStartHref, oidcStartHref, OSS_REPO_URL } from './lib.js';
import { localLogin } from './localAuth.js';
import { isExternal, usePublicConfig } from './publicConfig.js';
import { storageGet } from './storage.js';
import { teamApi } from './teamApi.js';
import { TelegramSignInButton } from './components/TelegramSignIn.js';

/**
 * The sign-in screen of a customer's own hub (the external edition): the
 * product under the customer's name, and only the ways in the hub has switched
 * on (`/api/public-config`). The internal hub keeps its landing page.
 */

export function words(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Нет связи с сервером. Проверьте сеть и попробуйте ещё раз.';
}

/** Email, password and the six digits from the authenticator app (or a
 *  recovery code). One failure sentence by design — the hub does not say
 *  which part was wrong. */
export function LocalLoginForm({ signIn }: { signIn?: (email: string, password: string, code: string) => Promise<void> } = {}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    // Default: a full load, not a state change — the shell starts from the new cookie.
    const run = signIn ?? ((em, pw, cd) => localLogin(em, pw, cd).then(() => location.assign('/')));
    run(email.trim(), password, code.trim()).then(
      () => undefined,
      (err) => {
        setError(words(err));
        setBusy(false);
      },
    );
  };
  return (
    <form className="signin-form" onSubmit={submit}>
      <label>Почта
        <input type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>Пароль
        <input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label>Код из приложения-аутентификатора
        <input name="code" inputMode="numeric" autoComplete="one-time-code" required placeholder="6 цифр или код восстановления" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {error && <p className="attn-text" role="alert">{error}</p>}
      <button className="btn primary" type="submit" disabled={busy || !email || !password || !code}>{busy ? 'Входим…' : 'Войти'}</button>
    </form>
  );
}

/** The buttons for every provider-based way in that is on. */
function ProviderButtons({ config }: { config: PublicConfig }) {
  const { auth } = config;
  const buttons: ReactNode[] = [];
  if (auth.oidc) buttons.push(<a key="oidc" className="btn primary" href={oidcStartHref()}>Войти через {auth.oidc.name}</a>);
  if (auth.google) buttons.push(<a key="google" className="btn" href={googleStartHref()}>Войти через Google</a>);
  if (auth.github) buttons.push(<a key="github" className="btn" href={githubStartHref()}>Войти через GitHub</a>);
  if (auth.telegram) buttons.push(<TelegramSignInButton key="telegram" />);
  if (!buttons.length) return null;
  return <div className="signin-methods">{buttons}</div>;
}

/** Every way in this hub offers, drawn from its public config. */
export function SignInMethods({ config }: { config: PublicConfig }) {
  const providers = !!(config.auth.oidc || config.auth.google || config.auth.github || config.auth.telegram);
  if (!config.auth.local && !providers) {
    return (
      <p>
        На этом сервере не настроен ни один способ входа. Владелец получает ссылку для первой настройки в журнале хаба
        (<code>docker compose logs hub</code>) или командой <code>setup-link</code>.
      </p>
    );
  }
  return <>
    {config.auth.local && <LocalLoginForm />}
    {config.auth.local && providers && <p className="signin-or">или</p>}
    <ProviderButtons config={config} />
  </>;
}

/** A place that asks someone to sign in (the `/link` and `/access` pages): on
 *  the external edition the hub's own methods, otherwise exactly `fallback`. */
export function SignInChoice({ fallback }: { fallback: ReactNode }) {
  const config = usePublicConfig();
  return isExternal(config) && config ? <SignInMethods config={config} /> : <>{fallback}</>;
}

/** «Вас пригласили в …» above the sign-in form when the page was opened from an
 *  invitation link (`?invite=`, or the one the shell kept while signed out). */
export function InviteNotice() {
  const [team, setTeam] = useState<{ workspaceName: string; inviterName: string; email: string } | null>(null);
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('invite') ?? storageGet('cc-pending-invite');
    if (token) teamApi.invitePreview(token).then(setTeam, () => undefined);
  }, []);
  if (!team) return null;
  return <p className="team-help">Вас пригласили в «{team.workspaceName}» — войдите{team.email ? ` как ${team.email}` : ''}, чтобы принять приглашение.</p>;
}

export function SignInScreen({ config }: { config: PublicConfig }) {
  return (
    <div className="auth-screen">
      <div className="auth-card signin-card">
        <span className="topbar-brand">{config.brandName}</span>
        <h1>Вход</h1>
        <InviteNotice />
        <SignInMethods config={config} />
        <p className="team-help signin-source"><a href={OSS_REPO_URL} target="_blank" rel="noreferrer">Исходный код Hegai Code на GitHub</a></p>
      </div>
    </div>
  );
}
