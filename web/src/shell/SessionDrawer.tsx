import { useEffect, useState } from 'react';
import { Bell, CodeIcon, GearIcon, Globe, MonitorIcon, MoonIcon, Plus, Ruler, Search, SunIcon, X } from '../icons.js';
import { openBrowser, useBrowserInfo } from '../components/browser/browserApi.js';
import { linkProps } from '../router.js';
import { DESTINATIONS } from './navModel.js';
import type { CentralState } from '../useCentral.js';
import type { ThemePref } from '../useTheme.js';
import type { RunIndex } from '../lib.js';
import { SessionsPane } from './SessionsPane.js';
import { ScopeSwitch } from './ScopeSwitch.js';

/**
 * The phone's way between sessions without leaving the one you are in.
 *
 * On a phone the session list and the session are two SCREENS: `/w/sessions` is
 * the list, and opening a session replaces it (`.body:has(.workspace) .sidebar.
 * ctxcol { display: none }`). Switching sessions therefore meant leaving the
 * conversation, and inside the installed app — where the tab bar is hidden while
 * a session is open — the only door left was the back button in a bar that also
 * carried the limits pill and four icons nobody taps mid-conversation.
 *
 * So the bar goes and this comes: the same list, over the conversation, one tap
 * from the ☰ in the session header. It is the same `SessionsPane` the desktop
 * column renders — deliberately, because two hand-written session lists is how
 * the phone ends up with a different idea of what a project is.
 *
 * Mounted only while open. The pane is not cheap (the whole project tree, a
 * second `ProjectList` beside the column's own), and the drawer is reachable
 * only from a control that CSS hides above 860px.
 */
/** Everything except «Сессии» — this panel IS Сессии. These used to be a row of
 *  icon buttons across the top of the drawer, ahead of the list; they are in the
 *  ⚙ sheet at the foot now. The list is what the drawer is FOR, and three
 *  destinations visited a few times a week were standing between you and it on
 *  every single open. */
const NAV = DESTINATIONS.filter((d) => d.id !== 'sessions');

