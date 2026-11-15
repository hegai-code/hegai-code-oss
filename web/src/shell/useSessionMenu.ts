import { useCallback, useMemo, useState } from 'react';
import type { MenuAction, MenuAt } from '../components/ContextMenu.js';
import { sessionKey } from '../lib.js';
import { COL_MAX, OWN_WINDOW_FLAG, navigate, pathFor, sessionPanes, setSplitFocus, type PaneRoute, type Route } from '../router.js';
import type { SessionRef } from '../appHooks.js';

/** Whether «Открыть в новом окне» is safe where this page runs: always in a
 *  browser (it is a tab), and inside the desktop shell only when the shell says
 *  it builds that window off its webview callback — see the menu item. */
/** Whether the desktop shell sends a link flagged `BROWSER_FLAG` to the system
 *  browser (shell 0.1.24+). False in a browser, where a new tab already is one. */
export function linksToBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as { __HEGAI_SHELL__?: string; __HEGAI_LINKS_TO_BROWSER__?: number };
  return !!w.__HEGAI_SHELL__ && w.__HEGAI_LINKS_TO_BROWSER__ === 1;
}

export function ownWindowsSafe(): boolean {
  if (typeof window === 'undefined') return true;
  const w = window as { __HEGAI_SHELL__?: string; __HEGAI_OWN_WINDOWS__?: number };
  return !w.__HEGAI_SHELL__ || w.__HEGAI_OWN_WINDOWS__ === 1;
}

/**
 * The right-click menu of a session row — what is in it, and what «Добавить в
 * колонку» means from wherever you are.
 *
 * The split used to be a place you visited: a tab called «Колонки» leading to
 * an empty screen with a picker on it, plus saved layouts on the hub to make
 * re-assembling one bearable. That is three mechanisms to say "show me these
 * two conversations side by side". The list already knows which sessions exist
 * and which one you are reading, so the split is built there instead: point at
 * the second one and say so.
 *
 * Which panes you currently have is read from the ROUTE, not from state:
 * `/w/s/:m/:s` is one pane, `/w/sessions/columns?s=…` is several, and a split
 * therefore stays a link you can send someone.
 */
