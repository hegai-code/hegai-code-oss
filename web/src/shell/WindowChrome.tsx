import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw, SidebarIcon } from '../icons.js';
import { canGoBack, canGoForward, goBack, goForward, useHistoryEnds } from '../router.js';

/**
 * What the shell injects for a page that has to draw its own window frame.
 *
 * Windows has exactly one frameless mode and it takes the minimise, maximise
 * and close buttons with the frame, so on that platform the app draws them —
 * and needs a way to act on them. `windows/src-tauri/src/main.rs` installs this
 * object (`WINDOW_BRIDGE`) on its own windows only, over four commands granted
 * to the hub's origin by `capabilities/window-chrome.json`.
 *
 * On macOS (0.1.22+) the shell installs a DIFFERENT object under its own name,
 * `__HEGAI_MAC_WINDOW__` (`MacWindow` below): the window is `Overlay` (no title
 * strip, like Claude's app), the system still draws and drives the traffic
 * lights, and the page provides the two things a title bar did — drag, and
 * double-click to zoom. See `installMacChrome`. Its own name so that a web
 * build older than it never mistakes it for this one. Absent in a browser and
 * in older Mac shells, which keep a real (transparent) title bar.
 */
interface ShellWindow {
  startDragging: () => Promise<unknown>;
  minimize: () => Promise<unknown>;
  toggleMaximize: () => Promise<unknown>;
  close: () => Promise<unknown>;
  isMaximized: () => Promise<boolean>;
}

function shellWindow(): ShellWindow | null {
  return (window as { __HEGAI_WINDOW__?: ShellWindow }).__HEGAI_WINDOW__ ?? null;
}

/** The Windows shell's window bridge, or null anywhere else — for the menu bar,
 *  which exists only where the page draws the whole frame. */
export function windowsShell(): ShellWindow | null {
  if (typeof window === 'undefined') return null;
  return shellWindow();
}

interface MacWindow {
  startDragging: () => Promise<unknown>;
  toggleMaximize: () => Promise<unknown>;
  isFullscreen: () => Promise<boolean>;
}

function macWindow(): MacWindow | null {
  return (window as { __HEGAI_MAC_WINDOW__?: MacWindow }).__HEGAI_MAC_WINDOW__ ?? null;
}

/** The Mac shell with an `Overlay` window: traffic lights over our top bar. */
export function isMacOverlay(): boolean {
  return !!macWindow();
}

/**
 * The panel toggle and the two history arrows — the left end of the top bar.
 *
 * All three used to live elsewhere and none of them belonged there. The toggle
 * was inside the panel it hides, so collapsing moved the control you had just
 * pressed out from under the cursor and left a 68px strip of icons behind to
 * hold a copy of it. «Назад» was a lone arrow that existed because the desktop
 * window had no browser chrome, and it was deleted on the argument that the
 * session list is beside every screen now — which was true, and still left the
 * window with no way back through its own history.
 *
 * So: one row, at the top, in the order a browser puts them. Collapsed now
 * means the panel is GONE — not a strip — and this is where it comes back from.
 */
