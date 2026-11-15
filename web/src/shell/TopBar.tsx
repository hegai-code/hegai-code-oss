import { Bell, GearIcon, Globe, Menu } from '../icons.js';
import { openBrowser, useBrowserInfo } from '../components/browser/browserApi.js';
import { PhotoOr } from '../components/Avatar.js';
import type { CentralState } from '../useCentral.js';
import type { ThemePref } from '../useTheme.js';
import { NotificationCenter } from '../components/NotificationCenter.js';
import { ThemePicker } from '../components/ThemePicker.js';
import { FontScalePicker } from '../components/FontScalePicker.js';
import { linkProps } from '../router.js';
import { DESTINATIONS } from './navModel.js';
import { pluralRu } from '../lib.js';
import { NavArrows, WindowButtons, dragProps, hasWindowChrome, isMacOverlay, windowsShell } from './WindowChrome.js';
import { MenuBar } from './MenuBar.js';
import { UsageMeter, type GatewayQuota } from '../components/UsageMeter.js';
import { ScopeChip } from './ScopeSwitch.js';
import { storageSet } from '../storage.js';

/**
 * Notifications and the account — the controls that follow the app
 * everywhere, plus the two popovers they open (the theme lives inside the
 * account's).
 *
 * Extracted from `TopBar` because the phone's bar shows limits where these
 * icons would be and moves the icons into the drawer's ⚙ sheet — but the
 * popovers they open still need a positioned host, and the bar is it. (It was
 * also what the lens bar folded into, back when three of the screens replaced
 * the top bar with a switcher; that bar is gone and every screen has this one.)
 * The popovers are `position:absolute`, so any host must be a positioned box.
 */
