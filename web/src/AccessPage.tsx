import { useEffect, useMemo, useState } from 'react';
import { CopyButton } from './components/CopyButton.js';
import { apiJsonOrNull } from './api.js';
import { googleStartHref } from './lib.js';
import { TelegramSignInButton } from './components/TelegramSignIn.js';

/** Shape of GET /api/llm-access. The server returns only the caller's own key. */
type Access = {
  hasAccess: boolean;
  configured: boolean;
  /** Absent on hubs that predate the community rollout — an employee. */
  plan?: 'employee' | 'community';
  /** Why there is no key yet, when `hasAccess` is false and it is not "never
   *  provisioned": the person is still on the waitlist, or was suspended. */
  reason?: 'waitlist' | 'suspended';
  email?: string;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  limits?: {
    requests: number | null;
    requestsWindow: string | null;
    requestsUsed: number | null;
    tokens: number | null;
    tokensWindow: string | null;
    tokensUsed: number | null;
  };
  gatewayQuota?: {
    plan?: string | null;
    primary_used_percent?: number | null;
    primary_window_minutes?: number | null;
    primary_reset_at?: number | null;
    secondary_used_percent?: number | null;
    secondary_window_minutes?: number | null;
    secondary_reset_at?: number | null;
    updated_at?: number | null;
  } | null;
};

/** "resets in N дн/ч" from an epoch-seconds reset time. */
function resetIn(atSec?: number | null): string {
  if (!atSec) return '';
  const secs = atSec - Date.now() / 1000;
  if (secs <= 0) return 'скоро';
  const days = Math.floor(secs / 86400);
  if (days >= 1) return `${days} дн.`;
  const hours = Math.max(1, Math.round(secs / 3600));
  return `${hours} ч.`;
}

function windowLabel(minutes?: number | null): string {
  if (!minutes) return 'окна';
  if (minutes >= 10080) return 'недели';
  if (minutes >= 1440) return 'суток';
  return `${Math.round(minutes / 60)}ч окна`;
}

function updatedAgo(atSec?: number | null): string | null {
  if (!atSec) return null;
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - atSec) / 60));
  if (minutes < 1) return 'только что';
  if (minutes === 1) return '1 минуту назад';
  return `${minutes} мин. назад`;
}

/** One personal limit as a used/total bar. Draws nothing when the gateway set
 *  no ceiling for this window — an absent bar is truer than a full empty one. */
function LimitRow({ label, used, total }: { label: string; used: number | null | undefined; total: number | null | undefined }) {
  if (total == null || total <= 0) return null;
  const u = Math.max(0, used ?? 0);
  const pct = Math.min(100, Math.round((u / total) * 100));
  const tone = pct >= 90 ? ' crit' : pct >= 75 ? ' warn' : '';
  return <div className="quota-row">
    <span className="quota-label">{label}</span>
    <div className="quota-bar"><div className={`quota-fill${tone}`} style={{ width: `${pct}%` }} /></div>
    <span className="quota-val">{u.toLocaleString('ru')} / {total.toLocaleString('ru')}</span>
  </div>;
}

