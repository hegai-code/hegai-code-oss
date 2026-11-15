import { useEffect, useState } from 'react';
import { apiRequest } from './api.js';

/**
 * `/support-login#token=…` — where the one-time link an owner sends to HegAI
 * support lands.
 *
 * The token rides in the URL FRAGMENT, so no server, proxy or access log ever
 * sees it, and this page posts it itself: a link-preview bot that fetches the
 * URL cannot spend it, only a browser running this script can. The fragment is
 * removed from the address bar before anything else happens.
 */
export function SupportLoginPage() {
  const [state, setState] = useState<'working' | 'failed'>('working');
  const [error, setError] = useState('');

  useEffect(() => {
    const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') ?? '';
    history.replaceState(null, '', '/support-login');
    if (!token) {
      setError('В ссылке нет ключа входа. Попросите владельца команды открыть доступ заново.');
      setState('failed');
      return;
    }
    apiRequest('/api/auth/support-login', {
      method: 'POST',
      body: JSON.stringify({ token }),
      fallback: (status) => `Запрос не удался (${status})`,
    })
      .then(() => location.replace('/'))
      .catch((e: Error) => {
        setError(e.message);
        setState('failed');
      });
  }, []);

  return (
    <main className="install-page link-page">
      <section className="install-section">
        <span className="eyebrow eyebrow--mark">Hegai Code · поддержка</span>
        <h1>Вход для поддержки</h1>
        {state === 'working' && <p>Открываем доступ…</p>}
        {state === 'failed' && (
          <div className="link-card">
            <h2>Не получилось войти</h2>
            <p className="attn-text">{error}</p>
            <p className="team-help">Ссылка работает один раз и недолго: если её уже открывали или срок вышел, владелец команды может создать новую в Настройки → «Доступ поддержки».</p>
          </div>
        )}
      </section>
    </main>
  );
}
