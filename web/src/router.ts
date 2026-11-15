import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { BOARD_SINCE_DAYS, SessionCategory, SessionStage, type BoardSinceDays } from '@cc-remote/shared';
import { newId } from './lib.js';
import { storageGet, storageSet } from './storage.js';

/**
 * A hand-rolled History-API router, ~130 lines instead of a dependency.
 *
 * Two things justify writing it rather than pulling in react-router. First,
 * there are four destinations and two dynamic segments — the library's model is
 * larger than the problem. Second, and the real reason: `Route` is a parsed
 * discriminated union, so the view switch is exhaustive and a new destination
 * cannot be added without the compiler asking where it renders. That is the
 * mechanism that stops the drift back towards thirteen loose view strings.
 *
 * Everything lives under `/w/`. The hub serves the SPA as a fallback for
 * unmatched paths (server-rs/src/main.rs:314), but it also owns `/agent`,
 * `/ui`, `/api/*`, `/install/*`, `/health` and `/transcribe` as real routes —
 * a browser GET on those does NOT reach the SPA. The `/w/` prefix means no
 * future hub route can ever shadow a screen.
 */

export type TeamTab = 'overview' | 'people' | 'projects' | 'usage' | 'audit' | 'access';
/** Настройки own what used to be three rail items of their own. They are visited
 *  about once a month each, and a permanent icon apiece is how a rail grows. */
export type SettingsTab = 'overview' | 'hardware' | 'apps' | 'look' | 'browser';

/** A session on a machine — what a session pane of the split shows. */
export interface ColRef {
  machineId: string;
  sessionId: string;
}

export type Route =
  /** The session list. It had a `lens` for a while — Список, Flow, and before
   *  them Доска and Таблица — and every one of those was another reading of the
   *  set the side panel now lists permanently, on every screen. A way of
   *  looking is not a place, and four of them were four places. */
  | { kind: 'sessions' }
  /** The composer on its own. On a phone `/w/sessions` IS the session list —
   *  `.main-col` is hidden beside the context column — so the start screen had
   *  no address there and starting a session was simply impossible.
   *
   *  `cat` preselects a work type, which makes "start a sync session" a
   *  shareable address rather than a click path. Unknown ids are dropped at
   *  parse time, so an old link degrades to the plain composer instead of a
   *  chip nobody can turn off.
   *
   *  `create` opens the «Новый проект» panel on arrival — what «Создать проект»
   *  in Настройки and the «Первый проект» card point at.
   *
   *  `machineId` + `cwd` aim the composer at ONE project. The old `/w/p/:label`
   *  could only name a label, and the fleet has `crm` on two boxes and `hegai`
   *  on three — so «новая сессия здесь», pressed inside a machine-keyed screen,
   *  landed wherever that label was touched last. A pair is the only thing that
   *  identifies a project in this product.
   *
   *  It used to carry `cols` — the split it was opened from — so the session it
   *  started could rejoin that split. The split now holds the composer itself,
   *  as one of its panes (see `columns`), so there is nothing to carry: an old
   *  `/w/new?cols=a,b` parses to the split `[a, b, composer]`. */
  | {
      kind: 'new';
      cat?: SessionCategory;
      create?: boolean;
      machineId?: string;
      cwd?: string;
      /** Which composer, when the tab strip's «+» opened one more (`?n=`,
       *  30.09.2026). Without it every composer was the SAME slot, so a second
       *  «+» only moved the one tab there was. Absent = the one plain composer
       *  that «Новый чат» and every other entry point reuse. */
      n?: string;
    }
  /** The split: the screen divided into 2–4 panes, each showing any screen of
   *  the app except another split — a session, Файлы, Проекты, Команда,
   *  Настройки, the new-chat composer. `panes` ARE the state (see
   *  `parsePanes`), so a split is a link.
   *
   *  It is a division of the SCREEN, not a place (24.09.2026, by request): one
   *  pane has focus, and everything chosen outside the panes — a session in the
   *  side panel, a destination, «Новый чат» — opens in THAT pane instead of
   *  replacing the split. `navigate` does the routing (see `intoPane`), so no
   *  screen needs to know it is inside a pane. */
  | { kind: 'columns'; panes: PaneRoute[] }
  | { kind: 'project'; project: string }
  | { kind: 'session'; machineId: string; sessionId: string }
  /** The file manager.
   *
   *  `root` is an ABSOLUTE path, so it rides in the query rather than a path
   *  segment: as a segment it has to become %2F soup, and proxies and
   *  `pushState` normalise paths while leaving queries alone. `p` addresses a
   *  DIRECTORY and `f` a file inside it — two params rather than one, so a cold
   *  load knows which is which without a round trip to ask. */
  | { kind: 'files'; machineId?: string; root?: string; p?: string; f?: string }
  | { kind: 'team'; tab: TeamTab }
  /** Projects in the ONE grouping the rest of the app cannot express: by the
   *  machine they live on.
   *
   *  Every other project surface is session-derived and keys on the label alone,
   *  so `crm` on two boxes is one card and the machine degrades to a `+1` badge —
   *  and a repository nobody has started a session in is absent entirely. Here
   *  the machine is the axis and the inventory comes from the agent
   *  (`projects.list`), which is the only thing that knows what is actually on
   *  disk.
   *
   *  `adopt` opens the folder picker, the same way `/w/new?create=1` opens the
   *  «Новый проект» panel. */
  | { kind: 'projects'; machineId?: string; cwd?: string; adopt?: boolean }
  /** The task board («Доска»): cards the hub ASSEMBLES from sessions — a task
   *  as a non-technical reader sees it, not a session. This is not the lens
   *  `sessions` says was removed: that one re-read the same session set the
   *  side panel lists; this reads its own data (`GET /api/board`).
   *
   *  Filters ride in the URL so a filtered board is a shareable link. `card`
   *  opens that card's drawer on arrival; `col` is the phone's one-column-at-
   *  a-time position. `since` is omitted when it is the default fortnight. */
  | { kind: 'board'; owner?: string; project?: string; since?: BoardSinceDays; card?: string; col?: SessionStage }
  /** Отчёты: HTML pages a session published to the hub (`/api/reports`) —
   *  the list, or one report full-size. Visibility is the hub's (author +
   *  platform admins); the id in the URL is the shareable link. */
  | { kind: 'reports'; id?: string }
  /** Настройки and the three personal screens folded into it. `/w/hardware`,
   *  `/w/memory` and `/w/profile` still PARSE — bookmarks and old links outlive
   *  anyone's memory of the URL — they just land on the matching tab, and
   *  `normalizeEntryPath` rewrites the address so it stops lying. */
  | { kind: 'settings'; tab: SettingsTab }
  /** The first screens after signing in (computer · Claude and Codex · phone).
   *  Full screen, outside the settings shell; `ControlPlaneApp` also shows it by
   *  itself while the person has no machine or no login. `/w/settings/start`
   *  still parses here. */
  | { kind: 'start' };