/** The prompt a member hands to their own coding agent, with their key inlined. */
function agentPrompt(a: Access) {
  const models = (a.models ?? []).join(', ');
  return `Настрой мой кодинг-агент на работу через сторонний OpenAI-совместимый шлюз.

## Доступ

- Base URL: ${a.baseUrl}
- API key: ${a.apiKey}
- Ключ передаётся стандартно: заголовок \`Authorization: Bearer <key>\`

Шлюз OpenAI-совместимый. Работают оба формата:
- \`/v1/chat/completions\` (Chat Completions) — streaming SSE и tool/function calling поддерживаются
- \`/v1/responses\` (Responses API) — тоже поддерживается

## Модели

${models}

Имена указывать как есть, без префиксов. Полный список — \`GET /v1/models\`.

## Задача

1. Определи, каким инструментом я пользуюсь (Claude Code, Codex CLI, Cline, Continue,
   Cursor, aider, Zed, свой скрипт на openai SDK) — посмотри конфиги в проекте и в
   домашней директории.
2. Пропиши в его конфиг base URL, ключ и модель по умолчанию. Для большинства
   инструментов достаточно переменных среды:
   OPENAI_BASE_URL=${a.baseUrl}
   OPENAI_API_KEY=${a.apiKey}
   Но сверься с документацией конкретного инструмента — некоторые используют свои
   имена переменных или отдельный файл настроек.
3. Прогони проверки ниже и покажи результат каждой.
4. Если что-то падает — сверься с разделом «Диагностика» и почини, прежде чем отчитываться.

## Проверки

1. Список моделей: GET /v1/models с ключом → 200 и непустой список.
2. Простой запрос: chat completion, короткий ответ.
3. Вызов инструмента: запрос с tools (например get_weather(city)) и tool_choice "auto".
   Должен прийти tool_calls, а function.arguments — парситься как валидный JSON.
4. Возврат результата инструмента: добавь в историю ответ ассистента с tool_calls,
   затем сообщение role "tool" с тем же tool_call_id и результатом. Модель должна
   дать связный финальный ответ. Это важнее пункта 3: одиночный вызов часто работает,
   а второй ход ломается.
5. Стриминг: тот же запрос со "stream": true — чанки приходят инкрементально,
   дельты tool_calls собираются в валидный JSON.
6. Реальная задача в репозитории: прочитать файл и что-то изменить.

## Ограничения

- ${a.limits?.requests ?? '—'} запросов в ${a.limits?.requestsWindow ?? '—'} и ${a.limits?.tokens ?? '—'} токенов в ${a.limits?.tokensWindow ?? '—'}.
- Ключ личный. Не коммить его в репозиторий, не класть в общий конфиг.

## Диагностика

- 401 — ключ не передан или неверный. Проверь, что уходит Authorization: Bearer,
  и что инструмент не подставляет свой ключ поверх.
- 429 — упёрся в лимит. Подожди, не ретрай в цикле.
- 400 про tool call / arguments — агент шлёт нестандартную форму tool-calls.
  Проверь, что arguments это строка с JSON, а не объект, и что каждому tool_call_id
  соответствует ровно одно сообщение role "tool".
- Ответ приходит целиком, а не по частям — инструмент сам буферизует стрим.
- 404 на любом пути кроме /v1/... — так и задумано, наружу открыт только инференс.

Не обращайся к админским эндпоинтам, метрикам или веб-интерфейсу — они закрыты намеренно.`;
}

