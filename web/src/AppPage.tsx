import { useEffect } from 'react';
import { OtherHubHint, PhoneApps, StoreButtons, usePhonePromise } from './components/PhoneApps.js';
import { APP_STORE_URL, appConnectLink, hubAddress, isAndroidUa, isCustomHub, isIosUa, PLAY_URL } from './lib.js';

/**
 * `/app` — what the QR code opens.
 *
 * On code.acme.test a phone goes straight to its store: the apps start there.
 * On a self-hosted hub the store alone is half the way — the app would open on
 * code.acme.test — so the phone stays here: «Открыть в приложении» hands the
 * app this server (`ccremote://connect`), and the store button is next to it
 * for a phone that does not have the app yet. A computer gets both stores.
 */
export function AppPage() {
  const { notifications } = usePhonePromise();
  const custom = isCustomHub();
  const ios = isIosUa();
  const android = isAndroidUa();
  useEffect(() => {
    if (custom) return;
    if (ios) location.replace(APP_STORE_URL);
    else if (android) location.replace(PLAY_URL);
  }, [custom, ios, android]);
  const lead = notifications ? 'Сессии, ответы агенту и уведомления — на телефоне.' : 'Сессии и ответы агенту — на телефоне.';
  if (custom && (ios || android)) {
    const { origin, host } = hubAddress();
    return (
      <div className="auth-screen">
        <div className="auth-card app-page">
          <h1>Приложение Hegai Code</h1>
          <p>{lead}</p>
          <a className="btn primary app-connect" href={appConnectLink(origin)}>Открыть в приложении</a>
          <p className="team-help">Приложение спросит, подключиться ли к серверу <code>{host}</code>, и откроет его вход.</p>
          <p className="team-help">Ещё нет приложения? Установите его и вернитесь на эту страницу.</p>
          <div className="store-buttons">
            <a className="btn" href={ios ? APP_STORE_URL : PLAY_URL}>{ios ? 'App Store' : 'Google Play'}</a>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="auth-screen">
      <div className="auth-card app-page">
        <h1>Приложение Hegai Code</h1>
        <p>{lead}</p>
        {/* A customer's hub: the hint below says «отсканируйте код» — so the
            code is on this page too (a computer opening /app by hand). */}
        {custom ? <PhoneApps /> : <><StoreButtons /><OtherHubHint /></>}
      </div>
    </div>
  );
}