/** What a pane of the split can show: any screen but the split itself. */
export type PaneRoute = Exclude<Route, { kind: 'columns' }>;

const TEAM_TABS: TeamTab[] =['overview', 'people', 'projects', 'usage', 'audit', 'access'];
const SETTINGS_TAB_SEGMENTS: SettingsTab[] = ['hardware', 'apps', 'look', 'browser'];

/**
 * Where `/w/` lands and where anything unrecognised falls back to.
 *
 * It was a dashboard of its own for a while. That screen made no request the
 * shell had not already made — four counters, the project list and the recent
 * sessions, all recomputed from the same `central.machines` the context column
 * renders — so the first screen after signing in was the one with nothing on it
 * you could not see beside it. The list is the landing again.
 */
export const SESSIONS: Route = { kind: 'sessions' };

/**
 * How many panes the split accepts. Not a taste limit: a pane floors at 300px,
 * so four already want ~1400px, and each SESSION pane holds a session view of
 * its own — its history read and its stream — on the window's one /ui socket
 * (sessionChannel.ts). Past four the screen and the hub both pay for panes
 * nobody can read.
 */
export const COL_MAX = 4;

/**
 * The query that asks the desktop shell for a window of its own.
 *
 * `window.open` cannot say what it wants: a `target="_blank"` inside a
 * transcript and «Открыть в новом окне» in the session menu arrive at the shell
 * looking identical, and the shell's standing rule — right for the first, wrong
 * for the second — is to move the window you already have rather than duplicate
 * the whole app. So the intent rides in the URL, and only from this origin
 * (`wants_own_window`, windows/src-tauri/src/main.rs).
 *
 * It is stripped on arrival — see `normalizeEntryPath` in App.tsx. A flag left
 * in the address bar would be copied into a shared link and would mean "open a
 * second window" to whoever opened it, which is not what the person sharing a
 * session meant. In a browser it never meant anything in the first place.
 */
export const OWN_WINDOW_FLAG = 'w';

/** Asks the desktop shell to open one of OUR links in the system browser
 *  rather than in an app window (`wants_browser`, windows/src-tauri/src/main.rs).
 *  Set by `mdLinkHref` on transcript links only where the shell understands it
 *  (`__HEGAI_LINKS_TO_BROWSER__`); the shell strips it before the browser sees
 *  the address, and `normalizeEntryPath` strips it if it ever arrives here. */
export const BROWSER_FLAG = 'ext';

/** Asks the page to reopen the last screen this browser profile showed
 *  (`LAST_ROUTE_KEY`). Sent ONLY by the desktop shell, on the URL it starts
 *  with (`start_url`, windows/src-tauri/src/main.rs): «если перезагружаешь
 *  приложение — открывай последние открытые вкладки» (10.10.2026). A browser
 *  tab never carries it, so a plain visit to /w/sessions stays the list. */
export const RESTORE_FLAG = 'restore';
export const LAST_ROUTE_KEY = 'cc-last-route';