export function TopActions({
  central: c,
  themePref,
  onChooseTheme,
  notifOpen,
  setNotifOpen,
  settingsOpen,
  setSettingsOpen,
  displayName,
  setDisplayName,
  token,
  setToken,
  localDev,
  totalSessions,
  onJump,
  accountInitials,
  accountUserId,
  popovers = true,
  buttons = true,
  bell = buttons,
}: {
  central: CentralState;
  themePref: ThemePref;
  onChooseTheme: (pref: ThemePref) => void;
  notifOpen: boolean;
  setNotifOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
  localDev: boolean;
  totalSessions: number;
  onJump: (machineId: string, sessionId: string) => void;
  /** Two letters for the account button — the control the gear used to be. */
  accountInitials: string;
  /** Whose photo the account button tries — see `PhotoOr`. */
  accountUserId?: string;
  /** Whether the two popovers mount HERE. They always do now — this bar is on
   *  screen on a phone as well, since the session list stopped being a page of
   *  its own. Kept as a prop for a second host that does not want them. */
  popovers?: boolean;
  /** Render the three buttons. `false` keeps only the popovers.
   *
   *  The phone's top bar shows limits where these icons used to be, and the
   *  icons moved into the drawer's ⚙ sheet. But the panels they open still need
   *  a positioned host, and this bar is it — `.notif-pop` and `.settings-pop`
   *  are already sized to the viewport on a phone, so they land as full-width
   *  panels under the bar. The rail's bell has always worked this way: the
   *  control is in one place, the popover in another, over the same lifted
   *  state in App. */
  buttons?: boolean;
  /** Render the bell. On a desk it stays in the bar beside the limits even
   *  when the account lives at the foot of the side panel (27.09.2026, by
   *  request): notifications are about the work, and the corner beside the
   *  usage meter is where every other app keeps them. */
  bell?: boolean;
}) {
  const settingsLink = linkProps({ kind: 'settings', tab: 'overview' });
  const browserOn = useBrowserInfo() !== null;
  return (
    <>
      {bell && (
      <button
        className={`icon-btn ${notifOpen ? 'active' : ''}`}
        title="Уведомления"
        aria-label="Уведомления"
        aria-expanded={notifOpen}
        onClick={() => {
          setNotifOpen((v) => !v);
          setSettingsOpen(false);
          c.markRead();
          c.requestNotifyPermission();
        }}
      >
        <Bell size={18} />
        {c.unread > 0 && <span className="nbadge">{c.unread > 9 ? '9+' : c.unread}</span>}
      </button>
      )}
      {/* The theme switch that stood here moved into this popover
          (27.09.2026, by request): it is a setting you make once, not a
          control that needs a slot in the bar. */}
      {buttons && (<>
      {/* The account, where the gear used to be.
          A cog is a label for "options"; an avatar is a label for "you", and
          everything behind this control — your name, your filters, your
          Настройки, your session — is the second thing. It also stops the
          account being drawn twice: it had a row at the foot of the side panel
          as well, and that panel is for the work.
          Still the same popover: the display name, the dev token and the two
          list filters live nowhere else, so turning this into a plain link to
          /w/settings would strand them. The popover's own first row is that
          link. */}
      <button
        className={`icon-btn acc-btn ${settingsOpen ? 'active' : ''}`}
        title="Аккаунт и настройки"
        aria-label="Аккаунт и настройки"
        onClick={() => {
          setSettingsOpen((v) => !v);
          setNotifOpen(false);
        }}
      >
        <span className="acc-avatar acc-avatar-sm">
          <PhotoOr userId={accountUserId}>{accountInitials}</PhotoOr>
        </span>
      </button>
      </>)}

      {popovers && notifOpen && (
        <NotificationCenter central={c} onJump={onJump} onClose={() => setNotifOpen(false)} />
      )}
      {popovers && settingsOpen && (
        <>
          <div className="notif-scrim" onClick={() => setSettingsOpen(false)} />
          <div className="settings-pop" role="dialog" aria-label="Аккаунт">
            {/* The way to the full screen. The gear this replaced led nowhere
                but here, and Настройки — devices, teams, the enrollment code —
                was reachable only from the panel's account row, which is gone.
                First, because it is the only NAVIGATION in a panel of toggles. */}
            <a
              className="sp-link"
              {...settingsLink}
              // Composed, not replaced: a bare `onClick` here used to override
              // the link's own, and the browser then did a FULL page load to
              // /w/settings — which also threw away a split.
              onClick={(e) => {
                setSettingsOpen(false);
                settingsLink.onClick(e);
              }}
            >
              <GearIcon size={15} />
              <span>Настройки</span>
            </a>
            {/* Проекты · Файлы · Команда — moved here from the side panel
                (25.09.2026, by request): the panel keeps the work, the places
                live with the account. */}
            {DESTINATIONS.filter((d) => !d.hasContext).map((d) => {
              const lp = linkProps(d.route);
              return (
                <a
                  key={d.id}
                  className="sp-link"
                  {...lp}
                  onClick={(e) => {
                    setSettingsOpen(false);
                    lp.onClick(e);
                  }}
                >
                  <d.icon size={15} />
                  <span>{d.label}</span>
                </a>
              );
            })}
            {/* The cloud browser — here since 13.10.2026 (by request), with
                Доска and Отчёты above it; drawn only when the hub has one. */}
            {browserOn && (
              <button
                type="button"
                className="sp-link"
                onClick={() => {
                  setSettingsOpen(false);
                  openBrowser();
                }}
              >
                <Globe size={15} />
                <span>Браузер</span>
              </button>
            )}
            <div className="sp-title">Этот браузер</div>
            <div className="sp-row">
              <span className="sp-label">Тема</span>
              <ThemePicker value={themePref} onChoose={onChooseTheme} />
            </div>
            <div className="sp-row">
              <span className="sp-label">Шрифт</span>
              <FontScalePicker />
            </div>
            <label className="sp-row">
              <span className="sp-label">Имя</span>
              <input
                className="token"
                value={displayName}
                placeholder="Как вас зовут"
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  storageSet('cc-name', e.target.value);
                }}
                spellCheck={false}
              />
            </label>
            {localDev && (
              <label className="sp-row" style={{ marginTop: 12 }}>
                <span className="sp-label">Токен доступа</span>
                <input
                  className="token"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    storageSet('cc-token', e.target.value);
                  }}
                  spellCheck={false}
                />
              </label>
            )}
            {/* Scripted runs and scratch-directory runs are hidden from every
                list by default: a cron loop makes dozens of sessions a day and
                a smoke harness leaves a temp project behind per pass, and both
                bury the work people did. The count is here so the filter is
                never a silent one. */}
            <label className="sp-row sp-check" style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={c.showAutomated}
                onChange={(e) => c.setShowAutomated(e.target.checked)}
              />
              <span className="sp-label">
                Показывать автоматические
                {!c.showAutomated && c.automatedHidden > 0 ? ` (${c.automatedHidden})` : ''}
              </span>
            </label>
            {/* Closed sessions leave every list the moment the button is
                pressed, so the way back has to be visible — and the count is
                what makes the filter honest rather than a disappearance. */}
            <label className="sp-row sp-check">
              <input
                type="checkbox"
                checked={c.showClosed}
                onChange={(e) => c.setShowClosed(e.target.checked)}
              />
              <span className="sp-label">
                Показывать закрытые
                {!c.showClosed && c.closedHidden > 0 ? ` (${c.closedHidden})` : ''}
              </span>
            </label>
            <div className="sp-conn">
              <span className={`dot ${c.status === 'open' ? 'on' : 'off'}`} />
              {c.status === 'open'
                ? `${c.machines.length} ${pluralRu(c.machines.length, ['машина', 'машины', 'машин'])} · ${totalSessions} ${pluralRu(totalSessions, ['сессия', 'сессии', 'сессий'])}`
                : c.status === 'connecting'
                  ? 'подключаемся…'
                  : 'нет связи'}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The bar across the main column only — the side panel runs the full viewport
 * height beside it. Carries usage meters, notifications and the account.
 *
 * It is on EVERY screen again. Three of them used to replace it with a lens
 * switcher that hosted the same chrome in its slots, on the argument that two
 * stacked bands cost 101px. With the switcher gone (there is one way to read
 * the session list, and the split is a layout rather than a lens) there is no
 * second band to stack — so the rule is simply one bar, everywhere.
 */
