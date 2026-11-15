import { useEffect, useState } from 'react';
import { apiRequest } from './api.js';
import { googleStartHref } from './lib.js';
import { storageSet } from './storage.js';
import { TelegramSignInButton, useUnacknowledgedTelegramSignIn } from './components/TelegramSignIn.js';
import { SignInChoice } from './SignInScreen.js';

/**
 * `/link` — the page a machine sends a person to.
 *
 * The other half of the one-command install: the agent on a machine with no
 * credential asked the hub for a code and printed «откройте
 * code.acme.test/link и введите K7Q4-M2ZP». Here the person, signed in on
 * any device, sees what asked — its name, its OS, where the request came
 * from — and says yes or no. Yes enrolls the machine as theirs, exactly as a
 * typed enrollment code would, and the machine picks its credential up on
 * its next poll.
 *
 * Nothing on this page is trusted from the URL beyond the code itself: what
 * the machine claims about itself comes from the hub's stored request, and
 * the button is the only thing that enrolls. That is the whole defence
 * against the classic device-code phishing — a stranger cannot make a code
 * do anything without a person reading the machine's name and pressing.
 */

type Info = {
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'used';
  machine: { name?: string; os?: string; agentVersion?: string };
  clientIp?: string | null;
  createdAt: number;
  expiresAt: number;
};

const PENDING_KEY = 'cc-pending-link';

function codeFromUrl(): string {
  const c = new URLSearchParams(location.search).get('c') ?? '';
  return c.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
}