/** The address worth coming back to: an app screen, without one-shot flags. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a malformed key is kept as written, never a crash at import
  }
}

export function restorableAddress(pathname: string, search: string): string | null {
  if (!pathname.startsWith('/w/')) return null;
  // Filtered as raw `k=v` pieces, NOT through URLSearchParams.toString(): that
  // re-encodes `:` and `,` inside `?s=`, and `parsePanes` reads them literally —
  // the restored split would come back with no panes at all.
  const drop = new Set([OWN_WINDOW_FLAG, BROWSER_FLAG, RESTORE_FLAG]);
  const rest = search
    .replace(/^\?/, '')
    .split('&')
    .filter((kv) => kv && !drop.has(safeDecode(kv.split('=')[0] ?? '')))
    .join('&');
  return pathname + (rest ? `?${rest}` : '');
}

/** Stable identity of a pane's CONTENT for dedupe: a session is itself; the
 *  plain start screen (composer, project composer, a new session without an id
 *  yet) is one slot, because two of them share one draft in localStorage and
 *  would overwrite each other. A composer the tab strip's «+» opened carries
 *  its own `n` and its own draft, so it is a slot of its own. Everything else
 *  may repeat — two Файлы are harmless. */
export function paneSlot(p: PaneRoute): string | null {
  if (p.kind === 'session' && p.sessionId) return `s:${p.machineId}::${p.sessionId}`;
  if (p.kind === 'new' && p.n) return `start:${p.n}`;
  // The session a composer just started, before it has an id. Its own slot, not
  // the composer's: with several composers it must sit beside the plain one,
  // not be deduped against it.
  if (p.kind === 'session') return 'pending';
  if (isStartPane(p)) return 'start';
  return null;
}

/** A fresh `n` for one more composer (`?n=`). Short: it rides in the URL. */
export function newComposerId(): string {
  return newId();
}

/** The composer in any of its forms — including the placeholder of a session
 *  that has been started but has no id yet, which is the composer's next state. */
export function isStartPane(p: PaneRoute): boolean {
  // Not `project`: since 27.09.2026 `/w/p/:project` is that project's session
  // list (ProjectSessions), a screen of its own — no longer a composer.
  return p.kind === 'new' || p.kind === 'sessions' || (p.kind === 'session' && !p.sessionId);
}

/** The session panes of a split, in order — what the list marks as open. */
export function sessionPanes(panes: PaneRoute[]): ColRef[] {
  const out: ColRef[] = [];
  for (const p of panes) {
    if (p.kind === 'session' && p.sessionId) out.push({ machineId: p.machineId, sessionId: p.sessionId });
  }
  return out;
}

/** `sessions` is the landing, which on a desk is the composer — as a pane it
 *  is simply the composer. */
export function asPane(r: Route): PaneRoute | null {
  if (r.kind === 'columns') return null;
  if (r.kind === 'sessions') return { kind: 'new' };
  return r;
}

/** Deduped (a session once — two panes of one transcript are two writers; one
 *  composer), capped, order preserved. */
export function cleanPanes(panes: PaneRoute[]): PaneRoute[] {
  const out: PaneRoute[] = [];
  const seen = new Set<string>();
  for (const p of panes) {
    const k = paneSlot(p);
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(p);
    if (out.length >= COL_MAX) break;
  }
  return out;
}

/**
 * `?s=` — the panes, comma-separated, in order.
 *
 * A session pane is `machine:session`, exactly the format the split has always
 * used, so every split link already in a chat history still opens. Any other
 * pane is its own address, percent-encoded whole (`%2Fw%2Ffiles%2F…`) — which
 * also encodes the `,` `?` `&` inside it, so splitting on `,` stays safe — and
 * is read back with `parseRoute`, so a pane understands every address its
 * screen does.
 */
/** A query parameter exactly as it stands in the URL, NOT decoded.
 *  `URLSearchParams.get` decodes once, and a pane's address is itself encoded
 *  inside `?s=` — decoding it twice turns the `%2C` inside a folder name into a
 *  `,` that splits the pane in half. */
function rawParam(search: string, name: string): string | null {
  for (const part of search.replace(/^\?/, '').split('&')) {
    const eq = part.indexOf('=');
    if ((eq < 0 ? part : part.slice(0, eq)) === name) return eq < 0 ? '' : part.slice(eq + 1);
  }
  return null;
}

function parsePanes(raw: string | null): PaneRoute[] {
  if (!raw) return [];
  const out: PaneRoute[] = [];
  for (const item of raw.split(',')) {
    if (!item) continue;
    let decoded = '';
    try {
      decoded = decodeURIComponent(item);
    } catch {
      continue;
    }
    if (decoded.startsWith('/w/') || decoded === '/w') {
      const q = decoded.indexOf('?');
      const pane = asPane(parseRoute(q < 0 ? decoded : decoded.slice(0, q), q < 0 ? '' : decoded.slice(q)));
      if (pane) out.push(pane);
      continue;
    }
    const i = item.indexOf(':');
    if (i <= 0) continue;
    const machineId = decodeURIComponent(item.slice(0, i));
    const sessionId = decodeURIComponent(item.slice(i + 1));
    if (!machineId || !sessionId) continue;
    out.push({ kind: 'session', machineId, sessionId });
  }
  return cleanPanes(out);
}

/**
 * The route for a set of panes. A split of one is not a split — it dissolves
 * into that screen on its own, with the side panel and everything a pane has no
 * room for; an empty one goes to the list.
 */
export function splitRoute(panes: PaneRoute[]): Route {
  const clean = cleanPanes(panes);
  if (clean.length === 0) return SESSIONS;
  if (clean.length === 1) return clean[0] as PaneRoute;
  return { kind: 'columns', panes: clean };
}

