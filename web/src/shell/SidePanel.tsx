import { useCallback, useRef, useState, type CSSProperties } from 'react';
import { ArrowSquareOut, Bell, NotePencil, Search, X } from '../icons.js';
import { ScopeSwitch } from './ScopeSwitch.js';
import { OWN_WINDOW_FLAG, linkProps, pathFor } from '../router.js';
import { ownWindowsSafe } from './useSessionMenu.js';
import { PhotoOr } from '../components/Avatar.js';
import type { CentralState } from '../useCentral.js';
import type { RunIndex } from '../lib.js';
import { SessionsPane } from './SessionsPane.js';
import type { RailTarget } from './navModel.js';

/**
 * The side panel: ONE column holding search, «Новый чат», the destinations and
 * the session list.
 *
 * It replaces a pair — a permanent 68px icon rail plus a context column that
 * existed only inside Сессии. That pair had two problems and they were the same
 * problem. The navigation and the work lived in different containers, so the
 * column could collapse and the rail could not, and the column simply vanished
 * on every other screen: on Файлы or Команда there was no list of sessions at
 * all, and getting back to one cost a click to Сессии first. Meanwhile the rail
 * spent 68 permanent pixels on four icons.
 *
 * Now there is one container and two states of it. Collapsed, it is not
 * mounted and the top bar carries the controls; expanded, this. The list is
 * always one glance away and never a navigation.
 *
 * What it deliberately does NOT own: the width and the collapse flag. Those are
 * `usePersistentSidebar` in App, because the rail needs to know them too.
 */