export function useSessionMenu({
  route,
  favorites,
  onToggleFav,
  onOpen,
  onRename,
  onDelete,
  onClose,
  isClosed,
  canEdit,
  canRename,
}: {
  route: Route;
  favorites: Set<string>;
  onToggleFav: (key: string) => void;
  onOpen: (machineId: string, sessionId: string) => void;
  onRename: (target: SessionRef) => void;
  onDelete: (target: SessionRef) => void;
  onClose: (target: SessionRef) => void;
  /** Whether the session is already marked done — the row says «Вернуть в
   *  работу» rather than «Закрыть». */
  isClosed: (target: SessionRef) => boolean;
  /** A control-share member may drive a session but not rename or delete it. */
  canEdit: (target: SessionRef) => boolean;
  /** Wider than `canEdit`: a member who can start sessions may retitle. */
  canRename: (target: SessionRef) => boolean;
}) {
  const [at, setAt] = useState<MenuAt<SessionRef> | null>(null);

  const open = useCallback((machineId: string, sessionId: string, x: number, y: number) => {
    // A session the agent has not named yet has no address, so there is nothing
    // to open in a tab, copy, or put in a pane.
    if (!sessionId) return;
    setAt({ target: { machineId, sessionId }, x, y });
  }, []);
  const close = useCallback(() => setAt(null), []);

  /** What is on screen right now, as panes, in order — the split's panes, or
   *  the one screen a new pane would go beside. The landing and the composer
   *  are not «something to add it beside»: there the item would just mean
   *  «Открыть». */
  const panes: PaneRoute[] = useMemo(() => {
    if (route.kind === 'columns') return route.panes;
    if (route.kind === 'session') return route.sessionId ? [route] : [];
    if (route.kind === 'sessions' || route.kind === 'new') return [];
    return [route];
  }, [route]);

  const actions = useMemo<MenuAction<SessionRef>[]>(() => {
    const already = (t: SessionRef) =>
      sessionPanes(panes).some((p) => sessionKey(p.machineId, p.sessionId) === sessionKey(t.machineId, t.sessionId));
    return [
      {
        label: 'Открыть',
        run: (t) => onOpen(t.machineId, t.sessionId),
      },
      {
        // «Окне», not «вкладке». Inside the desktop shell there are no tabs,
        // and until now this item was a lie there in the other direction: the
        // shell's standing rule sends an app route to the window you already
        // have, so «в новой вкладке» silently replaced what you were reading.
        // The shell now honours `?w=1` from its own origin by building a real
        // second window (`wants_own_window` in windows/src-tauri/src/main.rs);
        // in a browser the same URL is an ordinary new tab. One label that is
        // true in both.
        label: 'Открыть в новом окне',
        // Not inside a shell that cannot do it. Every desktop shell up to
        // 0.1.17 built that window INSIDE the webview's own callback — on
        // Windows the whole app froze, on macOS it aborts — and those shells
        // stay installed until their owners update. A shell that builds it
        // safely says so (`__HEGAI_OWN_WINDOWS__`, `shell_init_script` in
        // windows/src-tauri/src/main.rs); in a browser it is a tab and always fine.
        when: ownWindowsSafe,
        run: (t) => window.open(`${pathFor({ kind: 'session', ...t })}?${OWN_WINDOW_FLAG}=1`, '_blank', 'noopener'),
      },
      {
        label: 'Добавить в колонку',
        // Only where there is something to add it BESIDE. With nothing open the
        // item would mean «открыть», which is the row above it.
        when: () => panes.length > 0,
        disabled: (t) =>
          (already(t) && 'Эта сессия уже в колонках') ||
          (panes.length >= COL_MAX && `Больше ${COL_MAX} колонок не поместится`),
        // `replace`: rearranging what is on screen is not travel, and a back
        // press should leave the split rather than peel it one pane at a time.
        // `whole`: this edits the split itself rather than opening something in
        // one of its panes. The new pane takes focus — it is what you just asked
        // to look at.
        run: (t) => {
          setSplitFocus(panes.length);
          navigate({ kind: 'columns', panes: [...panes, { kind: 'session', ...t }] }, { replace: true, whole: true });
        },
      },
      {
        label: 'Копировать ссылку',
        separated: true,
        run: (t) => {
          void navigator.clipboard?.writeText(location.origin + pathFor({ kind: 'session', ...t }));
        },
      },
      {
        label: 'В избранное',
        when: (t) => !favorites.has(sessionKey(t.machineId, t.sessionId)),
        run: (t) => onToggleFav(sessionKey(t.machineId, t.sessionId)),
      },
      {
        label: 'Убрать из избранного',
        when: (t) => favorites.has(sessionKey(t.machineId, t.sessionId)),
        run: (t) => onToggleFav(sessionKey(t.machineId, t.sessionId)),
      },
      {
        label: 'Переименовать',
        separated: true,
        when: canRename,
        run: onRename,
      },
      {
        label: 'Закрыть сессию',
        when: (t) => !isClosed(t),
        run: onClose,
      },
      {
        label: 'Вернуть в работу',
        when: isClosed,
        run: onClose,
      },
      {
        label: 'Удалить',
        danger: true,
        when: canEdit,
        run: onDelete,
      },
    ];
  }, [panes, favorites, onToggleFav, onOpen, onRename, onDelete, onClose, isClosed, canEdit, canRename]);

  /**
   * The side panel's «+» on a row: put this session in the split, from
   * wherever you are (25.09.2026, by request — it was only in the right-click
   * menu, where nobody finds it). With nothing open there is nothing to add it
   * BESIDE, so it simply opens. `null` when the split is full.
   */
  const addColumn = useMemo(() => {
    if (panes.length >= COL_MAX) return null;
    return (machineId: string, sessionId: string) => {
      const t = { machineId, sessionId };
      if (!panes.length) return onOpen(machineId, sessionId);
      if (sessionPanes(panes).some((p) => sessionKey(p.machineId, p.sessionId) === sessionKey(machineId, sessionId))) return;
      setSplitFocus(panes.length);
      navigate({ kind: 'columns', panes: [...panes, { kind: 'session', ...t }] }, { replace: true, whole: true });
    };
  }, [panes, onOpen]);

  return { at, open, close, actions, addColumn };
}
