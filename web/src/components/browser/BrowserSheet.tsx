import { BrowserStatus as BrowserStatusSchema } from '@cc-remote/shared';
import RFB from '@novnc/novnc';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ClipboardText, Globe, RefreshCw } from '../../icons.js';
import { SideSheet } from '../SideSheet.js';
import {
  type BrowserProfile,
  type BrowserStatus,
  browserApi,
  browserError,
  lastUsed,
  normalizeAddress,
  refreshBrowserInfo,
  screenFor,
  useBrowserInfo,
} from './browserApi.js';
import { attachClipboard } from './rfbClipboard.js';

/** How often the address field follows the page while the sheet is open. */
const STATUS_EVERY_MS = 4500;

/**
 * «Браузер» — the person's own browser on the hub box, its screen over noVNC.
 * Closing the sheet drops only the picture: the profile keeps running on the
 * server and falls asleep by itself after 20 minutes nobody watches.
 */
export function BrowserSheet({ requested, onClose }: { requested?: string; onClose: () => void }) {
  const info = useBrowserInfo();
  const [profiles, setProfiles] = useState<BrowserProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | undefined>(requested);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // The remote screen. Esc pressed in it belongs to the page in there (a
  // dialog, a menu, fullscreen), so it must not also close the sheet.
  const screenRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await browserApi.profiles();
      setProfiles(list);
      setLoadError(null);
      setCurrent((cur) => (cur && list.some((p) => p.id === cur) ? cur : lastUsed(list)?.id));
    } catch (e) {
      setLoadError(browserError(e));
    }
  }, []);

  useEffect(() => {
    void refreshBrowserInfo();
    void load();
  }, [load]);

  // A browserd outage seen while the sheet is open heals by itself: retry
  // both reads every 15 s until they come back.
  const unhealthy = !!loadError || !!info?.down;
  useEffect(() => {
    if (!unhealthy) return;
    const t = setInterval(() => {
      void refreshBrowserInfo();
      void load();
    }, 15_000);
    return () => clearInterval(t);
  }, [unhealthy, load]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const p = await browserApi.create('Браузер');
      setProfiles((list) => [...(list ?? []), p]);
      setCurrent(p.id);
    } catch (e) {
      setCreateError(browserError(e));
    } finally {
      setCreating(false);
    }
  };

  const profile = profiles?.find((p) => p.id === current);
  const picker =
    profiles && profiles.length > 1 ? (
      <select
        className="bs-field bs-pick"
        value={current}
        aria-label="Какой браузер"
        onChange={(e) => setCurrent(e.target.value)}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <SideSheet
      title="Браузер"
      wide
      onClose={onClose}
      headExtra={picker}
      bodyClassName="bs-body"
      closeOnEscape={() => !screenRef.current?.contains(document.activeElement)}
    >
      {info?.down ? (
        <div className="bs-attn" role="status">Сервис браузера недоступен</div>
      ) : info && !info.egress ? (
        <div className="bs-attn" role="status">Нет выхода в интернет (WARP) — страницы не откроются</div>
      ) : null}
      {profiles === null ? (
        <div className="bs-note">{loadError ?? 'Загружаю…'}</div>
      ) : profiles.length === 0 ? (
        <div className="bs-empty">
          <Globe size={28} />
          <p>Свой браузер на сервере: войдите в сервисы один раз — дальше сессии платформы смогут работать в них от вашего имени.</p>
          <button type="button" className="btn primary" disabled={creating} onClick={() => void create()}>
            {creating ? 'Создаю…' : 'Создать браузер'}
          </button>
          {createError && <div className="bs-error">{createError}</div>}
        </div>
      ) : profile ? (
        <BrowserView key={profile.id} id={profile.id} screenRef={screenRef} />
      ) : null}
    </SideSheet>
  );
}

type Conn = 'connecting' | 'connected' | 'disconnected';

const lastFit = new Map<string, string>();
async function fitScreen(id: string, host: HTMLElement) {
  const size = screenFor(host.clientWidth, host.clientHeight);
  if (!size) return;
  const key = `${size.width}x${size.height}`;
  if (lastFit.get(id) === key) return;
  lastFit.set(id, key);
  try {
    await browserApi.cmd(id, 'screen', size);
  } catch {
    lastFit.delete(id); // try again on the next resize/connect
  }
}

