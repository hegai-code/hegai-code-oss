import {
  BrowserCommandResponse,
  BrowserErrorBody,
  BrowserInfo,
  BrowserProfile,
  BrowserProfileList,
  type BrowserStatus,
  type BrowserTab,
} from '@cc-remote/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { ApiError } from '../../api.js';

/**
 * The cloud browser (10.10.2026): each person's own Camoufox profile on the
 * hub box, shown in a side sheet over noVNC (`BrowserSheet`). The hub is the
 * only door — `server-rs/src/browser.rs` has the contract; every call here is
 * a same-origin fetch with the session cookie, like the rest of `/api`.
 *
 * `GET /api/browser` answering 404 means «not for you» (the feature is off on
 * this hub, or not rolled out to this person yet): every entry point hides.
 */

export type { BrowserInfo, BrowserProfile, BrowserStatus, BrowserTab };

/** What `req` needs of a zod schema — keeps zod itself out of web's dependencies. */
type Schema<T> = {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
};
const anything: Schema<unknown> = { safeParse: (data) => ({ success: true, data }) };

/**
 * A browserd answer that is HTTP 200 but `{ok:false}` is a failure too. A body
 * that does not match its schema is a failure as well — never empty data.
 */
async function req<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body: unknown = await r.json().catch(() => ({}));
  const failure = BrowserErrorBody.safeParse(body);
  const refused = typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === false;
  if (!r.ok || refused) {
    throw new ApiError(failure.success ? failure.data.error : `Запрос не удался (${r.status})`, r.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('Сервис браузера ответил неожиданно. Попробуйте ещё раз.', r.status);
  }
  return parsed.data;
}

const post = (path: string, payload: unknown = {}) =>
  req(path, anything, { method: 'POST', body: JSON.stringify(payload) });

const P = '/api/browser/profiles';