function panesParam(panes: PaneRoute[]): string {
  return cleanPanes(panes)
    .map((p) =>
      p.kind === 'session' && p.sessionId
        ? `${encodeURIComponent(p.machineId)}:${encodeURIComponent(p.sessionId)}`
        : encodeURIComponent(pathForMount(p)),
    )
    .join(',');
}

/**
 * A relative path from a URL, reduced to something safe to ask an agent for.
 *
 * A URL is untrusted input even when the person typing it is the owner: a
 * pasted or hand-edited `?p=../../..` must not become a request. The agent
 * refuses traversal too — that is the boundary — but a client that knowingly
 * sends it is a client with a bug.
 */
export function safeRel(raw: string | null): string {
  if (!raw) return '';
  if (/^([a-zA-Z]:)?[\\/]/.test(raw)) return ''; // absolute, or a drive letter
  const parts = raw
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return '';
  return parts.join('/');
}

/** Parse a location into a Route. Anything unrecognised lands on SESSIONS. */
/** `?since=` on the board: one of the offered periods, else the default
 *  (absent). `since=5` from a hand-typed URL degrades to a fortnight rather
 *  than to a chip nobody can turn off. The default itself is never written. */
export function parseBoardSince(raw: string | null): BoardSinceDays | undefined {
  const n = Number(raw);
  const known = (BOARD_SINCE_DAYS as readonly number[]).includes(n) ? (n as BoardSinceDays) : undefined;
  return known === 14 ? undefined : known;
}

export function parseRoute(pathname: string, search: string): Route {
  const q = new URLSearchParams(search);
  // Strip the mount before parsing, so `/v2/w/sessions` reads as `/w/sessions`.
  // `''` for the root build, where this is a no-op.
  if (BASE && (pathname === BASE || pathname.startsWith(`${BASE}/`))) {
    pathname = pathname.slice(BASE.length) || '/';
  }
  const seg = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (seg[0] !== 'w') return SESSIONS;

  switch (seg[1]) {
    case undefined:
      return SESSIONS;
    case 'sessions':
      // `?view=flow|board|table` are dead lenses. They parse to the list rather
      // than to nothing: those addresses are in chat histories and bookmarks,
      // and the list is what every one of them was a reading of.
      return seg[2] === 'columns' ? { kind: 'columns', panes: parsePanes(rawParam(search, 's')) } : SESSIONS;
    case 'p':
      return seg[2] ? { kind: 'project', project: decodeURIComponent(seg[2]) } : SESSIONS;
    case 's':
      // A brand-new session has no id yet; the placeholder is a bare machine
      // segment, and the id is filled in (with replaceState) once the agent
      // reports it.
      return seg[2] ? { kind: 'session', machineId: seg[2], sessionId: seg[3] ?? '' } : SESSIONS;
    case 'new': {
      const c = SessionCategory.safeParse(q.get('cat'));
      const machineId = q.get('m') ?? undefined;
      const cwd = q.get('cwd') ?? undefined;
      const n = q.get('n') ?? undefined;
      const r: Route = {
        kind: 'new',
        ...(c.success ? { cat: c.data } : {}),
        // Both or neither: half a target aims at nothing, and silently falling
        // back to "wherever the fleet was last" is the bug this pair fixes.
        ...(machineId && cwd ? { machineId, cwd } : {}),
        ...(q.get('create') === '1' ? { create: true } : {}),
        ...(n && /^[a-z0-9]{1,16}$/.test(n) ? { n } : {}),
      };
      // Legacy: `cols` was the split this composer was opened from. The split
      // holds the composer as a pane now, so the old link becomes that split.
      const cols = parsePanes(rawParam(search, 'cols'));
      if (cols.length && cols.length < COL_MAX) return { kind: 'columns', panes: cleanPanes([...cols, r]) };
      return r;
    }
    case 'team': {
      const t = seg[2] ?? 'overview';
      return { kind: 'team', tab: TEAM_TABS.includes(t as TeamTab) ? (t as TeamTab) : 'overview' };
    }
    case 'files': {
      const machineId = seg[2];
      if (!machineId) return { kind: 'files' };
      const root = q.get('root') ?? undefined;
      if (!root) return { kind: 'files', machineId };
      const p = safeRel(q.get('p'));
      const f = q.get('f') ?? undefined;
      return { kind: 'files', machineId, root, ...(p ? { p } : {}), ...(f ? { f } : {}) };
    }
    case 'projects': {
      const machineId = seg[2];
      if (!machineId) return { kind: 'projects' };
      const cwd = q.get('cwd') ?? undefined;
      return {
        kind: 'projects',
        machineId,
        ...(cwd ? { cwd } : {}),
        ...(q.get('adopt') === '1' ? { adopt: true } : {}),
      };
    }
    case 'board': {
      const owner = q.get('owner') ?? undefined;
      const project = q.get('project') ?? undefined;
      const since = parseBoardSince(q.get('since'));
      const card = q.get('card') ?? undefined;
      const col = SessionStage.safeParse(q.get('col'));
      return {
        kind: 'board',
        ...(owner ? { owner } : {}),
        ...(project ? { project } : {}),
        ...(since ? { since } : {}),
        ...(card ? { card } : {}),
        ...(col.success ? { col: col.data } : {}),
      };
    }
    case 'reports': {
      const id = seg[2];
      return id && /^[0-9a-f]{32}$/.test(id) ? { kind: 'reports', id } : { kind: 'reports' };
    }
    // Legacy addresses: three rail items that became tabs of Настройки. They
    // parse to the tab so a bookmark still opens the right screen; the address
    // bar is corrected by `normalizeEntryPath`, the same way `/w/admin` is.
    case 'hardware':
      return { kind: 'settings', tab: 'hardware' };
    // Память and Профиль became sections of Аккаунт (the tab strip is four tabs).
    case 'memory':
    case 'profile':
      return { kind: 'settings', tab: 'overview' };
    case 'start':
      return { kind: 'start' };
    case 'settings': {
      const t = seg[2];
      if (t === 'start') return { kind: 'start' };
      return {
        kind: 'settings',
        tab: SETTINGS_TAB_SEGMENTS.includes(t as SettingsTab) ? (t as SettingsTab) : 'overview',
      };
    }
    default:
      return SESSIONS;
  }
}