export function SessionDrawer({
  central: c,
  machines,
  selected,
  runIndex,
  favorites,
  onSelect,
  onToggleFav,
  onSessionMenu,
  viewerId,
  onClose,
  onNewSession,
  onSearch,
  themePref,
  onCycleTheme,
  onOpenNotifications,
  othersWork = false,
}: {
  central: CentralState;
  machines: CentralState['machines'];
  selected: Set<string>;
  runIndex: RunIndex;
  favorites: Set<string>;
  onSelect: (machineId: string, sessionId: string) => void;
  onToggleFav: (key: string) => void;
  /** Long-press on a row — the touch spelling of the desk's right click. */
  onSessionMenu: (machineId: string, sessionId: string, x: number, y: number) => void;
  viewerId?: string;
  onClose: () => void;
  onNewSession: () => void;
  onSearch: () => void;
  /** Theme lives in the ⚙ sheet now: on a phone the top bar shows limits
   *  instead of the three chrome icons, and this is where they went. */
  themePref: ThemePref;
  onCycleTheme: () => void;
  /** Closes the drawer and opens the notification popover, which is mounted by
   *  the top bar — the same arrangement the rail's bell already uses. */
  onOpenNotifications: () => void;
  /** Is anybody else's work in the snapshot — see `ScopeSwitch`. */
  othersWork?: boolean;
}) {
  // Per-placement, not shared with the column's list: two mounted `ProjectList`s
  // drill independently, and one flag for both would have the invisible one
  // deciding what the visible one shows.
  const [drilled, setDrilled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const browser = useBrowserInfo() !== null;
  // Жест «увести обратно» живёт на `.app` (`useDrawerDrag`), а не здесь: тяга
  // интерактивная, и вести карточку со шторкой на одно число пикселей может
  // только тот, кто знает обе. Скрим и ✕ остаются — жест без видимой опоры
  // знает только тот, кто его сделал.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menuOpen) setMenuOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, menuOpen]);

  const themeIcon =
    themePref === 'light' ? (
      <SunIcon size={18} />
    ) : themePref === 'dark' ? (
      <MoonIcon size={18} />
    ) : themePref === 'vscode' ? (
      <CodeIcon size={18} />
    ) : (
      <MonitorIcon size={18} />
    );
  const themeLabel =
    themePref === 'light' ? 'Светлая' : themePref === 'dark' ? 'Тёмная' : themePref === 'vscode' ? 'VS Code' : 'Системная';

  return (
    <>
      <div className="sdrawer-scrim" onClick={onClose} />
      <aside className="sdrawer" role="dialog" aria-label="Сессии">
        <div className="sdrawer-top">
          <button className="sdrawer-row" onClick={onSearch}>
            <Search size={18} /> Поиск
          </button>
          <button className="icon-btn sdrawer-x" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>
        {/* «Мои · Команда · Все» — the phone's place for the top bar's switch
            (the bar has no room beside the limits). Renders nothing for a
            viewer without it. */}
        <div className="sdrawer-scope">
          <ScopeSwitch othersWork={othersWork} />
        </div>
        {/* The machine chips are off here — see `showMachines` in SessionsPane.
            The filter is pinned to «all» rather than read from App, so the
            drawer can never inherit a machine filter set on a desktop and then
            hide half the list with no visible control to explain it. */}
        <SessionsPane
          activeRuns={c.listedRuns}
          machines={machines}
          machineFilter="all"
          onMachineFilter={() => {}}
          showMachines={false}
          selected={selected}
          runIndex={runIndex}
          favorites={favorites}
          onSelect={onSelect}
          onToggleFav={onToggleFav}
          drilled={drilled}
          onDrillChange={setDrilled}
          onSessionMenu={onSessionMenu}
          viewerId={viewerId}
        />
        {/* Starting work is the one ACTION in a panel that is otherwise a list of
            places, so it sits apart from them — at the bottom edge, where a
            thumb is. It FLOATS over the list now rather than sitting in a
            footer: a docked bar took a fixed slice off the top of a phone's
            already short list, and this way the list runs under it (see the
            scroll padding in styles.css) and the button is in the same place
            however far you have scrolled. */}
        <div className="sdrawer-fab">
          {/* «Чат», not «Новый чат». The `+` already says «new», so the word
              was the icon again in longhand — and it was the whole reason this
              button reached across the drawer instead of sitting in the corner
              as one. */}
          <button className="sdrawer-new" onClick={onNewSession}>
            <Plus size={17} /> Чат
          </button>
          <button
            className={`sdrawer-cog ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            title="Ещё"
            aria-label="Ещё"
          >
            {/* No unread count on it. The badge said what the session list
                directly underneath says per row, in the one spot that floats
                over that list — a number about the thing it was covering. The
                rail's bell still carries it where there is no list to read. */}
            <GearIcon size={20} />
          </button>
        </div>
        {menuOpen && (
          <>
            <div className="sdm-scrim" onClick={() => setMenuOpen(false)} />
            <div className="sdrawer-menu" role="menu">
              <button
                className="sdm-row"
                onClick={onCycleTheme}
                title={`Тема: ${themePref}`}
              >
                {themeIcon} Тема<span className="sdm-val">{themeLabel}</span>
              </button>
              <button
                className="sdm-row"
                onClick={() => {
                  setMenuOpen(false);
                  onClose();
                  onOpenNotifications();
                }}
              >
                <Bell size={18} /> Уведомления
                {c.unread > 0 && <span className="sdm-val attn">{c.unread}</span>}
              </button>
              {/* The cloud browser — beside the bell, as in the desk's top bar. */}
              {browser && (
                <button
                  className="sdm-row"
                  onClick={() => {
                    setMenuOpen(false);
                    onClose();
                    openBrowser();
                  }}
                >
                  <Globe size={18} /> Браузер
                </button>
              )}
              {/* TEMPORARY, and it is here for one reason: an installed PWA has
                  NO ADDRESS BAR, so `?layout=1` — the only instrument that can
                  measure the band of empty space under the composer on the
                  device where it happens — could not be reached from inside the
                  app at all. It was asked for three times before anyone noticed
                  that. Delete this row and `layoutProbe.ts` together once that
                  strip is understood. */}
              <button
                className="sdm-row"
                onClick={() => {
                  setMenuOpen(false);
                  onClose();
                  void import('../layoutProbe.js').then((m) => m.mountLayoutProbe());
                }}
              >
                <Ruler size={18} /> Замер вёрстки
              </button>
              <div className="sdm-sep" />
              {NAV.map((d) => (
                <a
                  key={d.id}
                  className="sdm-row"
                  {...linkProps(d.route)}
                  onClickCapture={() => {
                    setMenuOpen(false);
                    onClose();
                  }}
                >
                  <d.icon size={18} /> {d.label}
                </a>
              ))}
              <a
                className="sdm-row"
                {...linkProps({ kind: 'settings', tab: 'overview' })}
                onClickCapture={() => {
                  setMenuOpen(false);
                  onClose();
                }}
              >
                <GearIcon size={18} /> Настройки
              </a>
              <div className="sdm-sep" />
              {/* The two filters that silently shorten every list in the app.
                  They were in the top bar's gear popover, which the phone no
                  longer mounts — and a filter with no visible control is the
                  thing the counts here exist to prevent. */}
              <label className="sdm-row sdm-check">
                <input
                  type="checkbox"
                  checked={c.showAutomated}
                  onChange={(e) => c.setShowAutomated(e.target.checked)}
                />
                Автоматические
                {!c.showAutomated && c.automatedHidden > 0 ? <span className="sdm-val">{c.automatedHidden}</span> : null}
              </label>
              <label className="sdm-row sdm-check">
                <input
                  type="checkbox"
                  checked={c.showClosed}
                  onChange={(e) => c.setShowClosed(e.target.checked)}
                />
                Закрытые
                {!c.showClosed && c.closedHidden > 0 ? <span className="sdm-val">{c.closedHidden}</span> : null}
              </label>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