export const browserApi = {
  info: () => req('/api/browser', BrowserInfo),
  profiles: () => req(P, BrowserProfileList).then((r) => r.profiles),
  create: (name: string) =>
    req(P, BrowserProfile, { method: 'POST', body: JSON.stringify({ name }) }),
  remove: (id: string) => req(`${P}/${id}`, anything, { method: 'DELETE' }),
  stop: (id: string) => post(`${P}/${id}/stop`),
  /** The hands: `navigate`, `back`, `insert_text`, `switch_tab`, `status`… */
  cmd: async <T = unknown>(
    id: string,
    type: string,
    params: Record<string, unknown> = {},
    resultSchema?: Schema<T>,
  ): Promise<T> => {
    const r = await req(`${P}/${id}/cmd`, BrowserCommandResponse, {
      method: 'POST',
      body: JSON.stringify({ type, params }),
    });
    if (!r.ok) throw new ApiError(r.error, 200);
    const parsed = (resultSchema ?? (anything as Schema<T>)).safeParse(r.result);
    if (!parsed.success) throw new ApiError('Сервис браузера ответил неожиданно. Попробуйте ещё раз.', 200);
    return parsed.data;
  },
  /** The VNC WebSocket — same origin, cookie auth, subprotocol `binary`. */
  vncUrl: (id: string) =>
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${P}/${id}/vnc`,
};

/**
 * A failure in words a person can act on. The hub and browserd answer in
 * English for logs; the four that reach a person here get Russian.
 */
export function browserError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return 'Больше трёх браузеров завести нельзя — удалите один в Настройках.';
    if (e.status === 503 && /in use/.test(e.message)) return 'Все облачные браузеры сейчас заняты — попробуйте через несколько минут.';
    if (e.status === 503) return 'Сервис браузера недоступен.';
    if (e.status === 502 && /container exited/.test(e.message)) return 'Браузер не запустился. Попробуйте ещё раз.';
    if (e.status === 504) return 'Браузер не ответил вовремя. Попробуйте ещё раз.';
    if (e.status === 404) return 'Такого браузера нет — возможно, его удалили.';
    // The runner's page errors come as «TimeoutError: Page.goto: …»: say what
    // happened, not which Playwright call noticed it.
    if (/TimeoutError/.test(e.message)) return 'Страница не ответила за 45 секунд.';
    if (/ERR_|NS_ERROR_/.test(e.message)) return 'Страница не открылась — сайт недоступен или адрес неверный.';
    if (e.status === 502) return 'Браузер не смог это сделать. Попробуйте ещё раз.';
  }
  return e instanceof Error ? e.message : String(e);
}

/** The newest profile someone used — what the sheet opens on by default. */
export function lastUsed(profiles: BrowserProfile[]): BrowserProfile | undefined {
  return profiles.reduce<BrowserProfile | undefined>(
    (best, p) => (!best || p.last_used_at > best.last_used_at ? p : best),
    undefined,
  );
}

/**
 * What a typed address means. A bare `example.com` is https; anything with a
 * space or without a dot is not an address, so it goes to a search engine
 * rather than to `https://привет`.
 */
export function normalizeAddress(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  // Same contract as runner.py `_url`: http(s) and exactly about:blank pass;
  // any other scheme (data:, view-source:, ftp:, file:) is refused there, so
  // here it becomes a search rather than a promise the runner breaks.
  if (/^https?:\/\//i.test(s) || s.toLowerCase() === 'about:blank') return s;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !/^localhost:\d/i.test(s)) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
  }
  const host = s.split(/[/?#]/)[0] ?? '';
  if (/\s/.test(s)) return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
  if (/^localhost(:\d+)?$/i.test(host)) return `http://${s}`;
  if (/^[^\s.:]+(\.[^\s.:]+)+(:\d+)?$/.test(host)) return `https://${s}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

/* ---- one store for the shell ------------------------------------------------
   The sheet is opened from the top bar, the phone drawer and Настройки, and it
   must survive navigation between sessions — so its state is the shell's, not
   any screen's. A module store, like `MineOnly`, read with
   useSyncExternalStore. */

type State = {
  /** undefined = not asked yet, null = not available to this person. */
  info: BrowserInfo | null | undefined;
  /** null = closed; otherwise the profile to show (undefined = the last used). */
  sheet: { profileId?: string } | null;
};

let state: State = { info: undefined, sheet: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

let inflight: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

/** Ask the hub again — whether the browser is here, and is its exit up. */
export function refreshBrowserInfo(): Promise<void> {
  if (inflight) return inflight;
  inflight = browserApi
    .info()
    .then((info) => set({ info: info.enabled ? info : null }))
    .catch((e: unknown) => {
      // 404 is the hub's «not for you». Anything else (the hub restarting, the
      // network) hides the button for now and asks again in a minute, so one
      // bad moment at page load does not hide it until a reload.
      if (state.info === undefined || (e instanceof ApiError && e.status === 404)) set({ info: null });
      if (!(e instanceof ApiError && e.status === 404) && !retry) {
        retry = setTimeout(() => {
          retry = null;
          void refreshBrowserInfo();
        }, 60_000);
      }
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The hub's answer to `GET /api/browser`; null while unknown or not available. */
export function useBrowserInfo(): BrowserInfo | null {
  const info = useSyncExternalStore(subscribe, () => state.info);
  useEffect(() => {
    if (state.info === undefined) void refreshBrowserInfo();
  }, []);
  return info ?? null;
}

export function useBrowserSheet(): State['sheet'] {
  return useSyncExternalStore(subscribe, () => state.sheet);
}

export function openBrowser(profileId?: string): void {
  set({ sheet: { profileId } });
}

export function closeBrowser(): void {
  set({ sheet: null });
}

/** Remote screen size for a host box of w×h CSS px. Narrow (a phone): 500 px
 *  across — the narrowest Firefox lays a page out — so sites serve their
 *  mobile layout. Wide: 1440 across. Height follows the box's proportion. */
export function screenFor(w: number, h: number): { width: number; height: number } | null {
  if (w < 50 || h < 50) return null;
  const width = w < 700 ? 500 : 1440; // 500: the narrowest Firefox lays a page out
  const height = Math.round((width * h) / w);
  return { width, height: Math.max(500, Math.min(1200, height)) };
}