function pretty(code: string): string {
  const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4, 8)}` : c;
}

const OS_LABEL: Record<string, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

export function LinkPage() {
  const [code, setCode] = useState(codeFromUrl);
  const [input, setInput] = useState(() => pretty(codeFromUrl()));
  const [state, setState] = useState<'idle' | 'loading' | 'anon' | 'inactive' | 'notfound' | 'ready' | 'approving' | 'approved' | 'denied' | 'error'>('idle');
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  // Just signed in through Telegram and not yet confirmed who that is: a
  // stranger who pressed the number off this screen first would otherwise
  // get this machine — terminal, files and all — with one more click.
  const tgPending = useUnacknowledgedTelegramSignIn();
  const [result, setResult] = useState<{ machineId: string; name?: string } | null>(null);

  // Look the code up. A 401 means «sign in first»: the code is remembered so
  // the SSO round trip brings the person straight back here.
  useEffect(() => {
    if (code.length < 8) {
      setState('idle');
      return;
    }
    let alive = true;
    setState('loading');
    fetch(`/api/enrollments/request/${encodeURIComponent(code)}`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401) {
          // No storage: the URL still carries it.
          storageSet(PENDING_KEY, code);
          setState('anon');
          return;
        }
        if (r.status === 403) {
          setState('inactive');
          return;
        }
        if (r.status === 404) {
          setState('notfound');
          return;
        }
        if (!r.ok) throw new Error(`${r.status}`);
        const body = (await r.json()) as Info;
        setInfo(body);
        setState(body.state === 'pending' ? 'ready' : body.state === 'approved' || body.state === 'used' ? 'approved' : body.state === 'denied' ? 'denied' : 'notfound');
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [code]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = input.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
    if (c.length === 8) {
      history.replaceState(null, '', `/link?c=${c}`);
      setCode(c);
    }
  };

  const decide = async (yes: boolean) => {
    setState('approving');
    setError('');
    try {
      const r = await apiRequest(yes ? '/api/enrollments/approve' : '/api/enrollments/deny', {
        method: 'POST',
        body: JSON.stringify({ userCode: code }),
        fallback: (status) => `${status}`,
      });
      const body = (await r.json().catch(() => ({}))) as { machineId?: string; name?: string };
      if (yes) {
        setResult({ machineId: body.machineId ?? '', name: body.name });
        setState('approved');
      } else {
        setState('denied');
      }
    } catch (e) {
      setError((e as Error).message);
      setState('ready');
    }
  };

  const minutesLeft = info ? Math.max(0, Math.round((info.expiresAt - Date.now()) / 60_000)) : 0;

  return (
    <main className="install-page link-page">
      <section className="install-section">
        <span className="eyebrow eyebrow--mark">Hegai Code · подключение</span>
        <h1>Подключить компьютер</h1>

        {(state === 'idle' || state === 'notfound') && (
          <form className="link-form" onSubmit={submit}>
            <p>
              На компьютере, который вы подключаете, агент показал код вида <code>K7Q4-M2ZP</code>. Введите его —
              и мы покажем, что это за машина, прежде чем подключить.
            </p>
            {state === 'notfound' && <p className="attn-text">Такого кода нет или он истёк. Код живёт десять минут; агент на машине покажет новый сам.</p>}
            <div className="link-row">
              <input
                id="link-code"
                value={input}
                onChange={(e) => setInput(pretty(e.target.value))}
                placeholder="K7Q4-M2ZP"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              <button className="btn primary" type="submit" disabled={input.replace(/[^A-Za-z0-9]/g, '').length < 8}>
                Найти
              </button>
            </div>
          </form>
        )}

        {state === 'loading' && <p>Ищем код…</p>}

        {state === 'anon' && (
          <>
            <p>
              Код <b>{pretty(code)}</b> найден. Чтобы подключить машину, войдите — после входа вы вернётесь сюда.
            </p>
            <SignInChoice fallback={
              <span className="link-signin">
                <a className="btn primary" href={googleStartHref()}>Войти через Google</a>
                <TelegramSignInButton />
              </span>
            } />
          </>
        )}

        {state === 'inactive' && <p>Доступ к Hegai Code ещё не открыт для вашего аккаунта — подключать машины пока нельзя.</p>}

        {(state === 'ready' || state === 'approving') && info && (
          <div className="link-card">
            <h2>Эта машина просит подключения</h2>
            <dl className="link-facts">
              <dt>Имя</dt><dd>{info.machine.name ?? '—'}</dd>
              <dt>Система</dt><dd>{OS_LABEL[info.machine.os ?? ''] ?? info.machine.os ?? '—'}{info.machine.agentVersion ? ` · агент ${info.machine.agentVersion}` : ''}</dd>
              <dt>Откуда</dt><dd>{info.clientIp ?? 'адрес не передан'}</dd>
              <dt>Код</dt><dd><code>{pretty(code)}</code> · действует ещё {minutesLeft} мин</dd>
            </dl>
            <p className="team-help">
              Подключайте только машину, которую сами только что настраивали: она станет вашей — с терминалом, файлами и
              сессиями, а сервер Hegai Code сможет выполнять на ней команды от имени её пользователя. Если вы не
              запускали установку на такой машине, нажмите «Не моя».
            </p>
            {error && <p className="attn-text">{error}</p>}
            {tgPending && (
              <p className="attn-text">
                Вы только что вошли через Telegram как <b>{tgPending.telegram}</b>. Подтвердите вверху, что это вы, —
                тогда машину можно будет подключить.
              </p>
            )}
            <div className="link-actions">
              <button className="btn primary" type="button" disabled={state === 'approving' || !!tgPending} onClick={() => void decide(true)}>
                {state === 'approving' ? '…' : 'Подключить этот компьютер'}
              </button>
              <button className="btn" type="button" disabled={state === 'approving'} onClick={() => void decide(false)}>
                Не моя
              </button>
            </div>
          </div>
        )}

        {state === 'approved' && (
          <div className="link-card">
            <h2>Готово</h2>
            <p>
              {result?.name ? <>Машина <b>{result.name}</b> подключена.</> : <>Машина подключена.</>} Агент заберёт свой ключ за несколько
              секунд и появится на вкладке «Машины». Там же — кнопки «Войти» напротив Claude Code и Codex, если на
              машине ещё нет входа.
            </p>
            <div className="link-actions">
              <a className="btn primary" href="/w/hardware">Открыть «Машины»</a>
              <a className="btn" href="/w/start">Войти в Claude и Codex</a>
            </div>
          </div>
        )}

        {state === 'denied' && (
          <div className="link-card">
            <h2>Отклонено</h2>
            <p>Машина не подключена. Агент на ней покажет новый код через минуту — если это всё-таки ваша машина, введите его.</p>
          </div>
        )}

        {state === 'error' && <p className="attn-text">Не удалось проверить код: {error}. Обновите страницу.</p>}
      </section>
    </main>
  );
}
