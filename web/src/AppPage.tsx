import { useEffect } from 'react';
import { APP_STORE_URL, isAndroidUa, isIosUa, PLAY_URL } from './lib.js';
import { OtherHubHint, StoreButtons, usePhonePromise } from './components/PhoneApps.js';

/**
 * `/app` — what the QR code opens. A phone goes straight to its store; a
 * computer (someone who followed the link by hand) gets both buttons.
 */
export function AppPage() {
  const { notifications } = usePhonePromise();
  useEffect(() => {
    if (isIosUa()) location.replace(APP_STORE_URL);
    else if (isAndroidUa()) location.replace(PLAY_URL);
  }, []);
  return (
    <div className="auth-screen">
      <div className="auth-card app-page">
        <h1>Приложение Hegai Code</h1>
        <p>{notifications ? 'Сессии, ответы агенту и уведомления — на телефоне.' : 'Сессии и ответы агенту — на телефоне.'}</p>
        <StoreButtons />
        <OtherHubHint />
      </div>
    </div>
  );
}