export function AccessPage() {
  const [state, setState] = useState<'loading' | 'anon' | 'badLink' | 'ready'>('loading');
  const [access, setAccess] = useState<Access | null>(null);
  const [revealed, setRevealed] = useState(false);

  // An access link identifies its holder on its own — members provisioned this way
  // have no HegAI account to sign in with, so a 401 here means a bad link, not
  // "please log in". Read once: the token is fixed for the life of the page.
  const linkToken = useMemo(() => new URLSearchParams(window.location.search).get('t'), []);
  const withLink = useMemo(
    () => (path: string) => (linkToken ? `${path}?t=${encodeURIComponent(linkToken)}` : path),
    [linkToken],
  );

  useEffect(() => {
    document.documentElement.classList.add('install-document');
    fetch(withLink('/api/llm-access'), { credentials: 'same-origin' })
      .then(r => (r.status === 401 ? Promise.reject(new Error('unauthorized')) : r.json()))
      .then((a: Access) => { setAccess(a); setState('ready'); })
      .catch(() => setState(linkToken ? 'badLink' : 'anon'));
    return () => document.documentElement.classList.remove('install-document');
  }, [withLink, linkToken]);

  // A community seat is created by the hub right after activation; this page is
  // where the person is likely waiting for it. Ask again every 10 s until the
  // key exists, and stop the moment it does.
  const seatPending = state === 'ready' && !!access && !access.hasAccess && access.plan === 'community' && !access.reason;
  useEffect(() => {
    if (!seatPending) return;
    let alive = true;
    const timer = window.setInterval(() => {
      apiJsonOrNull<Access>(withLink('/api/llm-access'))
        .then((a) => { if (alive && a) setAccess(a); })
        .catch(() => {});
    }, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [seatPending, withLink]);

  useEffect(() => {
    // The shared-subscription meter is the employees' figure; a community seat
    // has its own ceiling in `limits` and never sees the pool.
    if (state !== 'ready' || access?.plan === 'community') return;
    let alive = true;
    const refreshQuota = () => apiJsonOrNull<{ gatewayQuota?: Access['gatewayQuota'] }>(withLink('/api/gateway-quota'))
      .then(data => {
        if (!alive || !data?.gatewayQuota) return;
        setAccess(current => current ? { ...current, gatewayQuota: data.gatewayQuota } : current);
      })
      .catch(() => {});
    const timer = window.setInterval(refreshQuota, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [state, withLink, access?.plan]);

  const prompt = useMemo(() => (access?.hasAccess ? agentPrompt(access) : ''), [access]);

  const nav = <nav className="install-nav">
    <a className="install-brand" href="/">heg<b>ai</b> remote</a>
    {state === 'anon' && <a className="btn" href={googleStartHref()}>Войти через Google</a>}
  </nav>;

  if (state === 'loading') return <main className="install-page">{nav}</main>;

  // Offering "sign in" here would be a dead end: the link is the only credential
  // its holder has.
  if (state === 'badLink') return <main className="install-page">
    {nav}
    <header className="install-hero">
      <span className="install-kicker">HegAI · доступ к моделям</span>
      <h1>Ссылка недействительна</h1>
      <p>
        Эта ссылка больше не работает или скопирована не целиком. Проверьте, что
        адрес скопирован полностью, — если не помогло, напишите Владельцу за новой.
      </p>
    </header>
  </main>;

  if (state === 'anon') return <main className="install-page">
    {nav}
    <header className="install-hero">
      <span className="install-kicker">HegAI · доступ к моделям</span>
      <h1>Войдите, чтобы увидеть свои доступы</h1>
      <p>Страница показывает персональный ключ к шлюзу моделей. Он привязан к вашей учётной записи HegAI.</p>
    </header>
    <section className="access-cards">
      <div className="install-command-card">
        <span className="link-signin">
          <a className="btn primary" href={googleStartHref()}>Войти через Google</a>
          <TelegramSignInButton />
        </span>
      </div>
    </section>
  </main>;

  // Ways to have no key. A COMMUNITY member is no longer one of the temporary
  // ones: activation stopped minting seats on the shared subscription
  // (`after_activate_hooks`), so «ключ создаётся…» would be a spinner for a
  // thing that is never coming. They bring their own Codex or Claude Code, and
  // the honest answer here says so and points at the page that explains it.
  // Members who already hold a seat still land on the full page below.
  if (!access?.hasAccess) {
    const hero = access?.plan === 'community'
      ? { h: 'Модели здесь свои', p: <>Ключ к общему шлюзу новым участникам не выдаётся: Claude Code или Codex вы подключаете своей подпиской, и лимиты тратите только вы. Как это делается — <a href="/#cli">на первом шаге инструкции</a>.</> }
      : access?.reason === 'waitlist'
        ? { h: 'Ключ появится вместе с активацией', p: <>Вы в списке. Доступ открываем руками — когда дойдёт очередь, эта страница покажет команду установки, а мы напишем в Telegram.</> }
        : access?.reason === 'suspended'
          ? { h: 'Доступ приостановлен', p: <>Ключ к шлюзу выключен, код и память остаются вашими. Напишите Владельцу — включим на час, чтобы забрать.</> }
          : { h: 'Доступ пока не выдан', p: <>Ваша учётная запись {access?.email ? <b>{access.email}</b> : null} распознана, но ключ к шлюзу моделей для неё ещё не создан. Доступ выдаётся точечно — напишите Владельцу, если он вам нужен.</> };
    return <main className="install-page">
      {nav}
      <header className="install-hero">
        <span className="install-kicker">HegAI · доступ к моделям</span>
        <h1>{hero.h}</h1>
        <p>{hero.p}</p>
      </header>
      <footer className="install-footer"><span>Hegai Code</span><a href="/">Открыть рабочее пространство</a></footer>
    </main>;
  }

  const l = access.limits;
  const community = access.plan === 'community';
  const origin = window.location.origin;
  const keyMask = 'sk-bf-••••••••-••••-••••-••••-••••••••••••';
  const shownKey = revealed ? (access.apiKey ?? '') : keyMask;
  const macCmd = (k: string) => `HEGAI_API_KEY='${k}' bash -c "$(curl -fsSL ${origin}/install/codex-gateway.sh)"`;
  // Universal Windows command: works pasted into either cmd.exe or PowerShell.
  // No `$` outside the quotes (so PowerShell doesn't pre-expand it) and no pipe
  // (so cmd doesn't split it); the key rides in as a scriptblock argument.
  const winCmd = (k: string) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${origin}/install/codex-gateway.ps1))) '${k}'"`;
  return <main className="install-page">
    {nav}
    <header className="install-hero">
      <span className="install-kicker">HegAI · доступ к моделям</span>
      <h1>Ваш доступ к шлюзу моделей</h1>
      <p>Ключ персональный и привязан к <b>{access.email}</b>. Не передавайте его другим и не коммитьте в репозиторий — лимиты считаются по нему.</p>
    </header>

    <section className="access-cards">
    <div className="install-command-card">
      <h2>Установка одной командой</h2>
      <p>
        Поставит <b>Codex CLI</b> и направит его через шлюз HegAI. Вставьте в терминал и нажмите Enter —
        ключ уже в команде, ничего настраивать не нужно.
      </p>

      <h3 className="install-sub">macOS / Linux — в Терминал</h3>
      <pre>{macCmd(shownKey)}</pre>
      <div className="install-actions"><CopyButton text={macCmd(access.apiKey ?? '')} label="Скопировать команду" /></div>

      <h3 className="install-sub">Windows — в Командную строку или PowerShell</h3>
      <pre>{winCmd(shownKey)}</pre>
      <div className="install-actions">
        <CopyButton text={winCmd(access.apiKey ?? '')} label="Скопировать команду" />
        <button className="btn" onClick={() => setRevealed(v => !v)}>{revealed ? 'Скрыть ключ' : 'Показать ключ'}</button>
      </div>

      <p className="install-hint">
        Нужен <b>Node.js</b> — команда сама поставит Codex через npm. Ключ личный, не передавайте его.
        Вернуть обычный ChatGPT: переключатель «Шлюз | Своя подписка» в Настройки → Машины
        (или удалите строку <code>model_provider = "hegai"</code> из
        <code> ~/.codex/config.toml</code> — рядом лежит бэкап).
      </p>
    </div>

    <div className="install-command-card">
      <h2>Другой инструмент</h2>
      <p>Cline, Cursor, aider, свой скрипт на OpenAI SDK — большинству достаточно двух переменных среды.</p>
      <pre>{`OPENAI_BASE_URL=${access.baseUrl}\nOPENAI_API_KEY=${revealed ? access.apiKey : keyMask}`}</pre>
      <div className="install-actions">
        <CopyButton text={`OPENAI_BASE_URL=${access.baseUrl}\nOPENAI_API_KEY=${access.apiKey}`} label="Скопировать настройки" />
        <button className="btn" onClick={() => setRevealed(v => !v)}>{revealed ? 'Скрыть ключ' : 'Показать ключ'}</button>
        <CopyButton text={access.apiKey ?? ''} label="Скопировать только ключ" />
      </div>
    </div>

    {community && <div className="install-command-card">
      <h2>Ваши лимиты</h2>
      <p>Расход по этому ключу. Новым участникам шлюз больше не выдаётся — этот остался у тебя с прежнего порядка и работает как работал.</p>
      <LimitRow label={`Токены${l?.tokensWindow ? ` за ${l.tokensWindow}` : ''}`} used={l?.tokensUsed} total={l?.tokens} />
      <LimitRow label={`Запросы${l?.requestsWindow ? ` за ${l.requestsWindow}` : ''}`} used={l?.requestsUsed} total={l?.requests} />
      {(l?.tokens == null && l?.requests == null) && <p className="install-hint">Потолок на этот ключ ещё не выставлен — пока считаем только расход: {(l?.tokensUsed ?? 0).toLocaleString('ru')} токенов, {l?.requestsUsed ?? 0} запросов.</p>}
    </div>}

    {!community && access.gatewayQuota ? (() => {
      const q = access.gatewayQuota!;
      const used = Math.max(0, Math.min(100, Math.round(q.primary_used_percent ?? 0)));
      const sec = Math.max(0, Math.min(100, Math.round(q.secondary_used_percent ?? 0)));
      const hasSecondary = (q.secondary_window_minutes ?? 0) > 0;
      const freshness = updatedAgo(q.updated_at);
      return <div className="install-command-card">
        <h2>Общий лимит Codex (подписка{q.plan ? ` · ${q.plan}` : ''})</h2>
        <p>Это остаток единого лимита подписки на всех — не только ваш.{freshness ? ` Обновлено ${freshness}.` : ''}</p>
        <div className="quota-row">
          <span className="quota-label">Осн. окно {windowLabel(q.primary_window_minutes)}</span>
          <div className="quota-bar"><div className="quota-fill" style={{ width: `${used}%` }} /></div>
          <span className="quota-val">{used}% · сброс через {resetIn(q.primary_reset_at)}</span>
        </div>
        {hasSecondary && <div className="quota-row">
          <span className="quota-label">Короткое {windowLabel(q.secondary_window_minutes)}</span>
          <div className="quota-bar"><div className="quota-fill" style={{ width: `${sec}%` }} /></div>
          <span className="quota-val">{sec}% · сброс через {resetIn(q.secondary_reset_at)}</span>
        </div>}
        <p>Осталось <b>{100 - used}%</b> недельного окна. Когда дойдёт до 100% — модели ответят <code>429</code> до сброса.</p>
      </div>;
    })() : null}

    {!community && <div className="install-command-card">
      <h2>Ваше потребление</h2>
      <p>
        Сегодня израсходовано <b>{(l?.tokensUsed ?? 0).toLocaleString('ru')}</b> токенов
        {' · '}{l?.requestsUsed ?? 0} запросов за последний час.
      </p>
      <p>Персональных лимитов нет — общий тормоз это лимит подписки выше.</p>
    </div>}

    <div className="install-command-card">
      <h2>Модели</h2>
      <pre>{(access.models ?? []).join('\n')}</pre>
      <p>Имена указывать как есть, без префиксов.</p>
    </div>

    <div className="install-command-card">
      <h2>Промпт для вашего агента</h2>
      <p>Скопируйте и отдайте своему кодинг-агенту — он настроит себя сам и прогонит проверки. Ключ уже подставлен.</p>
      <pre>{prompt.slice(0, 400)}…</pre>
      <div className="install-actions"><CopyButton text={prompt} label="Скопировать промпт целиком" /></div>
    </div>
    </section>
    <footer className="install-footer"><span>Hegai Code</span><a href="/">Открыть рабочее пространство</a></footer>
  </main>;
}