function BrowserView({ id, screenRef }: { id: string; screenRef: RefObject<HTMLDivElement> }) {
  const rfbRef = useRef<RFB | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [address, setAddress] = useState('');
  const editing = useRef(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The screen. One RFB per profile and attempt; the effect's cleanup is the
  // only place it is torn down, so a profile switch or an unmount never leaves
  // a socket behind.
  useEffect(() => {
    const host = screenRef.current;
    if (!host) return;
    let alive = true;
    let ended = false;
    setConn('connecting');
    const rfb = new RFB(host, browserApi.vncUrl(id), { wsProtocols: ['binary'], shared: true });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.focusOnClick = true;
    // A CSS value on noVNC's own screen element, so the token follows the theme.
    rfb.background = 'var(--bg)';
    rfb.addEventListener('connect', () => {
      if (!alive) return;
      setConn('connected');
      rfb.focus({ preventScroll: true });
      void fitScreen(id, host);
    });
    rfb.addEventListener('disconnect', () => {
      ended = true;
      if (alive) setConn('disconnected');
    });
    rfbRef.current = rfb;
    const detachClipboard = attachClipboard(rfb, host);
    // The remote screen follows the sheet's shape: a phone gets a narrow screen
    // (sites then serve their mobile layout), a desk one fills the sheet.
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => alive && !ended && void fitScreen(id, host), 600);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      detachClipboard();
      clearTimeout(fitTimer);
      alive = false;
      rfbRef.current = null;
      // Disconnecting an RFB that already ended logs an error in noVNC.
      if (!ended) rfb.disconnect();
    };
  }, [id, attempt, screenRef]);

  const poll = useCallback(async () => {
    try {
      const s = await browserApi.cmd(id, 'status', {}, BrowserStatusSchema);
      setStatus(s);
      if (!editing.current) setAddress(s.url ?? '');
    } catch {
      /* the next tick asks again; the toolbar is not where this breaks loudly */
    }
  }, [id]);

  // The address follows the page — only while the picture is up (a status
  // call would otherwise wake a sleeping profile) and the tab is visible.
  useEffect(() => {
    if (conn !== 'connected') return;
    void poll();
    const t = setInterval(() => {
      if (!document.hidden) void poll();
    }, STATUS_EVERY_MS);
    return () => clearInterval(t);
  }, [conn, poll]);

  const backToScreen = () => rfbRef.current?.focus({ preventScroll: true });

  const run = async (type: string, params?: Record<string, unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await browserApi.cmd(id, type, params);
      void poll();
      return true;
    } catch (e) {
      setError(browserError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const go = async () => {
    const url = normalizeAddress(address);
    if (!url) return;
    editing.current = false;
    setAddress(url);
    backToScreen();
    await run('navigate', { url });
  };

  const paste = async () => {
    if (!pasteText) return;
    if (await run('insert_text', { text: pasteText })) {
      setPasteText('');
      setPasteOpen(false);
      backToScreen();
    }
  };

  const tabs = status?.tabs ?? [];
  const activeTab = tabs.find((t) => t.active)?.index;

  return (
    <>
      <div className="bs-toolbar">
        <button type="button" className="icon-btn bs-btn" title="Назад" aria-label="Назад" disabled={busy} onClick={() => void run('back').then(backToScreen)}>
          <ArrowLeft size={16} />
        </button>
        <button type="button" className="icon-btn bs-btn" title="Вперёд" aria-label="Вперёд" disabled={busy} onClick={() => void run('forward').then(backToScreen)}>
          <ArrowRight size={16} />
        </button>
        <button type="button" className="icon-btn bs-btn" title="Обновить" aria-label="Обновить" disabled={busy} onClick={() => void run('reload').then(backToScreen)}>
          <RefreshCw size={16} />
        </button>
        <form
          className="bs-url"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <input
            className="bs-field"
            type="text"
            inputMode="url"
            value={address}
            placeholder="Адрес или поиск"
            title={status?.title || undefined}
            aria-label="Адрес"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onFocus={(e) => {
              editing.current = true;
              e.currentTarget.select();
            }}
            onBlur={() => {
              editing.current = false;
            }}
            onKeyDown={(e) => {
              // Esc in the field puts the page's address back, like a browser,
              // and stops there — the sheet stays open.
              if (e.key === 'Escape') {
                e.preventDefault();
                setAddress(status?.url ?? '');
                e.currentTarget.blur();
              }
            }}
            onChange={(e) => setAddress(e.target.value)}
          />
        </form>
        {tabs.length > 1 && (
          <select
            className="bs-field bs-tabs"
            value={activeTab}
            aria-label="Вкладка"
            title="Вкладки"
            onChange={(e) => void run('switch_tab', { index: Number(e.target.value) }).then(backToScreen)}
          >
            {tabs.map((t) => (
              <option key={t.index} value={t.index}>
                {t.title || t.url || `Вкладка ${t.index + 1}`}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className={`btn bs-paste-btn ${pasteOpen ? 'on' : ''}`}
          aria-expanded={pasteOpen}
          aria-label="Вставить текст"
          title="Вставить текст в поле, где стоит курсор"
          onClick={() => setPasteOpen((v) => !v)}
        >
          <ClipboardText size={16} />
          <span className="bs-paste-label">Вставить текст</span>
        </button>
      </div>
      {pasteOpen && (
        <form
          className="bs-paste"
          onSubmit={(e) => {
            e.preventDefault();
            void paste();
          }}
        >
          <textarea
            className="bs-field"
            rows={3}
            value={pasteText}
            autoFocus
            placeholder="Текст попадёт в поле на странице, где стоит курсор — так надёжнее для кириллицы и длинного текста"
            onChange={(e) => setPasteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void paste();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setPasteOpen(false);
              }
            }}
          />
          <div className="bs-paste-actions">
            <button type="submit" className="btn primary" disabled={busy || !pasteText}>
              Вставить
            </button>
            <button type="button" className="btn" onClick={() => setPasteOpen(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}
      {error && <div className="bs-error bs-error-line">{error}</div>}
      <div className="bs-screen-wrap">
        <div className="bs-screen" ref={screenRef} />
        {conn !== 'connected' && (
          <div className="bs-overlay" role="status">
            {conn === 'connecting' ? (
              <>
                <b>Запускаю браузер…</b>
                <span>Первый запуск может занять до минуты.</span>
              </>
            ) : (
              <>
                <b>Связь с браузером прервалась</b>
                <span>Браузер на сервере продолжает работать — можно подключиться снова.</span>
                <button type="button" className="btn primary" onClick={() => setAttempt((n) => n + 1)}>
                  Переподключить
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