/**
 * Where this build is mounted, without its trailing slash: `''` for the normal
 * deploy at the domain root, `'/v2'` for a preview built with `--base=/v2/`.
 *
 * Vite substitutes `import.meta.env` at build time, so the root build
 * constant-folds this to `''` and every path below is unchanged — a preview
 * mount costs the production bundle nothing.
 *
 * Read through a guard rather than as `import.meta.env.BASE_URL` directly:
 * OUTSIDE Vite there is no `import.meta.env` at all, and this is module-level
 * code, so a bare property read throws while the module is still loading. That
 * is not hypothetical — `web/test` runs under plain node, several of those
 * tests reach this file through `Blocks → BudgetCard → router`, and the whole
 * file died on import with a `BASE_URL of undefined` that named neither the
 * test nor the router.
 */
const META_ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
export const BASE = (META_ENV?.BASE_URL || '/').replace(/\/+$/, '');

/** The canonical path for a Route, mount included. */
export function pathFor(r: Route): string {
  return BASE + pathForMount(r);
}

/** A pane's own address without the mount prefix — what the tab store keeps. */
export function paneAddress(p: PaneRoute): string {
  return pathForMount(p);
}

/** The canonical path for a Route — the only place URLs are constructed. */
function pathForMount(r: Route): string {
  switch (r.kind) {
    case 'sessions':
      return '/w/sessions';
    case 'columns':
      // Built by hand rather than with URLSearchParams: the parts are already
      // encoded, and the separators (`:` and `,`) are legal in a query — letting
      // URLSearchParams re-encode them turns a readable, shareable split URL
      // into %3A/%2C soup.
      return r.panes.length ? `/w/sessions/columns?s=${panesParam(r.panes)}` : '/w/sessions/columns';
    case 'project':
      return `/w/p/${encodeURIComponent(r.project)}`;
    case 'session':
      return `/w/s/${r.machineId}/${r.sessionId}`;
    case 'new': {
      const parts: string[] = [];
      if (r.cat) parts.push(`cat=${r.cat}`);
      if (r.machineId && r.cwd) {
        parts.push(`m=${encodeURIComponent(r.machineId)}`);
        parts.push(`cwd=${encodeURIComponent(r.cwd)}`);
      }
      if (r.create) parts.push('create=1');
      if (r.n) parts.push(`n=${r.n}`);
      return parts.length ? `/w/new?${parts.join('&')}` : '/w/new';
    }
    case 'team':
      return r.tab === 'overview' ? '/w/team' : `/w/team/${r.tab}`;
    case 'projects': {
      if (!r.machineId) return '/w/projects';
      const parts: string[] = [];
      // Absolute, so it rides in the query for the reason `files` states: as a
      // path segment it becomes %2F soup, and proxies normalise paths.
      if (r.cwd) parts.push(`cwd=${encodeURIComponent(r.cwd)}`);
      if (r.adopt) parts.push('adopt=1');
      return parts.length ? `/w/projects/${r.machineId}?${parts.join('&')}` : `/w/projects/${r.machineId}`;
    }
    case 'files': {
      if (!r.machineId) return '/w/files';
      const parts: string[] = [];
      if (r.root) parts.push(`root=${encodeURIComponent(r.root)}`);
      // `p` is built by hand for the same reason `panesParam` is: its slashes are
      // what make a deep path readable and shareable, and URLSearchParams would
      // turn them into %2F.
      if (r.p) parts.push(`p=${r.p}`);
      if (r.f) parts.push(`f=${encodeURIComponent(r.f)}`);
      return parts.length ? `/w/files/${r.machineId}?${parts.join('&')}` : `/w/files/${r.machineId}`;
    }
    case 'settings':
      return r.tab === 'overview' ? '/w/settings' : `/w/settings/${r.tab}`;
    case 'board': {
      const parts: string[] = [];
      if (r.owner) parts.push(`owner=${encodeURIComponent(r.owner)}`);
      if (r.project) parts.push(`project=${encodeURIComponent(r.project)}`);
      if (r.since) parts.push(`since=${r.since}`);
      if (r.card) parts.push(`card=${encodeURIComponent(r.card)}`);
      if (r.col) parts.push(`col=${r.col}`);
      return parts.length ? `/w/board?${parts.join('&')}` : '/w/board';
    }
    case 'reports':
      return r.id ? `/w/reports/${r.id}` : '/w/reports';
    case 'start':
      return '/w/start';
    default: {
      // Every kind has an address above. This is the compiler check the file's
      // header promises: add a Route and TypeScript asks here where it lives.
      const exhaustive: never = r;
      void exhaustive;
      return '/w/sessions';
    }
  }
}

