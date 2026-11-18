import { useState } from 'react';
import { APP_STORE_URL, hubAddress, isCustomHub, PLAY_URL } from '../lib.js';
import { isExternal, usePublicConfig } from '../publicConfig.js';

/**
 * The phone clients: a QR code that opens `/app` (the server route
 * `/app/qr.svg` encodes `${origin}/app`; on code.acme.test `/app` sends iOS to
 * the App Store and Android to Google Play, on a self-hosted hub it offers
 * «Открыть в приложении» with this server), the two store buttons, and — on a
 * hub that is not code.acme.test — how the app learns which server to use.
 *
 * Used by the onboarding's last step, the «Приложения» tab and the public
 * `/app` page, so the three never say different things.
 */
export function StoreButtons() {
  return (
    <div className="store-buttons">
      <a className="btn" href={APP_STORE_URL} target="_blank" rel="noreferrer">App Store</a>
      <a className="btn" href={PLAY_URL} target="_blank" rel="noreferrer">Google Play</a>
    </div>
  );
}

export function OtherHubHint() {
  if (!isCustomHub()) return null;
  const host = hubAddress().host;
  // The apps open on code.acme.test. Current builds take this server from the
  // QR (camera → `/app` → «Открыть в приложении», or the app's own scanner on
  // its sign-in screen); older ones only from a typed address, and the two
  // apps name that door differently.
  return (
    <div className="phone-hub">
      <p className="team-help">Приложение подключится к этому серверу: откройте код камерой и нажмите «Открыть в приложении», или на экране входа в приложении у строки «Сервер» нажмите «Свой сервер» (Android — «Другой сервер») и отсканируйте код. Адрес сервера: <code>{host}</code></p>
      <p className="team-help"><small>В старых версиях приложения адрес вводится руками: iPhone — Войти → Другой хаб / токен, Android — Другой сервер.</small></p>
    </div>
  );
}

/** What the phone apps do on this hub. Push needs the vendor's relay, which a
 *  self-hosted hub may not have — the public config does not say, so on one we
 *  do not promise notifications. */
export function usePhonePromise(): { notifications: boolean } {
  return { notifications: !isExternal(usePublicConfig()) };
}

export function PhoneApps({ qr = true }: { qr?: boolean }) {
  const [qrOk, setQrOk] = useState(true);
  const { notifications } = usePhonePromise();
  return (
    <div className="phone-apps">
      {qr && qrOk && (
        <img className="phone-qr" src="/app/qr.svg" width={144} height={144} alt="QR-код: открыть приложение на телефоне" onError={() => setQrOk(false)} />
      )}
      <div className="phone-apps-body">
        <p className="team-help">{qr && qrOk ? (isCustomHub() ? 'Наведите камеру телефона на код — откроется страница приложения для этого сервера. Или установите его из магазина.' : 'Наведите камеру телефона на код — откроется нужный магазин. Или выберите его сами.') : `Приложение для iPhone и Android: сессии и ответы агенту${notifications ? ' и уведомления' : ''}.`}</p>
        <StoreButtons />
        <OtherHubHint />
      </div>
    </div>
  );
}