export function TopBar({
  central: c,
  gatewayQuota,
  themePref,
  onChooseTheme,
  notifOpen,
  setNotifOpen,
  settingsOpen,
  setSettingsOpen,
  displayName,
  setDisplayName,
  token,
  setToken,
  localDev,
  totalSessions,
  onJump,
  accountInitials,
  accountUserId,
  sidebarCollapsed,
  onToggleSidebar,
  popovers = true,
  onOpenDrawer,
  actionsInPanel = false,
  othersWork = false,
  onNewChat,
  onOpenPalette,
}: {
  central: CentralState;
  gatewayQuota: GatewayQuota | null;
  themePref: ThemePref;
  onChooseTheme: (pref: ThemePref) => void;
  notifOpen: boolean;
  setNotifOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
  localDev: boolean;
  totalSessions: number;
  onJump: (machineId: string, sessionId: string) => void;
  /** Two letters for the account button, which is what the gear became. */
  accountInitials: string;
  /** Whose photo the account button tries — see `PhotoOr`. */
  accountUserId?: string;
  /** The panel's state and its toggle. They live here because the toggle must
   *  not move when the panel does — see `NavArrows`. */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** Passed straight through to `TopActions` — see the note there. */
  popovers?: boolean;
  /** Opens the session drawer. Phone only: below 861px the context column is
   *  not rendered at all, so this row is where the session list is reached
   *  from — the same ☰ the session header carries, in the one other place a
   *  phone can be. */
  onOpenDrawer?: () => void;
  /** The side panel is open and carries account · theme · bell in its foot:
   *  the bar draws none of the three, and pins their popovers to the panel. */
  actionsInPanel?: boolean;
  /** Is anybody else's work in the snapshot — see `ScopeSwitch`. */
  othersWork?: boolean;
  /** «Файл → Новый чат» and «Перейти → Найти…» of the Windows menu bar. */
  onNewChat?: () => void;
  onOpenPalette?: () => void;
}) {
  const menuBar = !onOpenDrawer && !!windowsShell();
  return (
    <header className={`topbar ${hasWindowChrome() ? 'titlebar' : ''} ${isMacOverlay() ? 'mac' : ''} ${actionsInPanel ? 'acts-in-panel' : ''} ${!onOpenDrawer && !sidebarCollapsed ? 'bell-in-panel' : ''}`} {...dragProps()}>
      {onOpenDrawer && (
        <button
          className="icon-btn topbar-menu"
          onClick={onOpenDrawer}
          title="Сессии"
          aria-label="Сессии"
        >
          <Menu size={18} />
        </button>
      )}
      {/* The window's own controls, and the app's navigation, in the order a
          browser puts them: panel, back, forward.
          All three moved HERE, and the move is the point. The panel toggle used
          to sit inside the panel it hides — so collapsing carried the control
          you had just pressed away with it, and a 68px strip of icons had to
          stay behind holding a copy. Now collapsing hides the panel entirely
          and this button is where it comes back from, which is also why it is
          the one control that must never move. */}
      <NavArrows collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
      {/* Windows only: the menu bar, right after the panel toggle and the
          arrows — the order ChatGPT's Windows app uses (13.10.2026, by
          request). No program icon in front: the toggle leads the bar on
          every platform and never moves. See `MenuBar`. */}
      {menuBar && (
        <MenuBar
          onNewChat={onNewChat}
          onOpenPalette={onOpenPalette}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
          themePref={themePref}
          onChooseTheme={onChooseTheme}
        />
      )}
      {/* Nothing else leads this row.
          «Назад» used to, and it existed for ONE reason: the desktop shell's
          window had the stock OS frame and no browser chrome, so Alt+← was the
          only way back and nothing on screen said so. Two things retired it.
          The side panel is now on every screen, so the session list — the one
          place that is never a dead end — is always one click away rather than
          one history step back. And the shell's window is getting its own
          chrome (see `windows/src-tauri`), which is where a back arrow belongs
          if it comes back at all.
          The brand mark and the un-collapse button went earlier, for their own
          reasons; between them this bar is now only the readouts and the three
          controls on the right. */}
      <div className="spacer" />

      {/* `onOpenDrawer` is passed by App only on a phone, so it doubles as the
          bar's own answer to "am I narrow?" — no second prop, no second
          breakpoint to keep in sync with usePhone and the media query. */}
      {/* Whose sessions the lists show, beside the limits (29.09.2026, by
          request). On a phone the bar has no room for three segments next to
          the pill, so the switch lives at the head of the session drawer and
          the bar keeps only a «Команда ✕» reminder while it is off «Мои». */}
      {/* The switch itself moved into the side panel (13.10.2026, by request);
          the bar keeps the «Команда ✕» reminder, so a list off «Мои» is never
          silent while the panel is collapsed. */}
      {(onOpenDrawer || sidebarCollapsed) && <ScopeChip />}
      <UsageMeter central={c} gatewayQuota={gatewayQuota} compact={!!onOpenDrawer} />
      <TopActions
        central={c}
        buttons={!onOpenDrawer && !actionsInPanel}
        // The bell lives in the side panel's head (13.10.2026, by request),
        // and ONLY there since 14.10.2026: the bar used to draw it while the
        // panel was collapsed, which read as a second bell («только в шторке
        // оставим»). The panel toggle, top left, is one click from it.
        bell={false}
        themePref={themePref}
        onChooseTheme={onChooseTheme}
        notifOpen={notifOpen}
        setNotifOpen={setNotifOpen}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        displayName={displayName}
        setDisplayName={setDisplayName}
        token={token}
        setToken={setToken}
        localDev={localDev}
        totalSessions={totalSessions}
        onJump={onJump}
        accountInitials={accountInitials}
        accountUserId={accountUserId}
        popovers={popovers}
      />
      {/* Last, hard against the right edge, because that is where Windows puts
          them and muscle memory is the whole argument. Renders nothing at all
          unless the Windows shell installed its bridge — a browser has its own
          frame, and on the Mac the system draws the traffic lights. */}
      <WindowButtons />
    </header>
  );
}