/**
 * Where we are in OUR OWN history, in both directions.
 *
 * `history.length` cannot answer either question: it counts the whole tab,
 * including the pages visited before this app was opened, and it never shrinks
 * when you go back. So the position rides INSIDE each entry as `state.d`, which
 * the browser hands back on popstate and after a reload — exact, and ours.
 *
 * `back` is that position. `ahead` is how many entries we have stepped back
 * past and could step forward into; it cannot ride in the entry, because
 * nothing in the DOM knows how much history lies in front of you. It is counted
 * here instead: every back step adds one, every forward step removes one, and a
 * PUSH clears it — pushing while standing mid-history destroys the forward
 * entries, exactly as the browser does.
 *
 * This is the pair the shell's own chrome draws (`NavArrows`). The window has
 * no browser toolbar — on Windows it now has no title bar either — so these two
 * arrows are the only way back that exists inside it.
 */
function depthOf(state: unknown): number {
  const d = (state as { d?: unknown } | null)?.d;
  return typeof d === 'number' && d > 0 ? d : 0;
}
// Guarded because this runs at import and `web/test` imports this file under
// plain node, where there is no `history` and no `window`.
const DOM = typeof window !== 'undefined' && typeof history !== 'undefined';
let depth = DOM ? depthOf(history.state) : 0;
let ahead = 0;

export function canGoBack(): boolean {
  return depth > 0;
}
export function canGoForward(): boolean {
  return ahead > 0;
}
export function goBack() {
  if (depth > 0) history.back();
}
export function goForward() {
  if (ahead > 0) history.forward();
}

// Registered at import, before any component mounts, so both counters are
// already right by the time `useRoute`'s own popstate listener re-renders.
if (DOM) {
  window.addEventListener('popstate', () => {
    const next = depthOf(history.state);
    // A popstate is a step in one direction or the other; the entry's own depth
    // says which, and that is more reliable than remembering what we asked for
    // (the user's own Back button and a swipe both arrive here too).
    if (next < depth) ahead += depth - next;
    else if (next > depth) ahead = Math.max(0, ahead - (next - depth));
    depth = next;
    announce();
  });
}

const listeners = new Set<() => void>();
function announce() {
  for (const fn of listeners) fn();
}

// The shell's start (`RESTORE_FLAG`): put back the last screen BEFORE anything
// reads the route. Module init, not a render — `tabs.ts` imports this module
// and reconciles its groups against the URL at its own init, so a restore done
// later in `App` would leave it holding groups for the bare list. The window
// that arrived with the flag is the shell's MAIN window; it alone owns the
// remembered address (`RESTORE_OWNER`, per window in sessionStorage), so a
// second app window — same profile, same localStorage — cannot overwrite the
// split the main window is to reopen.
export const RESTORE_OWNER = 'cc-restore-owner';
/** Set by an explicit sign-out until the next sign-in: nothing is remembered
 *  in between (the address of the person who left must not be written back by
 *  the reload that follows). Cleared by `App` once a viewer is known. */
export const RESTORE_PAUSED = 'cc-restore-paused';
if (DOM) {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has(RESTORE_FLAG)) {
      sessionStorage.setItem(RESTORE_OWNER, '1');
      const last = storageGet(LAST_ROUTE_KEY) ?? '';
      const cut = last.indexOf('?');
      const at = last
        ? restorableAddress(cut < 0 ? last : last.slice(0, cut), cut < 0 ? '' : last.slice(cut))
        : null;
      const here = restorableAddress(location.pathname, location.search) ?? location.pathname;
      history.replaceState(history.state, '', (at ?? here) + location.hash);
    }
  } catch {
    /* no storage: the list, as before */
  }
}

// Remember where the main window is, for the shell's next start. Every route
// change passes through `announce`, `replaceSearch` included, so adding or
// closing a column is remembered too.
if (DOM) {
  const remember = () => {
    try {
      if (sessionStorage.getItem(RESTORE_OWNER) !== '1' || sessionStorage.getItem(RESTORE_PAUSED) === '1') return;
    } catch {
      return;
    }
    const at = restorableAddress(location.pathname, location.search);
    if (!at) return;
    // Private mode: nothing to come back to, which is the old behaviour.
    storageSet(LAST_ROUTE_KEY, at);
  };
  listeners.add(remember);
  // A full document load (a reload, the shell moving this window) announces
  // nothing, so the address it arrived at is recorded here.
  remember();
}

/** Hear every route change — `navigate`, Back/Forward, a replace — outside
 *  React. The tab store (tabs.ts) subscribes at import, so it has already
 *  caught up by the time `useRoute` re-renders anything. */