export function SidePanel({
  central: c,
  machines,
  machineFilter,
  onMachineFilter,
  selected,
  runIndex,
  favorites,
  onSelect,
  onToggleFav,
  drilled,
  onDrillChange,
  onSessionMenu,
  viewerId,
  width,
  collapsed = false,
  resizing,
  onStartResize,
  active,
  onNewSession,
  onAddColumn,
  foot,
  othersWork = false,
  unread = 0,
  notifOpen = false,
  onBell,
}: {
  central: CentralState;
  machines: CentralState['machines'];
  machineFilter: string;
  onMachineFilter: (id: string) => void;
  selected: Set<string>;
  runIndex: RunIndex;
  favorites: Set<string>;
  onSelect: (machineId: string, sessionId: string) => void;
  onToggleFav: (key: string) => void;
  drilled: boolean;
  onDrillChange: (v: boolean) => void;
  onSessionMenu: (machineId: string, sessionId: string, x: number, y: number) => void;
  viewerId?: string;
  /** Is anybody else's work in the snapshot — see `ScopeSwitch`. */
  othersWork?: boolean;
  /** The bell in the head: its count, whether its popover is open, and the
   *  press (App owns the popover, which the top bar hosts). */
  unread?: number;
  notifOpen?: boolean;
  onBell?: () => void;
  width: number;
  /** Folded away (27.09.2026): the panel stays mounted and slides to 0 width,
   *  as ChatGPT's does, instead of vanishing in one frame. `inert` keeps the
   *  hidden list out of Tab order and screen readers. */
  collapsed?: boolean;
  resizing: boolean;
  onStartResize: (e: React.PointerEvent) => void;
  active: RailTarget;
  /** «Новый чат» — beside what is on screen (`newChatRoute`). With an aim it
   *  is a project's pencil: the same, with the composer pointed at that folder. */
  onNewSession: (aim?: { machineId: string; cwd: string }) => void;
  /** «+» on a row that is not on screen: add it to the split. */
  onAddColumn?: ((machineId: string, sessionId: string) => void) | null;
  /** The account row at the bottom — see `PanelFoot`. */
  foot?: PanelFootProps;
}) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  // App hands a fresh `onNewSession` every render; the list below is memoised,
  // so its project pencils get one stable function that calls the latest.
  const newChatRef = useRef(onNewSession);
  newChatRef.current = onNewSession;
  const newChatIn = useCallback((aim: { machineId: string; cwd: string }) => newChatRef.current(aim), []);
  const findRef = useRef<HTMLInputElement | null>(null);
  return (
    <aside
      className={`sidebar sidepanel${resizing ? ' resizing' : ''}${collapsed ? ' collapsed' : ''}`}
      style={{ '--sidebar-w': `${width}px` } as CSSProperties}
      // `inert` is not in this React's DOM types yet; an empty string is the
      // attribute's «on» value.
      {...(collapsed ? ({ inert: '' } as Record<string, string>) : {})}
      aria-hidden={collapsed || undefined}
      aria-label="Сессии и разделы"
    >
      {/* No head at all. The mark went first (drawn at two sizes in two places,
          so collapsing moved it), and now the collapse button has too — it is
          in the top bar, above this panel rather than inside it, because a
          control that hides its own container cannot stay under the cursor if
          it travels with it. */}
      {/* ONE row (27.09.2026, by request): the search field, «Новый чат»,
          «Новый чат в новом окне» and the four places, as icons.

          The search is a FIELD now, filtering the projects below in place —
          it used to be a button that opened the ⌘K palette, a modal over the
          whole app for what is a question about this list. ⌘K still opens the
          palette for everything else it does. */}
      {/* The head, ChatGPT's shape (13.10.2026, by request): «hegai.code» on
          the left — the iPhone drawer's wordmark, a link home — and two icons
          on the right: the bell (moved here from the top bar's corner) and
          the search. The search opens IN PLACE of the head, as on the iPhone,
          and filters the projects below; Esc or ✕ folds it back. */}
      <div className="side-top">
        {searching || query ? (
          <label className="side-find">
            <Search size={15} />
            <input
              ref={findRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => {
                if (!query) setSearching(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  setSearching(false);
                }
              }}
              placeholder="Поиск"
              aria-label="Поиск сессий и проектов"
              spellCheck={false}
            />
            <button
              type="button"
              className="side-find-x"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery('');
                setSearching(false);
              }}
              aria-label="Закрыть поиск"
            >
              <X size={13} />
            </button>
          </label>
        ) : (
          <>
            <a className="side-brand" {...linkProps({ kind: 'new' })} aria-label="Hegai Code, на главную">
              <b>hegai</b>
              <span className="side-brand-dot">.</span>
              <span className="side-brand-code">code</span>
            </a>
            <span className="spacer" />
            {onBell && (
              <button
                type="button"
                className={`icon-btn side-head-icon ${notifOpen ? 'active' : ''}`}
                onClick={onBell}
                title="Уведомления"
                aria-label="Уведомления"
                aria-expanded={notifOpen}
              >
                <Bell size={18} />
                {unread > 0 && <span className="nbadge">{unread > 9 ? '9+' : unread}</span>}
              </button>
            )}
            <button
              type="button"
              className="icon-btn side-head-icon"
              onClick={() => setSearching(true)}
              title="Поиск"
              aria-label="Поиск"
            >
              <Search size={18} />
            </button>
          </>
        )}
      </div>
      {/* «Мои · Команда · Все» — whose sessions THIS list shows, so it sits
          on the list (13.10.2026, by request: it was in the top bar). The
          bar keeps only the «Команда ✕» reminder for a collapsed panel.
          Renders nothing for a viewer without the switch. */}
      <div className="side-scope">
        <ScopeSwitch othersWork={othersWork} />
      </div>
      {/* Two labelled rows, not six bare icons (27.09.2026, by request —
          Claude's panel as the reference). A row of pictograms asked to be
          decoded; Настройки, Команда and Файлы are in the account popover at
          the foot already, so the panel keeps the two things you come to it
          for: a new chat and the board. «В новом окне» rides the new-chat row
          as a hover icon where the shell allows own windows. */}
      <nav className="side-rows" aria-label="Действия">
        <div className="side-row-wrap">
          <button type="button" className="side-row" onClick={() => onNewSession()}>
            <NotePencil size={16} />
            <span>Новый чат</span>
          </button>
          {ownWindowsSafe() && (
            <button
              type="button"
              className="icon-btn side-row-extra"
              onClick={() => window.open(`${pathFor({ kind: 'new' })}?${OWN_WINDOW_FLAG}=1`, '_blank', 'noopener')}
              title="Новый чат в новом окне"
              aria-label="Новый чат в новом окне"
            >
              <ArrowSquareOut size={15} />
            </button>
          )}
        </div>
        {/* Доска, Отчёты and Браузер moved to the account popover
            (13.10.2026, by request): the panel keeps the work. */}
      </nav>

      {/* Проекты · Файлы · Команда used to be rows here, and the machine chips
          (Все · buildbox-pc · MacBook …) above the list. Both went to the
          account menu / nowhere on 25.09.2026, by request: the panel is
          search, «Новый чат» and the projects — the work, not the places.
          The destinations are in the account popover (TopBar), one tap away. */}

      <SessionsPane
        activeRuns={c.listedRuns}
        machines={machines}
        machineFilter={machineFilter}
        onMachineFilter={onMachineFilter}
        selected={selected}
        runIndex={runIndex}
        favorites={favorites}
        onSelect={onSelect}
        onToggleFav={onToggleFav}
        drilled={drilled}
        onDrillChange={onDrillChange}
        onSessionMenu={onSessionMenu}
        viewerId={viewerId}
        onAddColumn={onAddColumn}
        onNewChatIn={newChatIn}
        showMachines={false}
        query={query}
      />

      {/* The foot is back (25.09.2026, by request): the account, the theme
          and the bell, moved DOWN from the top bar's right corner, which now
          holds only the limits. One row, not the two it once was — the
          objection to the earlier foot was the height, not the place. */}
      {foot && <PanelFoot {...foot} />}

      <div
        className="sidebar-resize"
        onPointerDown={onStartResize}
        title="Потянуть, чтобы изменить ширину"
        role="separator"
        aria-orientation="vertical"
      />
    </aside>
  );
}


export interface PanelFootProps {
  initials: string;
  /** Whose photo the account button tries — see `PhotoOr`. */
  userId?: string;
  /** Name, or email, of whoever is signed in. */
  name: string;
  accountOpen: boolean;
  onToggleAccount: () => void;
}

/**
 * Личный кабинет, at the bottom of the side panel. The theme went into its
 * popover and the bell up to the bar beside the limits (27.09.2026).
 *
 * The popovers these open are still mounted by the top bar (it is their
 * positioned host, and the phone uses them from there); with the panel open
 * the bar pins them to the panel's corner instead — `.acts-in-panel` in
 * styles.css — so a panel opens next to the button that opened it.
 */
function PanelFoot({ initials, userId, name, accountOpen, onToggleAccount }: PanelFootProps) {
  return (
    <div className="side-foot">
      <button
        type="button"
        className={`side-acc ${accountOpen ? 'active' : ''}`}
        onClick={onToggleAccount}
        title="Личный кабинет и настройки"
        aria-expanded={accountOpen}
      >
        <span className="acc-avatar acc-avatar-sm">
          <PhotoOr userId={userId}>{initials}</PhotoOr>
        </span>
        <span className="side-acc-name">{name}</span>
      </button>
    </div>
  );
}