export function NavArrows({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const ends = useHistoryEnds();
  return (
    <div className="nav-arrows">
      <button
        className={`icon-btn nav-panel-toggle ${collapsed ? '' : 'active'}`}
        onClick={onToggle}
        title={collapsed ? 'Показать сессии' : 'Скрыть панель'}
        aria-label={collapsed ? 'Показать сессии' : 'Скрыть панель'}
        aria-pressed={!collapsed}
      >
        <SidebarIcon size={18} />
      </button>
      {/* Disabled rather than hidden, unlike the arrow this replaces. A pair
          that appears and disappears makes the controls beside it jump, and at
          the top-left of every screen that is the most expensive place in the
          app for anything to move. */}
      <button
        className="icon-btn"
        onClick={goBack}
        disabled={!ends.back}
        title="Назад"
        aria-label="Назад"
      >
        <ArrowLeft size={18} />
      </button>
      <button
        className="icon-btn"
        onClick={goForward}
        disabled={!ends.forward}
        title="Вперёд"
        aria-label="Вперёд"
      >
        <ArrowRight size={18} />
      </button>
      {/* «Обновить» — only inside the desktop shell (30.09.2026, by request).
          A browser has its own reload beside its own arrows; the shell's
          window has neither, and a page that got stuck (a dropped socket, a
          stale build after a deploy) had no way back short of quitting the
          app. A full reload: the drafts and the device cache survive it. */}
      {IN_SHELL && (
        <button
          className="icon-btn"
          onClick={() => location.reload()}
          title="Обновить"
          aria-label="Обновить"
        >
          <RefreshCw size={16} />
        </button>
      )}
    </div>
  );
}

const IN_SHELL =
  typeof window !== 'undefined' && !!(window as { __HEGAI_SHELL__?: string }).__HEGAI_SHELL__;

/**
 * Minimise, maximise/restore, close — drawn only where the shell asked for
 * them, which today is the Windows app and nowhere else.
 *
 * The glyphs are drawn rather than imported: these three are Windows' own
 * shapes (a line, a square, a cross at one weight), they are not in the icon
 * set, and Phosphor's nearest equivalents read as app icons rather than as
 * window controls. Sizes are the platform's — 46×32 hit areas, a 10px glyph.
 */
export function WindowButtons() {
  const [maximized, setMaximized] = useState(false);
  const win = shellWindow();

  useEffect(() => {
    if (!win) return;
    let alive = true;
    const sync = () => {
      void win.isMaximized().then((v) => {
        if (alive) setMaximized(!!v);
      }).catch(() => {});
    };
    sync();
    // The window can also be maximised by a double-click on the drag region, by
    // Win+↑ and by Aero snap, none of which come through these buttons.
    window.addEventListener('resize', sync);
    return () => {
      alive = false;
      window.removeEventListener('resize', sync);
    };
  }, [win]);

  if (!win) return null;
  return (
    <div className="win-buttons">
      <button className="win-btn" onClick={() => void win.minimize()} title="Свернуть" aria-label="Свернуть">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button
        className="win-btn"
        onClick={() => void win.toggleMaximize()}
        title={maximized ? 'Восстановить' : 'Развернуть'}
        aria-label={maximized ? 'Восстановить' : 'Развернуть'}
      >
        {/* One plain square in both states (27.09.2026, by request): the
            «restore» glyph drawn here was a broken outline that read as a
            rendering glitch; the tooltip says which way the press goes. */}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button className="win-btn danger" onClick={() => void win.close()} title="Закрыть" aria-label="Закрыть">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}

/** Whether this page is drawing a window frame — the top bar becomes the title
 *  bar when it is, and grows a drag region. */
export function hasWindowChrome(): boolean {
  return !!shellWindow() || isMacOverlay();
}

/** Drag the window by its top bar. `-webkit-app-region` is the Chromium way and
 *  WebView2 honours it, but it does not survive a remote origin reliably on
 *  every build, and it cannot express "everything except the buttons" without
 *  tagging each of them. One pointer handler on the bar is smaller and exact:
 *  a press that did not land on a control starts the system drag. */
export function dragProps() {
  // Windows only. The Mac drags from ONE document-level listener
  // (`installMacChrome`), which also covers the screens that have no top bar.
  const win = shellWindow();
  if (!win) return {};
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // Anything interactive keeps its own press.
      if ((e.target as HTMLElement).closest('button, a, input, [role="button"], [role="menu"], [role="dialog"], .modal-backdrop')) return;
      void win.startDragging();
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, a, input, [role="button"], [role="menu"], [role="dialog"], .modal-backdrop')) return;
      void win.toggleMaximize();
    },
  };
}

const INTERACTIVE =
  'button, a, input, textarea, select, label, summary, [role="button"], [role="tab"], [role="menuitem"], [contenteditable=""], [contenteditable="true"]';

/** Full-screen layers that can sit over the bar: a press on them is «close
 *  this», never «move the window» — `.notif-scrim` is the bar's OWN child and
 *  covers it while a popover is open. */
const OVERLAYS = '[class*="scrim"], [role="dialog"], [aria-modal="true"]';

/** Height of the drag strip on a screen that has no top bar (sign-in, the
 *  waiting card): the system's own title-bar height. `#root` starts below it
 *  there (`html.mac-shell:not(:has(.topbar))` in styles.css). */
const BARE_STRIP = 28;

/**
 * The Mac title bar's behaviour, rebuilt on the page — once, at startup.
 *
 * WKWebView does not honour `-webkit-app-region`, so there is no CSS way to say
 * "this bar moves the window". Instead one `mousedown` listener on the document:
 * a press on the top bar's own rectangle (or, where there is no bar, in the top
 * 28px) that did not land on a control starts the system drag; a second press
 * of a double-click zooms, as a title bar does. The rectangle check matters —
 * the bar's popovers are its DOM children and hang BELOW it, and a press on
 * their text must stay a text press.
 *
 * Also marks `<html>` so CSS can clear the traffic lights, and tracks native
 * fullscreen, where the lights are gone and the room left for them is not.
 */
export function installMacChrome(): void {
  if (typeof window === 'undefined') return;
  const win = macWindow();
  if (!win) return;
  const root = document.documentElement;
  root.classList.add('mac-shell');

  // Asked of the window, not guessed from geometry: a zoomed window with the
  // menu bar set to auto-hide is exactly the screen's size and still has its
  // traffic lights.
  const syncFullscreen = () => {
    void win.isFullscreen()
      .then((full) => root.classList.toggle('mac-fullscreen', !!full))
      .catch(() => {});
  };
  syncFullscreen();
  window.addEventListener('resize', syncFullscreen);

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    if (!target || target.closest(INTERACTIVE) || target.closest(OVERLAYS)) return;
    const bar = document.querySelector('.topbar');
    if (bar && !bar.contains(target)) return;
    const rect = bar?.getBoundingClientRect();
    const inBar = rect && rect.height > 0
      ? e.clientY >= rect.top && e.clientY <= rect.bottom && e.clientX >= rect.left && e.clientX <= rect.right
      : e.clientY <= BARE_STRIP;
    if (!inBar) return;
    e.preventDefault();
    if (e.detail === 2) void win.toggleMaximize().catch(() => {});
    else if (e.detail === 1) void win.startDragging().catch(() => {});
  });
}

export { canGoBack, canGoForward };