export function subscribeRoute(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Which group of the split holds a session as a BACKGROUND tab (tabs.ts).
 * A session chosen outside the panes opens where it already has a tab — in
 * that group, not as a second tab in the focused one. Registered by the tab
 * store; the router does not import it (tabs.ts imports the router).
 */
let tabLocator: ((to: Route) => number | null) | null = null;
export function setTabLocator(fn: (to: Route) => number | null) {
  tabLocator = fn;
}

/**
 * Which pane of the split has focus — the one everything chosen OUTSIDE the
 * panes opens in.
 *
 * Module state, not URL: it changes on every click into a pane, and writing it
 * to the address would put "which pane I touched last" into every link anyone
 * shares, and re-render every route listener per click. Losing it is cheap —
 * after a reload it is the first pane.
 */
let splitFocus = 0;
const focusListeners = new Set<() => void>();

export function getSplitFocus(): number {
  return splitFocus;
}
export function setSplitFocus(i: number) {
  if (i === splitFocus) return;
  splitFocus = Math.max(0, i);
  for (const fn of focusListeners) fn();
}
export function useSplitFocus(): number {
  const [f, setF] = useState(splitFocus);
  useEffect(() => {
    const sync = () => setF(splitFocus);
    focusListeners.add(sync);
    sync();
    return () => {
      focusListeners.delete(sync);
    };
  }, []);
  return f;
}

/**
 * Where a navigation lands when the screen is split: into a pane.
 *
 * Returns the split with that pane replaced, or `null` when nothing has to move
 * because the session asked for is already on screen — then only the focus
 * moves to it. The rules, in order:
 *   1. a session already in some pane → focus that pane (a second pane of the
 *      same session would be a second writer to one transcript);
 *   2. a composer while some pane already holds one → that pane (two plain
 *      composers share one draft); a session just started → the pane of the
 *      composer it came from (the focused one if it is a composer);
 *   3. otherwise the focused pane.
 *
 * Exported for the unit tests; `navigate` is its only caller.
 */
export function intoPane(panes: PaneRoute[], focus: number, to: Route): { panes: PaneRoute[]; focus: number } | { focus: number } {
  const pane = asPane(to);
  if (!pane) return { focus };
  const slot = paneSlot(pane);
  const same = slot ? panes.findIndex((p) => paneSlot(p) === slot) : -1;
  if (same >= 0 && pane.kind === 'session' && pane.sessionId) return { focus: same };
  const f = Math.min(Math.max(0, focus), panes.length - 1);
  let at = same;
  // A session just started takes the pane of the composer that started it —
  // the focused one, since sending is a press inside it; failing that, the
  // first composer on screen. With several composers (the tab strip's «+»),
  // «the composer's slot» no longer names one pane.
  if (pane.kind === 'session' && !pane.sessionId) {
    const cur = panes[f];
    if (cur && isStartPane(cur)) at = f;
    else if (at < 0) at = panes.findIndex(isStartPane);
  }
  if (at < 0) at = f;
  const next = panes.slice();
  next[at] = pane;
  return { panes: next, focus: at };
}

/**
 * Where «Новый чат» lands: in a column of its OWN, beside what is on screen
 * (25.09.2026, by request) — starting a conversation should not take away the
 * one you are reading. Only when the split is already full (`COL_MAX`) does it
 * take the focused pane, the way any other navigation does.
 *
 *   - nothing to go beside (the landing, the composer, a session still
 *     starting) → just the composer;
 *   - a composer already in the split → focus it (two composers share one
 *     draft — `cleanPanes` would drop the second anyway);
 *   - one screen, or a split with room → that plus a composer, focused;
 *   - a full split → `null`: the caller navigates normally, into the pane.
 *
 * Exported for the unit tests.
 */
export function newChatRoute(
  route: Route,
  focus: number,
  /** «Новый чат в этом проекте» — the pencil on a project in the side panel
   *  (08.10.2026: it used to be a plain link, so it replaced whatever the
   *  focused pane held instead of opening beside it the way «Новый чат» does).
   *  An aim re-aims the composer already on screen rather than adding a second. */
  aim?: { machineId: string; cwd: string },
): { route: Route; focus: number } | null {
  const NEW: PaneRoute = aim ? { kind: 'new', machineId: aim.machineId, cwd: aim.cwd } : { kind: 'new' };
  if (route.kind === 'columns') {
    const start = route.panes.findIndex(isStartPane);
    const sp = start >= 0 ? route.panes[start] : undefined;
    // Any composer — plain or aimed at a project — keeps its aim, unless this
    // press names a project of its own.
    if (sp && !(sp.kind === 'session' && !sp.sessionId)) {
      if (!aim) return { route, focus: start };
      const panes = route.panes.slice();
      // Keep the composer's own `n`: its draft is stored under it.
      panes[start] = sp.kind === 'new' && sp.n ? { ...NEW, n: sp.n } : NEW;
      return { route: { kind: 'columns', panes }, focus: start };
    }
    if (route.panes.length >= COL_MAX) return null;
    // A session still starting holds the composer's slot; the new composer
    // cannot sit beside it, so it takes that pane (the session keeps going
    // and appears in the list).
    if (start >= 0) {
      const panes = route.panes.slice();
      panes[start] = NEW;
      return { route: { kind: 'columns', panes }, focus: start };
    }
    return { route: { kind: 'columns', panes: [...route.panes, NEW] }, focus: route.panes.length };
  }
  const pane = asPane(route);
  // A composer on screen already — plain, aimed, or one of the strip's «+» —
  // stays as it is, the way it does inside a split: replacing it would hide
  // the draft typed in it.
  if (route.kind === 'new') return { route: aim ? (route.n ? { ...NEW, n: route.n } : NEW) : route, focus: 0 };
  if (!pane || isStartPane(pane)) return { route: NEW, focus: 0 };
  return { route: { kind: 'columns', panes: [pane, NEW] }, focus: 1 };
}

/**
 * Push or replace a route.
 *
 * `replace` matters more than it looks: the moment a new session's real id
 * arrives its placeholder URL must be replaced rather than pushed, or every
 * new session leaves a dead entry in the history. Same for a pane added to or
 * removed from the split — rearranging what is on screen is not travel.
 *
 * While the screen is split, a navigation to any single screen goes INTO the
 * focused pane (`intoPane`) — that is what makes the split a division of the
 * screen rather than a place you leave by clicking anything. A click inside a
 * pane focuses that pane first (pointerdown precedes click), so a screen inside
 * a pane moves itself without knowing it is in one. `whole: true` is for the
 * few callers that mean the whole window: editing the split itself, dissolving
 * a split of one, the phone redirect.
 */
export function navigate(to: Route | string, opts: { replace?: boolean; whole?: boolean } = {}) {
  if (typeof to !== 'string' && to.kind !== 'columns' && !opts.whole && DOM) {
    const cur = parseRoute(location.pathname, location.search);
    if (cur.kind === 'columns' && cur.panes.length > 1) {
      const held = tabLocator?.(to);
      if (held !== null && held !== undefined && held < cur.panes.length) setSplitFocus(held);
      const r = intoPane(cur.panes, splitFocus, to);
      setSplitFocus(r.focus);
      if (!('panes' in r)) {
        announce();
        return;
      }
      to = { kind: 'columns', panes: r.panes };
    }
  }
  const path = typeof to === 'string' ? to : pathFor(to);
  if (path === location.pathname + location.search) return;
  // A replace stays at the current position by definition — it overwrites the
  // entry rather than adding one — and leaves whatever is ahead alone.
  if (opts.replace) history.replaceState({ d: depth }, '', path);
  else {
    depth += 1;
    // Pushing from mid-history throws away the forward entries. The browser
    // does this to its own stack; not mirroring it here would leave an arrow
    // lit with nowhere to go.
    ahead = 0;
    history.pushState({ d: depth }, '', path);
  }
  announce();
}

/**
 * How the desktop shell opens a session from a clicked toast.
 *
 * The shell used to do a full page load onto `/w/s/…`, which collapsed the
 * split to one session and dropped whatever was half-typed — on every click,
 * and clicking a toast is also how people dismiss one. Through `navigate` a
 * session chosen from outside the panes behaves like a click on its row: the
 * pane already holding it takes focus, otherwise it opens in the focused pane.
 * Published only inside the shell (`__HEGAI_SHELL__`, set before this runs);
 * the caller is `open_session` in `windows/src-tauri/src/hub/mod.rs`, which
 * falls back to the full navigation when this is absent.
 */
if (DOM && (window as { __HEGAI_SHELL__?: string }).__HEGAI_SHELL__) {
  (window as { __HEGAI_OPEN_SESSION__?: (m: string, s: string) => void }).__HEGAI_OPEN_SESSION__ = (
    machineId: string,
    sessionId: string,
  ) => {
    if (machineId && sessionId) navigate({ kind: 'session', machineId, sessionId });
  };
}

/** Whether each arrow has anywhere to go, kept in sync with every navigation. */
export function useHistoryEnds(): { back: boolean; forward: boolean } {
  const [ends, setEnds] = useState(() => ({ back: canGoBack(), forward: canGoForward() }));
  useEffect(() => {
    const sync = () => setEnds({ back: canGoBack(), forward: canGoForward() });
    listeners.add(sync);
    // `announce()` already fires from the popstate handler above, so this only
    // has to catch navigations that do not pass through it.
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return ends;
}

/** Current route, kept in sync with back/forward and with `navigate`. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname, location.search));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(location.pathname, location.search));
    listeners.add(sync);
    window.addEventListener('popstate', sync);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  return route;
}


/**
 * Props that turn any destination into a REAL link.
 *
 * Every screen here has a URL, but for a while nothing in the app was an
 * `<a href>` — the rail, the session rows and the cards were all buttons
 * calling `navigate()`. The routes worked and deep links opened, yet none of
 * the things a browser gives you for free did: no ⌘-click into a new tab, no
 * middle-click, no "copy link address", no status-bar preview of where a row
 * goes, and nothing for a screen reader to announce as a link. In a control
 * plane where keeping three sessions open in three tabs is the normal way to
 * work, that is a real loss.
 *
 * So: render an `<a>`, spread this, and keep the SPA behaviour for the plain
 * left click while letting the browser handle every modified click itself.
 * `defaultPrevented` is honoured so a row can still host its own buttons.
 */
export function linkProps(to: Route, opts: { replace?: boolean } = {}) {
  return {
    href: pathFor(to),
    onClick(e: ReactMouseEvent) {
      if (e.defaultPrevented) return;
      // button 0 is the primary click; anything else is the browser's business
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to, opts);
    },
  };
}

/** Rewrite the current URL without adding history (used to strip ?invite=…). */
export function replaceSearch(search: string) {
  history.replaceState({ d: depth }, '', location.pathname + search);
  announce();
}
