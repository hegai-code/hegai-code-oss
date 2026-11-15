import { useMemo, useState } from 'react';
import { LocalLoginForm } from './SignInScreen.js';
import { localNativeLogin } from './localAuth.js';
import { nativeStartHref, parseNativeSignIn } from './nativeSignIn.js';
import { usePublicConfig } from './publicConfig.js';

/**
 * `/native-signin?native=1` or `?android=1&code_challenge=…&client_state=…` —
 * the hub's own sign-in, opened by the iOS / Android app in the system auth
 * browser. It offers the ways in the hub has switched on; every one of them
 * ends at the app's custom scheme (`ccremote://auth`, `hegai-code://auth`):
 * the provider links go through `begin_login`/`finish_login` like Google does,
 * the local form through `POST /api/auth/local/native-handoff`. Telegram is not
 * offered here — the apps run its number-matching flow themselves.
 */
export function NativeSignInPage() {
  const request = useMemo(() => parseNativeSignIn(location.search), []);
  const config = usePublicConfig();
  const [redirect, setRedirect] = useState('');

  let body;
  if (!request) {
    body = <p>Эту страницу открывает приложение Hegai Code. Откройте вход из приложения.</p>;
  } else if (config === undefined) {
    body = <p>Загружаем…</p>;
  } else if (!config) {
    body = <p>Сервер не ответил. Закройте окно и попробуйте ещё раз.</p>;
  } else if (redirect) {
    body = <>
      <p>Вход выполнен. Если приложение не открылось само, нажмите кнопку.</p>
      <a className="btn primary" href={redirect}>Вернуться в приложение</a>
    </>;
  } else {
    const { auth } = config;
    const providers = !!(auth.oidc || auth.google || auth.github);
    body = !auth.local && !providers
      ? <p>На этом сервере не настроен ни один способ входа для приложения. Обратитесь к администратору.</p>
      : <>
        {auth.local && <LocalLoginForm signIn={async (email, password, code) => {
          const target = await localNativeLogin(email, password, code, request);
          setRedirect(target);
          location.assign(target);
        }} />}
        {auth.local && providers && <p className="signin-or">или</p>}
        {providers && <div className="signin-methods">
          {auth.oidc && <a className="btn primary" href={nativeStartHref('oidc', request)}>Войти через {auth.oidc.name}</a>}
          {auth.google && <a className="btn" href={nativeStartHref('google', request)}>Войти через Google</a>}
          {auth.github && <a className="btn" href={nativeStartHref('github', request)}>Войти через GitHub</a>}
        </div>}
      </>;
  }
  return (
    <div className="auth-screen">
      <div className="auth-card signin-card">
        <span className="topbar-brand">{config?.brandName ?? 'Hegai Code'}</span>
        <h1>Вход</h1>
        {body}
      </div>
    </div>
  );
}
