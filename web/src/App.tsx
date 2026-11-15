import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionSummary, ImageInput, FileInput, ViewerContext, SessionCategory } from '@cc-remote/shared';
import { useCentral, type StartSettings } from './useCentral.js';
import { isGoModel } from './components/run-settings.js';
import { useTheme } from './useTheme.js';
import { storageGet, storageRemove, storageSet } from './storage.js';
import { usePersistentSidebar, useFavorites, useSessionActions, useOwnedProjects, useBudget, SeatContext, type Seat } from './appHooks.js';
import { hasOthersWork, indexRuns, sessionKey, projectTargets, type ExtraTarget } from './lib.js';
import { setScopeAvailable } from './components/MineOnly.js';
import { StartScreen } from './components/StartScreen.js';
/**
 * Screens behind their own chunk.
 *
 * Everything used to be one 975 KB module, so opening the session list paid for
 * Команда, Файлы, Настройки and the split view — screens most visits never
 * touch. These are all ROUTE boundaries: nothing here renders until its address
 * does, so the download can wait for the same moment.
 *
 * What is deliberately NOT here: StartScreen, SessionWorkspace and the side
 * panel. They are the landing, and deferring them would trade a smaller
 * download for a blank screen on arrival.
 */
const Appearance = lazy(() => import('./Appearance.js').then((m) => ({ default: m.Appearance })));
const BrowserSettings = lazy(() => import('./components/browser/BrowserSettings.js').then((m) => ({ default: m.BrowserSettings })));
const CommandPalette = lazy(() => import('./CommandPalette.js').then((m) => ({ default: m.CommandPalette })));
const Files = lazy(() => import('./components/files/Files.js').then((m) => ({ default: m.Files })));
const Hardware = lazy(() => import('./components/Hardware.js').then((m) => ({ default: m.Hardware })));
const Projects = lazy(() => import('./components/projects/Projects.js').then((m) => ({ default: m.Projects })));
const ProjectSessions = lazy(() => import('./components/projects/ProjectSessions.js').then((m) => ({ default: m.ProjectSessions })));
const Board = lazy(() => import('./components/board/Board.js').then((m) => ({ default: m.Board })));
const Reports = lazy(() => import('./components/reports/Reports.js').then((m) => ({ default: m.Reports })));
const AppsTab = lazy(() => import('./components/AppsTab.js').then((m) => ({ default: m.AppsTab })));
const Onboarding = lazy(() => import('./components/Onboarding.js').then((m) => ({ default: m.Onboarding })));
import { GroupDropZone, TabStrip } from './components/TabStrip.js';
import { makeNewTabRoute, makeTabInfo } from './components/tabInfo.js';
import { useTabGroups } from './tabs.js';
const SessionColumns = lazy(() => import('./components/SessionColumns.js').then((m) => ({ default: m.SessionColumns })));
const SettingsTabs = lazy(() => import('./TeamViews.js').then((m) => ({ default: m.SettingsTabs })));
const TeamUsage = lazy(() => import('./TeamViews.js').then((m) => ({ default: m.TeamUsage })));
const TeamAudit = lazy(() => import('./TeamViews.js').then((m) => ({ default: m.TeamAudit })));
const TeamMembers = lazy(() => import('./TeamViews.js').then((m) => ({ default: m.TeamMembers })));
const TeamOverview = lazy(() => import('./TeamViews.js').then((m) => ({ default: m.TeamOverview })));
const TeamProjects = lazy(() => import('./TeamViews.js').then((m) => ({ default: m.TeamProjects })));
const WorkspaceSettings = lazy(() => import('./TeamViews.js').then((m) => ({ default: m.WorkspaceSettings })));
const TeamAccess = lazy(() => import('./TeamAccess.js').then((m) => ({ default: m.TeamAccess })));
import { type GatewayPool, type GatewayQuota } from './components/UsageMeter.js';
import { ApiError, apiJsonOrNull } from './api.js';
import { teamApi } from './teamApi.js';
import { AccessPage } from './AccessPage.js';
import { LinkPage } from './LinkPage.js';
import { AppPage } from './AppPage.js';
import { SupportLoginPage } from './SupportLoginPage.js';
import { Landing } from './Landing.js';
import { SetupPage } from './SetupPage.js';
import { NativeSignInPage } from './NativeSignInPage.js';
import { SignInScreen } from './SignInScreen.js';
import { MfaEnrollPage, MfaScreen } from './MfaScreen.js';
import { pendingMfa, type MfaState } from './mfaApi.js';
import { isExternal, usePublicConfig } from './publicConfig.js';
import { AccessGate } from './components/AccessGate.js';
import { markOnboardingDone, onboardingDone } from './components/onboardingState.js';
import { needsOnboarding } from './components/useMachinePick.js';
import { HegaiMark } from './components/HegaiMark.js';
import { BROWSER_FLAG, LAST_ROUTE_KEY, OWN_WINDOW_FLAG, RESTORE_PAUSED, SESSIONS, navigate, newChatRoute, parseRoute, pathFor, replaceSearch, sessionPanes, setSplitFocus, splitRoute, useRoute, useSplitFocus, type ColRef, type PaneRoute, type Route } from './router.js';
import { destinationOf } from './shell/navModel.js';
import { canSeeUsageTab } from './usageModel.js';
import { LocalCache } from './localCache.js';
import { canInviteTo, canSwitchScope, isAccessActive, lastWorkspaceId, noteWorkspace, pickWorkspace, rememberWorkspace } from './shell/workspace.js';
import { showNotice } from './dialogs.js';
import { SidePanel } from './shell/SidePanel.js';
import { useSessionMenu } from './shell/useSessionMenu.js';
import { ContextMenu } from './components/ContextMenu.js';
import { usePhone } from './shell/usePhone.js';
import { useDrawerDrag } from './shell/useDrawerDrag.js';
import { SessionDrawer } from './shell/SessionDrawer.js';
import { TopBar } from './shell/TopBar.js';
import { SessionWorkspace } from './shell/SessionWorkspace.js';
import { ModalHost } from './shell/ModalHost.js';
import { BrowserSheetHost } from './components/browser/BrowserSheetHost.js';
import { TelegramSignedInBanner } from './components/TelegramSignIn.js';

/**
 * The two enrollment addresses that became sections of one page.
 *
 * They are not redirects to somewhere else — `Landing` IS both of them now — so
 * the page renders immediately and only the address bar is corrected, the same
 * way `normalizeEntryPath` corrects a moved rail route. Keeping them resolving
 * is not politeness: `/install` is in chat histories, in printed invitations
 * and in the copy of Настройки that mints codes, and a dead link there means a
 * person with a 15-minute code and nowhere to type it.
 */
const PUBLIC_SECTIONS: Record<string, string> = {
  '/install': '#machine',
  '/install/app': '#apps',
};

/** Internal edition only: our fleet's noise boxes, hidden from the sidebar (see ControlPlaneApp). */
const INTERNAL_HIDDEN_MACHINES = /^(cloud|chatapp|selectel)/i;

export function App() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  const section = PUBLIC_SECTIONS[path];
  if (section) {
    // Preserve `?code=` — Settings hands out `/install?code=…`, and Landing
    // reads it off the query to fill the field.
    history.replaceState(null, '', `/${location.search}${section}`);
    return <Landing />;
  }
  // «Вы вошли через Telegram как @x» must reach whichever page a Telegram
  // sign-in reloads into — /access and /link render outside the shell, so the
  // banner goes on them here, not inside ControlPlaneApp.
  if (location.pathname === '/access' || location.pathname === '/access/') return <><TelegramSignedInBanner /><AccessPage /></>;
  // The setup link of a customer's hub (`/setup#token=…`, local sign-in).
  if (location.pathname === '/setup' || location.pathname === '/setup/') return <SetupPage />;
  // The one-time link an operator prints to enrol an admin's authenticator.
  if (location.pathname === '/mfa-enroll' || location.pathname === '/mfa-enroll/') return <MfaEnrollPage />;
  // The mobile apps' own sign-in, opened in the system auth browser.
  if (location.pathname === '/native-signin' || location.pathname === '/native-signin/') return <NativeSignInPage />;
  // A machine sent the person here with its connection code (`/link?c=…`).
  if (location.pathname === '/link' || location.pathname === '/link/') return <><TelegramSignedInBanner /><LinkPage /></>;
  // What the phone QR code opens: a store for a phone, both buttons otherwise.
  if (location.pathname === '/app' || location.pathname === '/app/') return <AppPage />;
  // The one-time link the owner of a team passes to HegAI support. It renders
  // outside the shell: the person has no session yet.
  if (location.pathname === '/support-login' || location.pathname === '/support-login/') return <SupportLoginPage />;
  return <ControlPlaneApp />;
}

/**
 * `/` and any stray path land on the sessions list without leaving a history
 * entry, and addresses that moved are rewritten to where they moved to.
 *
 * Rewriting here rather than in `parseRoute` is the point: the old URL already
 * renders the right screen (parse handles that), and this makes the address bar
 * stop saying something that is no longer true. A bookmark outlives everyone's
 * memory of what the bookmark was for.
 */
const MOVED: Record<string, Route> = {
  // «Волны» became the Доступ tab of Команда.
  '/w/admin': { kind: 'team', tab: 'access' },
  // Three rail items became tabs of Настройки.
  '/w/hardware': { kind: 'settings', tab: 'hardware' },
  '/w/memory': { kind: 'settings', tab: 'overview' },
  '/w/profile': { kind: 'settings', tab: 'overview' },
  // Память and Профиль are sections of Аккаунт; «Начало» is the first-run screen.
  '/w/settings/memory': { kind: 'settings', tab: 'overview' },
  '/w/settings/profile': { kind: 'settings', tab: 'overview' },
  '/w/settings/start': { kind: 'start' },
  // The dashboard is gone; the list is the landing again.
  '/w': SESSIONS,
};

function normalizeEntryPath() {
  const moved = MOVED[location.pathname.replace(/\/$/, '')];
  if (moved) {
    history.replaceState(null, '', pathFor(moved));
    return;
  }
  // The desktop shell has already read `?w=1` and built the window; leaving it
  // in the address bar would put it into every link copied out of this window.
  // `replaceState`, so it is not a navigation and nothing re-renders for it.
  const q = new URLSearchParams(location.search);
  if (q.has(OWN_WINDOW_FLAG) || q.has(BROWSER_FLAG)) {
    q.delete(OWN_WINDOW_FLAG);
    q.delete(BROWSER_FLAG);
    const rest = q.toString();
    // Keep the fragment: a transcript link like `/w/new#take` now arrives with
    // the flag (`mdLinkHref`), and the hash is what opens its target.
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  }
  if (!location.pathname.startsWith('/w/')) {
    history.replaceState(null, '', pathFor(parseRoute(location.pathname, location.search)));
  }
}

function ControlPlaneApp() {
  const localDev = ['localhost', '127.0.0.1'].includes(location.hostname);
  const [token, setToken] = useState(() => localDev ? (storageGet('cc-token') ?? 'dev-token') : '');
  const [identity, setIdentity] = useState<ViewerContext | null>(null);
  const [authState, setAuthState] = useState<'loading' | 'ready' | 'unauthenticated' | 'offline' | 'mfa'>('loading');
  // The hub has a session for this person but it is pending a second factor.
  const [mfaState, setMfaState] = useState<MfaState | null>(null);
  /** A 401 may mean «signed in, second factor still owed» — ask the hub. */
  const refused = async () => {
    const owed = await pendingMfa();
    if (owed) {
      setMfaState(owed);
      setAuthState('mfa');
    } else {
      setAuthState('unauthenticated');
    }
  };
  // Which edition this hub is and which ways in it offers (`publicConfig.ts`).
  const publicConfig = usePublicConfig();
  // Not for a visitor who is being shown the PUBLIC page. This runs on every
  // render, not once on entry, so `/` → `/w/sessions` was reapplied by the next
  // state change after `Landing` had put the honest address back — and the
  // socket connecting guarantees such a render within a second. The result was
  // a public page permanently wearing a private address. While `authState` is
  // still 'loading' it must run, or a signed-in person's moved bookmark is
  // never corrected.
  if (authState !== 'unauthenticated') normalizeEntryPath();
  // Seeded from the last session so the hub socket opens at once, in the right
  // workspace, instead of after `/api/me` — see `lastWorkspaceId`.
  const [workspaceId, setWorkspaceId] = useState(lastWorkspaceId);
  useEffect(() => noteWorkspace(workspaceId), [workspaceId]);
  // Signed out: what this device kept of the fleet and its conversations goes
  // with the session, and so does the remembered workspace.
  useEffect(() => {
    if (authState !== 'unauthenticated') return;
    LocalCache.release();
    // Signed out: the next person on this profile must not reopen this
    // person's last screen (`RESTORE_FLAG` in router.ts).
    // Paused first, so nothing announced on this page writes it back.
    try {
      sessionStorage.setItem(RESTORE_PAUSED, '1');
    } catch {
      /* no storage */
    }
    storageRemove(LAST_ROUTE_KEY);
    noteWorkspace('');
  }, [authState]);
  // Right-hand info column in the session workspace.
  // Under 1200px «О сессии» is not a column beside the chat, it is a MODAL
  // SHEET over it — so restoring a remembered «open» there covers the
  // conversation and the whole composer the moment a session opens. Measured
  // 19.09.2026 on a 390px screen: the sheet came up by itself and the model
  // picker underneath it was 0×0 and behind a scrim, i.e. the control was not
  // merely hidden but untappable. A sheet opens when it is asked for.
  const [infoOpen, setInfoOpen] = useState(() => {
    const sheet = typeof matchMedia === 'function' && matchMedia('(max-width: 1199px)').matches;
    return sheet ? false : storageGet('cc-info') !== '0';
  });
  const toggleInfo = () =>
    setInfoOpen((v) => {
      storageSet('cc-info', v ? '0' : '1');
      return !v;
    });
  const [displayName, setDisplayName] = useState(() => storageGet('cc-name') ?? '');
  /** The hub socket will not open. Ask over plain HTTP whether that is the hub
   *  being unreachable — the reconnect banner's business, and nothing to
   *  interrupt anyone over — or the hub REFUSING this session, which the socket
   *  itself can never say: a browser hides the status of a failed upgrade.
   *
   *  Only a 401 moves anything. Before this, a session the hub had stopped
   *  accepting produced an empty screen and a reconnect loop that never ended,
   *  because nothing in an already-loaded tab ever asks again. */
  const recheckAuth = async () => {
    try {
      await teamApi.me();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) await refused();
    }
  };
  // No workspace yet means a first visit on this device: wait for `/api/me` to
  // pick one rather than open a socket on the personal workspace and throw it
  // away a moment later.
  const c = useCentral(token, {
    workspaceId: workspaceId || undefined,
    enabled: !!workspaceId && authState !== 'unauthenticated' && authState !== 'mfa',
    // Only once `/api/me` has said who this is — the cache must never show one
    // person's fleet to the next one signed in on this browser.
    cacheOwner: identity?.userId,
    onHandshakeFailing: recheckAuth,
  });
  const [gatewayQuota, setGatewayQuota] = useState<GatewayQuota | null>(null);
  // [community] The shared-subscription meter is the employees' figure. A
  // community seat has its own ceiling (`/api/llm-access.limits`) and the hub
  // does not hand it the pool's counter — so do not ask.
  const communityPlan = identity?.access?.plan === 'community';
  useEffect(() => {
    if (authState !== 'ready' || communityPlan) return;
    let alive = true;
    const load = () => apiJsonOrNull<{ gatewayQuota?: GatewayQuota; pools?: GatewayPool[]; ownPool?: string | null }>('/api/gateway-quota')
      .then((d) => {
        if (!alive) return;
        // `pools` (admins only) rides on the caller's own counter; with no
        // counter of their own, an `ok:false` carrier keeps the pill empty.
        const pools = d?.pools?.length ? d.pools : undefined;
        const ownPool = d?.ownPool ?? undefined;
        setGatewayQuota(d?.gatewayQuota ? { ...d.gatewayQuota, pools, ownPool } : pools ? { ok: false, pools, ownPool } : null);
      })
      .catch(() => {});
    load();
    const t = setInterval(load, 60_000); // probe refreshes every 5 min; keep UI lag under ~1 min
    return () => { alive = false; clearInterval(t); };
  }, [authState, communityPlan]);
  const refreshIdentity = async () => {
    try {
      let nextViewer = await teamApi.me();
      // A `/link` visit that had to sign in first comes back to `/`; take it
      // straight back to the code it was holding.
      // No storage: null — the person types the code again.
      const pendingLink = storageGet('cc-pending-link');
      if (pendingLink) {
        storageRemove('cc-pending-link');
        location.replace(`/link?c=${encodeURIComponent(pendingLink)}`);
        return;
      }
      const invite = new URLSearchParams(location.search).get('invite') ?? storageGet('cc-pending-invite');
      if (invite) {
        // [community] Pin the team that invited us, or the owner of their own
        // empty team would keep landing in it and never see the shared root.
        // A dead invitation (withdrawn, expired, for another address) is
        // dropped for good and said once; it must neither sign the person out
        // nor come back at every reload.
        let dead = false;
        try {
          const accepted = await teamApi.acceptInvitation(invite);
          if (accepted?.workspaceId) rememberWorkspace(accepted.workspaceId);
        } catch (err) {
          if (err instanceof ApiError && [400, 404, 410].includes(err.status)) dead = true;
          else throw err;
        }
        storageRemove('cc-pending-invite');
        replaceSearch('');
        if (dead) void showNotice('Приглашение недействительно: оно отозвано, истекло или адресовано другой почте.');
        nextViewer = await teamApi.me();
      }
      // Before anything reads the device cache as this person: a different
      // user than the one who filled it starts from an empty one.
      LocalCache.claimFor(nextViewer.userId);
      setIdentity(nextViewer);
      setAuthState('ready');
      // Signed in again: the main window may remember its screen once more.
      try {
        sessionStorage.removeItem(RESTORE_PAUSED);
      } catch {
        /* no storage */
      }
      // `|| ''`: an account may have neither a name nor an address, and
      // `displayName` is `.trim()`ed on every render below.
      setDisplayName((current) => current || nextViewer.fullName || nextViewer.email || '');
      // Unconditionally, on every refresh — not just when nothing is stored.
      // The old guard meant anyone who had ever picked "Моя работа" was pinned
      // to it forever, and with the switcher gone they would have had no way
      // out. The only stored preference is an explicit pin (accepted invite,
      // «Открыть» in Settings), which `pickWorkspace` honours first and drops
      // the moment it names a workspace the viewer no longer belongs to.
      setWorkspaceId(pickWorkspace(nextViewer).workspaceId);
    } catch (err) {
      const invite = new URLSearchParams(location.search).get('invite');
      if (invite) storageSet('cc-pending-invite', invite);
      // A hub that cannot be REACHED has not refused anyone. Every failure used
      // to land on the sign-in screen, which was harmless while an unreachable
      // hub also meant a blank page — but the app now boots from the service
      // worker's cache, so the first thing someone in a tunnel would see is an
      // invitation to log back into an account they never left, with a button
      // that cannot work either. `ApiError` is thrown only for an answer the
      // hub actually gave; a dropped fetch throws a TypeError.
      if (err instanceof ApiError && err.status === 401) await refused();
      else setAuthState(err instanceof ApiError ? 'unauthenticated' : 'offline');
    }
  };
  useEffect(() => { void refreshIdentity(); }, []);
  // Come back by itself when the network does.
  useEffect(() => {
    if (authState !== 'offline') return;
    const retry = () => void refreshIdentity();
    window.addEventListener('online', retry);
    const t = setInterval(retry, 15_000);
    return () => { window.removeEventListener('online', retry); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshIdentity is stable enough; re-subscribing per render would thrash
  }, [authState]);
  const { pref: themePref, cycle: cycleTheme, choose: chooseTheme } = useTheme();
  /** The editor tabs, one group per pane on screen (tabs.ts). */
  const tabGroups = useTabGroups();
  const route = useRoute();
  // Which pane of a split has focus — the side panel lights ITS destination.
  const splitFocus = useSplitFocus();
  // The URL is the source of truth for what is open — that is what makes deep
  // links, refresh-to-session and the back button work at all.
  // Memoized, not rebuilt: this is a PROP of the session list, and a fresh
  // object literal per render is exactly what stops the list from ever
  // bailing out of a re-render.
  const selected = useMemo(
    () => (route.kind === 'session'
      ? { machineId: route.machineId, sessionId: route.sessionId }
      : null),
    [route.kind === 'session' ? route.machineId : null, route.kind === 'session' ? route.sessionId : null],
  );
  /**
   * Everything ON SCREEN, for the list to mark «you are here».
   *
   * One pair is not enough any more: the split puts two to four sessions in
   * front of you, and a list that can only light one row leaves the others
   * unaccounted for — you cannot see what you already have open, which is
   * exactly the question «Добавить в колонку» is answered from.
   *
   * Keyed by `sessionKey` so the list compares strings rather than objects.
   */
  const openKeys = useMemo(() => {
    if (route.kind === 'columns') {
      return new Set(sessionPanes(route.panes).map((r) => sessionKey(r.machineId, r.sessionId)));
    }
    return new Set(selected?.sessionId ? [sessionKey(selected.machineId, selected.sessionId)] : []);
  }, [route, selected]);
  // A brand-new session in flight (no SessionSummary discovered yet). Started
  // from a composer that is a PANE of the split, its placeholder is that pane.
  const [pendingNew, setPendingNew] = useState<
    {
      machineId: string;
      cwd: string;
      project?: string;
      source?: 'claude' | 'codex';
      /** Started on an OpenCode Go model: the placeholder shows that mark too. */
      provider?: string;
      /** When it was sent — a start that never got an id stops blocking. */
      at: number;
    } | null
  >(null);
  // Sidebar search lives in the command palette (⌘K); the machine list is
  // always unfiltered.
  // Machine filter chips: narrow the side panel's list to one machine.
  const [machineFilter, setMachineFilter] = useState<string>('all');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The phone layout: one page and one drawer, no side panel and no rail.
  const phone = usePhone();
  // ProjectList is drilled into a project — hide the pinned region meanwhile.
  const [projDrilled, setProjDrilled] = useState(false);
  // The phone's session drawer (see SessionDrawer). Opened from the ☰, from the
  // scrim, and — since 22.09 — by a drag that CARRIES it: `useDrawerDrag` owns
  // the geometry, this flag owns only «куда встало, когда отпустили».
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Единственный слушатель жеста на весь шелл, как `AppShell` на телефоне: и
  // карточка, и сама шторка тянутся им, и оба едут на одно и то же число
  // пикселей, потому что число одно.
  const appRoot = useRef<HTMLDivElement>(null);
  const drawer = useDrawerDrag(appRoot, drawerOpen, setDrawerOpen);
  // Leaving for another place closes the drawer, whatever inside it did the
  // leaving. The drawer's own callbacks close it for a session row, «Чат» and
  // Поиск — but the project cards in its list carry plain LINKS («Новый чат в
  // проекте» ✎, the project heading), and those navigated with the drawer
  // still over the new screen (26.09.2026). One rule on the route instead of
  // one per control, so the next link added there cannot reopen this.
  const routePath = pathFor(route);
  const drawerRoute = useRef(routePath);
  useEffect(() => {
    if (drawerRoute.current === routePath) return;
    drawerRoute.current = routePath;
    setDrawerOpen(false);
  }, [routePath]);
  const viewer = c.viewer ?? identity;
  // [community] Switch the shell to another team: pin it, reconnect the socket.
  // `useCentral` reopens on a workspaceId change, and the socket's hello then
  // carries the new `viewer.workspace` every team screen is scoped to.
  const selectWorkspace = (workspaceId: string) => {
    rememberWorkspace(workspaceId);
    setWorkspaceId(workspaceId);
  };
  // [community] Gated = not yet activated (or suspended). Two sources can say
  // so: the REST identity (polled every 60 s by the gate) and the socket's
  // viewer (the hub pushes a fresh one on activation). Either saying "active"
  // opens the door — activation is one-way in practice, and a stale copy must
  // not hold a freshly activated person on the waiting card.
  const gated = !!identity && !isAccessActive(identity) && !(c.viewer && isAccessActive(c.viewer));
  // First run: computer · Claude and Codex · phone, full screen. Remembered per
  // person; `bump` re-renders when «Пропустить»/«Готово» is pressed on a route
  // that does not change (the auto-shown screen sits on whatever route it hit).
  const [, bumpOnboarding] = useState(0);
  // Once the auto-shown screens are up they stay until finished: signing in to
  // Claude in step two would otherwise satisfy the condition and swap the
  // screen for the shell before the person reaches the phone step.
  const onboardingOpen = useRef(false);
  // Decided ONCE per signed-in user, at the first hydrated render. Re-deciding
  // on every render would throw someone whose Claude token expired mid-work out
  // of an open session, and with storage blocked (markOnboardingDone a no-op)
  // «Пропустить» would reopen it at once.
  const onboardingDecided = useRef<string | undefined>(undefined);
  const finishOnboarding = () => {
    const autoShown = onboardingOpen.current;
    onboardingOpen.current = false;
    if (viewer?.userId) markOnboardingDone(viewer.userId);
    bumpOnboarding((n) => n + 1);
    // Shown over a deep link (a session from a push or a colleague): stay there.
    if (route.kind === 'start' || !autoShown) navigate({ kind: 'sessions' });
  };
  // When the door opens because of the POLL, the socket still holds the empty
  // snapshot it got while gated; a reload is the honest fix for a transition
  // that happens once. When the hub pushed it, the socket is already right.
  const wasGated = useRef(false);
  useEffect(() => {
    if (gated) { wasGated.current = true; return; }
    if (wasGated.current && c.viewer && !isAccessActive(c.viewer)) location.reload();
    wasGated.current = false;
  }, [gated, c.viewer]);
  // Desktop sidebar (collapse + drag-resize) and favorites, both persisted.
  const sidebar = usePersistentSidebar();
  const { favorites, toggleFav } = useFavorites();

  // Control-share roots for the StartScreen, so a first-time member with no
  // sessions of their own still has somewhere to start one. Personal workspaces
  // simply have no shares, and the call returns an empty list.
  const [startTargets, setStartTargets] = useState<ExtraTarget[]>([]);
  const sharedLinkUsed = useRef(false);
  useEffect(() => {
    if (authState !== 'ready' || !workspaceId) {
      setStartTargets([]);
      return;
    }
    let alive = true;
    teamApi
      .projects(workspaceId)
      .then((r) => {
        if (!alive) return;
        setStartTargets(r.projects.filter((p) => p.access === 'control').map((p) => ({ machineId: p.machineId, cwd: p.root, label: p.name })));
        // `/w/?share=<projectShareId>` — the deep link an integration signs
        // people in with (`/api/auth/service-signin`, `next`): open the start
        // screen aimed at that shared folder. Eaten on use, so a reload or a
        // later visit to `/w/` is not pulled back to it. The link does not say
        // which workspace the share is in, so when this one does not hold it the
        // viewer's other workspaces are asked, and the one that does is selected
        // first (this effect then runs again for it and finds the share). The
        // link is spent only once the share is found — or nowhere has it.
        const wanted = new URLSearchParams(location.search).get('share');
        if (!wanted || sharedLinkUsed.current) return;
        const target = r.projects.find((p) => p.projectShareId === wanted);
        if (target) {
          sharedLinkUsed.current = true;
          navigate({ kind: 'new', machineId: target.machineId, cwd: target.root }, { replace: true });
          return;
        }
        const others = (viewer?.workspaces ?? []).map((w) => w.workspaceId).filter((id) => id !== workspaceId);
        void (async () => {
          for (const id of others) {
            const found = await teamApi.projects(id).then((x) => x.projects.some((p) => p.projectShareId === wanted)).catch(() => false);
            if (!alive) return;
            if (found) {
              selectWorkspace(id);
              return;
            }
          }
          sharedLinkUsed.current = true;
        })();
      })
      .catch(() => { if (alive) setStartTargets([]); });
    return () => { alive = false; };
  }, [authState, workspaceId]);
  // [community] Projects the agents found by scanning their roots — a project
  // created a moment ago has no session, so the snapshot cannot know it. Only
  // `origin: 'root'` rows join the shelf: session-derived rows are already
  // there from the snapshot, and re-adding them would resurface the cwds the
  // automated-session filter hides.
  const owned = useOwnedProjects(c);
  const extraTargets = useMemo<ExtraTarget[]>(
    () => [
      ...startTargets,
      ...owned.projects
        // `adopted` joins `root` for the same reason: both are directories the
        // agent reports that the snapshot cannot know about, and both exist
        // because a person named them. A session-derived row is already here.
        .filter((p) => p.origin === 'root' || p.origin === 'adopted')
        .map((p) => ({ machineId: p.machineId, cwd: p.cwd, label: p.label, origin: p.origin, lastModified: p.lastModified })),
    ],
    [startTargets, owned.projects],
  );
  // [community] The seat's own share of the model pool, and who is looking —
  // read deep in the transcript (the budget card), the meter and the info
  // column without threading props through Chat.
  const budget = useBudget(authState === 'ready' && communityPlan && !gated);
  const seat = useMemo<Seat>(
    () => ({
      viewerId: viewer?.userId,
      community: communityPlan,
      budget,
      activeSessionId: c.active?.sessionId || undefined,
    }),
    [viewer?.userId, communityPlan, budget, c.active?.sessionId],
  );

  // runs indexed by machine::session for fast sidebar attention lookups.
  const runIndex = useMemo(() => indexRuns(c.activeRuns), [c.activeRuns]);
  /**
   * The roots «Файлы» opens. Exactly the shelf the start screen picks a project
   * from — one definition, so the file manager and «Новая сессия» can never
   * disagree about what this machine's projects are.
   *
   * `HIDDEN_MACHINES` is deliberately not applied: its own comment scopes it to
   * the sidebar, and this is not the sidebar.
   */
  const fileTargets = useMemo(
    () => projectTargets(c.machines, viewer?.userId, runIndex, extraTargets),
    [c.machines, viewer?.userId, runIndex, extraTargets],
  );

  // Temporarily hidden noise boxes of OUR fleet — dropped from the SIDE PANEL
  // only (folder chips + project list). They stay reachable by ⌘K and by deep
  // link. A customer's hub (external edition) hides nothing: these names mean
  // nothing there, and an ordinary machine of theirs must never vanish.
  const external = isExternal(publicConfig);
  const sidebarMachines = useMemo(
    () => (external ? c.machines : c.machines.filter((m) => !INTERNAL_HIDDEN_MACHINES.test(m.machine.name))),
    [c.machines, external],
  );

  // «Мои · Команда · Все» (ScopeSwitch). Who may switch is the viewer's ROLE;
  // whether there is anything to switch to is the snapshot. The two are kept
  // apart on purpose — see `hasOthersWork`.
  const scopeAllowed = canSwitchScope(viewer);
  useEffect(() => setScopeAvailable(scopeAllowed), [scopeAllowed]);
  const othersWork = useMemo(
    () => hasOthersWork(sidebarMachines, viewer?.userId, c.activeRuns),
    [sidebarMachines, viewer?.userId, c.activeRuns],
  );

  /** A session just started and not in the inventory yet, synthesized so its
   *  live chat renders while the first turn streams — in the single view and
   *  in the split pane it was started from alike. */
  const pendingSummary = useMemo<SessionSummary | undefined>(() => {
    if (!pendingNew) return undefined;
    return {
      sessionId: c.active?.sessionId || '',
      title: 'Новая сессия',
      cwd: pendingNew.cwd,
      project: pendingNew.project,
      lastModified: Date.now(),
      // The RUNTIME this session was started as, not a guess. It reaches the
      // composer's model picker as `session.source`, and the placeholder lives
      // until the rollout file lands in the machine inventory — i.e. through
      // the whole first turn. Defaulting it to 'claude' offered Claude model
      // ids on a Codex run, and picking one is accepted everywhere (the hub
      // only length-checks `model`, `CodexSessionRun.setModel` is a field
      // assignment) and then fails every turn with a message that never names
      // the model.
      source: pendingNew.source ?? 'claude',
      ...(pendingNew.provider ? { provider: pendingNew.provider } : {}),
    } as SessionSummary;
  }, [c.active, pendingNew]);

  const session = useMemo<SessionSummary | undefined>(() => {
    if (!selected) return undefined;
    // Unfiltered lookup on purpose: the URL is explicit intent, and a closed or
    // automated session hidden from the lists must still open from a deep link.
    const real = c.findSession(selected.machineId, selected.sessionId);
    if (real) return real;
    if (pendingNew && pendingNew.machineId === selected.machineId) return pendingSummary;
    return undefined;
  }, [selected, c.findSession, pendingNew, pendingSummary]);

  /** A session for a split pane: the inventory's, or the one just started when
   *  its real id has arrived but the inventory has not caught up yet — for its
   *  whole first turn. Dropping the pane meanwhile is how a new chat vanished. */
  const resolveSession = (machineId: string, sessionId: string): SessionSummary | undefined => {
    const real = c.findSession(machineId, sessionId);
    if (real) return real;
    if (pendingNew && pendingSummary && pendingNew.machineId === machineId && pendingSummary.sessionId === sessionId) {
      return pendingSummary;
    }
    return undefined;
  };
  const tabInfo = makeTabInfo(c, resolveSession);
  const newTabRoute = makeNewTabRoute(resolveSession);
  const selectedMachine = selected ? c.machines.find((m) => m.machine.machineId === selected.machineId) : undefined;
  const canControlSelected = selectedMachine?.canControl !== false;
  // A control-share member can drive (send/interrupt) but not fully control the
  // machine (no terminal, no file RPC). Rename/Delete additionally need ownership.
  const canDriveSelected = canControlSelected || selectedMachine?.canStart === true;
  const canEditSelected =
    canControlSelected || (!!session?.owner && session.owner.userId === viewer?.userId);

  // New session: swap the placeholder selection for the real id once the agent
  // reports it, and drop the placeholder once it lands in the inventory.
  useEffect(() => {
    if (!pendingNew) return;
    const realId = c.active?.sessionId;
    if (realId && selected?.sessionId === '' && selected.machineId === pendingNew.machineId) {
      // replace, not push: the placeholder URL is not a place you can go back to
      navigate({ kind: 'session', machineId: pendingNew.machineId, sessionId: realId }, { replace: true });
    }
    // Started from a composer PANE: the placeholder is that pane, and it becomes
    // the session — in place, focused, the other panes untouched.
    if (realId && route.kind === 'columns') {
      const at = route.panes.findIndex(
        (p) => p.kind === 'session' && !p.sessionId && p.machineId === pendingNew.machineId,
      );
      if (at >= 0) {
        const next = route.panes.slice();
        next[at] = { kind: 'session', machineId: pendingNew.machineId, sessionId: realId };
        setSplitFocus(at);
        navigate(splitRoute(next), { replace: true, whole: true });
      }
    }
    if (realId) {
      const m = c.machines.find((x) => x.machine.machineId === pendingNew.machineId);
      if (m?.sessions.some((s) => s.sessionId === realId)) setPendingNew(null);
    }
  }, [c.active, c.machines, pendingNew, selected, route]);

  // When the last start left this browser, and not yet answered with an id.
  // A REF, not the `pendingNew` state the guard below also reads: two presses
  // can both land before this component renders again (the start screen holds
  // a closure from its last render), each then sees `pendingNew` as it was —
  // empty — and each sends `new_session`. A ref is the one thing both presses
  // read fresh. Same fix as the light shell's `startingAt` (lite/LiteApp.tsx),
  // made after the same double start on production.
  const startingAt = useRef(0);
  useEffect(() => {
    if (!pendingNew || c.active?.sessionId) startingAt.current = 0;
  }, [pendingNew, c.active?.sessionId]);

  const startNewSession = (
    machineId: string,
    cwd: string,
    message?: string,
    images?: ImageInput[],
    project?: string,
    category?: SessionCategory,
    source?: 'claude' | 'codex',
    files?: FileInput[],
    startup?: StartSettings,
  ): boolean => {
    // Send first, and leave the person where they are if it did not go. The
    // order used to be the other way round: navigate to the placeholder, then
    // send and ignore the answer. Starting a session while the socket was down
    // therefore landed you on an empty new-session pane with a toast saying
    // «повторите через мгновение» — and nothing left to repeat, because the
    // start screen had already cleared its composer. The text is only safe
    // while it is still in the box that holds it.
    // ONE session may be starting at a time: the shell tracks one placeholder
    // (`pendingNew`, and the socket's one `active`). With several composers
    // open (the tab strip's «+») a second send in those few seconds would take
    // the first one's id and its pane. The text stays in its box; a start that
    // never got an id stops holding the door after 30 s.
    if (
      (startingAt.current && Date.now() - startingAt.current < 30_000) ||
      (pendingNew && !pendingSummary?.sessionId && Date.now() - pendingNew.at < 30_000)
    ) {
      c.notifyError('Предыдущий чат ещё запускается — отправьте через пару секунд.');
      return false;
    }
    if (!c.newSession(machineId, cwd, message, images, category, source, files, startup)) {
      return false;
    }
    startingAt.current = Date.now();
    setPendingNew({
      at: Date.now(),
      machineId,
      cwd,
      project,
      ...(source ? { source } : {}),
      ...(source === 'codex' && isGoModel(startup?.model) ? { provider: 'opencode' } : {}),
    });
    // Text handed to a PREVIOUS `open` is not this session's. The effect that
    // normally clears it bails out on the placeholder route (`!route.sessionId`),
    // so without this the last resumed message reappears in the composer of a
    // brand-new session.
    setCarriedDraft(undefined);
    // In a split this lands in the composer's own pane (`intoPane`: the
    // placeholder and the composer are one slot), replacing it — not travel.
    navigate({ kind: 'session', machineId, sessionId: '' }, { replace: route.kind === 'columns' });
    setNotifOpen(false);
    return true;
  };

  const totalSessions = c.machines.reduce((n, m) => n + m.sessions.length, 0);

  // The side panel is the navigation, so it is not a property of the route any
  // more: it renders on every screen, in one of two states.
  //
  // It used to appear only inside Сессии, with three exceptions carved out of
  // that — the split and the composer dropped it for width, and it was never
  // on a phone. The first two exceptions were real complaints about width and
  // are answered by the collapse, which is one click and remembered; keeping
  // them as route conditions meant Файлы and Команда had no session list at
  // all, and getting back to a conversation from them cost a navigation.
  //
  // The phone exception stays, and it is not an exception to this rule so much
  // as a different shell: below 861px there is ONE page and ONE drawer. The
  // panel and the rail are both `display: none` there, and the list lives in
  // the drawer, which opens from the ☰ without leaving what you were reading.
  const showPanel = !phone;
  const initials = (displayName.trim() || viewer?.fullName || viewer?.email || 'cc')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  // /api/me answers with the server's default workspace (personal-first), so
  // asking `viewer.workspace` before the socket connects gives the wrong answer.
  // Ask the same question the shell asks when it picks one.
  const canInvite = !!viewer && canInviteTo(pickWorkspace(viewer));

  // Text a resume fired from outside the session pane (StartScreen card, command
  // palette) is still waiting on. Handed to Chat so a hub refusal puts it back
  // in a composer instead of dropping it with the screen that sent it.
  const [carriedDraft, setCarriedDraft] = useState<string | undefined>();

  // A STABLE identity for `openSession`, which is rebuilt every render and
  // closes over half the component. The session list is memoized, and a
  // callback prop that changes every render would defeat that on its own — so
  // the list gets this, and it calls through to whatever the latest render
  // built. The ref is assigned during render on purpose: the list is rendered
  // in the same pass, and an effect would leave it one render behind.
  const openRef = useRef<(machineId: string, sessionId: string, message?: string, images?: ImageInput[], files?: FileInput[]) => void>(() => {});
  const openSessionStable = useCallback(
    (machineId: string, sessionId: string, message?: string, images?: ImageInput[], files?: FileInput[]) =>
      openRef.current(machineId, sessionId, message, images, files),
    [],
  );
  const openSession = (
    machineId: string,
    sessionId: string,
    message?: string,
    images?: ImageInput[],
    files?: FileInput[],
  ) => {
    // Read BEFORE navigating: in a split the session opens in a pane, and a
    // pane attaches its own session view to the shared socket (SessionColumn).
    const split = route.kind === 'columns';
    navigate({ kind: 'session', machineId, sessionId });
    setNotifOpen(false);
    // Exactly one transition. With a message/image, resume via `open` so its
    // optimistic line + "working…" survive (a following focusSession would wipe
    // them); ingestActivity re-attaches to a live run if one exists. Without a
    // message, just attach the view.
    if (message?.trim() || images?.length || files?.length) {
      // Carry the text into the session pane: this `open` can still be refused
      // (session live in an editor, machine reconnecting), and the screen that
      // owned the composer is about to unmount.
      setCarriedDraft(message?.trim() || undefined);
      c.open(machineId, sessionId, message, images, files);
    } else {
      setCarriedDraft(undefined);
      // The shell attaching too would be a second viewer of the pane's run —
      // two copies of every approval, suppressed rather than prevented.
      if (!split) c.focusSession(machineId, sessionId);
    }
  };
  openRef.current = openSession;

  // Deep link / refresh / back-forward onto a session: `openSession` only fires
  // when something is clicked, so arriving at /w/s/:m/:s by any other means has
  // to attach the view itself. It has to wait for the socket AND for the machine
  // to appear in the inventory — focusing before either is a no-op — and it must
  // fire once per session, not on every inventory tick.
  const attached = useRef('');
  useEffect(() => {
    if (route.kind !== 'session' || !route.sessionId || c.status !== 'open') return;
    const key = sessionKey(route.machineId, route.sessionId);
    if (attached.current === key) return;
    const machine = c.machines.find((m) => m.machine.machineId === route.machineId);
    if (!machine) return;
    attached.current = key;
    setCarriedDraft(undefined);
    c.focusSession(route.machineId, route.sessionId);
  }, [route, c.status, c.machines, c.focusSession]);

  // Always land on the StartScreen composer. It is its own route, not the
  // sessions list: on a phone the list IS that screen and the composer sits in
  // the hidden column beside it, so "Новая сессия" led nowhere reachable.
  //
  // Pressed inside a split it opens the composer IN the focused pane (or in
  // the pane already holding one) — the split is a division of the screen, and
  // the session started there takes that pane's place once it has an id.
  const openStartScreen = () => {
    navigate({ kind: 'new' });
    setNotifOpen(false);
  };
  /** The side panel's «Новый чат»: a column of its own beside what is on
   *  screen, the focused pane only once all four are taken (`newChatRoute`).
   *  The phone keeps `openStartScreen` — one page there, no columns to add. */
  const openNewChat = (aim?: { machineId: string; cwd: string }) => {
    setNotifOpen(false);
    const r = newChatRoute(route, splitFocus, aim);
    if (!r) return navigate(aim ? { kind: 'new', ...aim } : { kind: 'new' });
    setSplitFocus(r.focus);
    // A pane added to a split that is already there is rearranging the screen,
    // not travel — `replace`. Splitting a single screen pushes, so Back returns
    // to that screen on its own, as it did when «Новый чат» went to /w/new.
    navigate(r.route, route.kind === 'columns' ? { replace: true, whole: true } : { whole: true });
  };

  /**
   * The split is not a phone layout, and a link to one has to land somewhere
   * honest rather than degrade.
   *
   * Below 861px the panes become full-page cards you swipe between — which is
   * "one session on screen", arrived at the expensive way: every pane is a
   * session view with its own history read and its own stream. A shared
   * `?s=a:1,b:2` therefore opens the focused one (the first, from a link) as
   * an ordinary screen — a placeholder of a session with no id yet as the
   * composer, never as `/w/s/m`. `replace`, because the split URL is not a
   * place you can go back to here.
   */
  // (Removed 25.09.2026.) A narrow window used to REWRITE a split into its
  // focused pane here, so narrowing the window — not only opening a link on a
  // phone — threw the other columns away for good. The split now stays and
  // draws as tabs (`SessionColumns stacked`); widening brings the columns back.

  /**
   * The status-bar strip follows what is actually under it.
   *
   * In the installed app iOS paints that strip itself, from `theme-color` —
   * which the boot script in index.html pins to `--bg`, the page's canvas. Open
   * the drawer and the top-left of the screen becomes the drawer's `--surface`,
   * a different colour: the strip stays canvas-grey and the panel below it
   * starts with a visible seam, which reads as the drawer failing to reach the
   * top. Repainting the meta while it is open closes the seam without touching
   * the clock's own contrast — `black-translucent` would hand us the pixels but
   * forces white glyphs, unreadable over a light drawer.
   */
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const canvas = meta.content;
    const surface = getComputedStyle(document.documentElement)
      .getPropertyValue(drawerOpen ? '--surface' : '--bg')
      .trim();
    if (surface) meta.content = surface;
    return () => {
      meta.content = canvas;
    };
  }, [drawerOpen]);

  // ⌘K / Ctrl+K toggles the palette anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A session on screen has been seen: its bell entry goes (`pruneInbox`).
  // `c.notifications` in the deps catches an entry that lands for a session
  // already open in a pane that is not following its run.
  useEffect(() => {
    c.dismissOnScreen(openKeys);
  }, [openKeys, c.notifications, c.dismissOnScreen]);

  // Tell the hub which session is in front, so a «finished» mark seen here
  // clears on the person's other devices. Re-sent when the visible run moves
  // (state change or a new turn); focus, dwell and throttle live in
  // `markSessionsRead`. In a split only the focused pane counts — on a phone the
  // others are not even mounted, and on a desktop four columns restored on
  // wake are not four answers read (20.10.2026: that cleared the phone's dots).
  const visibleKeys = useMemo(() => {
    if (route.kind === 'columns') {
      const front = route.panes[Math.min(splitFocus, route.panes.length - 1)];
      return new Set(
        sessionPanes(front ? [front] : []).map((r) => sessionKey(r.machineId, r.sessionId)),
      );
    }
    return openKeys;
  }, [route, splitFocus, openKeys]);
  const onScreenActivity = c.activeRuns
    .filter((r) => visibleKeys.has(sessionKey(r.machineId, r.sessionId)))
    .map((r) => `${r.runId}:${r.state}:${r.since}`)
    .join('|');
  useEffect(() => {
    c.markSessionsRead(visibleKeys);
  }, [visibleKeys, onScreenActivity, c.markSessionsRead]);

  // Keep the unread counter at zero while the notification panel is open.
  // `c.unread` in the deps re-runs this when a new notification lands while the
  // panel is open, so depending on `c.notifications` too would be redundant.
  useEffect(() => {
    if (notifOpen && c.unread > 0) c.markRead();
  }, [notifOpen, c.unread, c.markRead]);

  /** May the viewer rename or delete this session? A control-share member
   *  drives other people's sessions but does not own their names. */
  const canEditSession = (t: ColRef) => {
    const m = c.machines.find((x) => x.machine.machineId === t.machineId);
    if (m?.canControl !== false) return true;
    const s = c.findSession(t.machineId, t.sessionId);
    return !!s?.owner && s.owner.userId === viewer?.userId;
  };

  /** Renaming is wider than deleting: a member who can start sessions on a
   *  shared machine may retitle any session the hub shows them (the hub's
   *  `can_see_session` still guards it). Deleting stays with `canEditSession`. */
  const canRenameSession = (t: ColRef) => {
    if (canEditSession(t)) return true;
    return c.machines.find((x) => x.machine.machineId === t.machineId)?.canStart === true;
  };

  const { renameTo, renameSession, deleteSession, closeSession } = useSessionActions(c, {
    openSession,
    // Only when the thing that went away is the thing on screen. The menu acts
    // on rows that are usually NOT the open session, and leaving the person's
    // conversation because they tidied up an unrelated one is a bug.
    clearSelection: (target) => {
      if (selected && sessionKey(selected.machineId, selected.sessionId) === sessionKey(target.machineId, target.sessionId)) {
        navigate(SESSIONS);
      }
      // In a split, the pane showing it goes, and the rest stay.
      if (route.kind === 'columns') {
        const next = route.panes.filter(
          (p) => !(p.kind === 'session' && p.machineId === target.machineId && p.sessionId === target.sessionId),
        );
        if (next.length !== route.panes.length) navigate(splitRoute(next), { replace: true, whole: true });
      }
    },
  });

  // The right-click menu of a session row. It lives here because it acts on the
  // shell's own state — the route (which panes are open), the favourites, the
  // session actions — and because the same menu serves both the desk panel and
  // the phone drawer.
  const sessionMenu = useSessionMenu({
    route,
    favorites,
    onToggleFav: toggleFav,
    // The stable one: `addColumn` is memoised on it and rides into the
    // memo'd SessionsPane — a fresh function per render would re-render the
    // whole list on every streamed token.
    onOpen: openSessionStable,
    onRename: (t) => void renameSession(t),
    onDelete: (t) => void deleteSession(t),
    onClose: (t) => closeSession(t),
    isClosed: (t) => c.findSession(t.machineId, t.sessionId)?.stage === 'done',
    canEdit: canEditSession,
    canRename: canRenameSession,
  });

  // A live-in-editor session renders the Mirror (read-only view + a composer
  // that force-takes-over on send) — UNLESS we are mid-takeover (busy, no
  // runId yet) or already own its run: the stale livePid can outlive a
  // successful takeover by one inventory refresh.
  const ownsSelected =
    !!c.active &&
    c.active.machineId === selected?.machineId &&
    c.active.sessionId === selected?.sessionId &&
    (!!c.active.runId || c.busy);

  if (authState === 'loading') {
    return <div className="auth-screen"><div className="auth-card"><span className="topbar-brand"><HegaiMark size={18} mono="var(--action)" /> heg<b>ai</b> remote</span><p>Загружаем пространство…</p></div></div>;
  }
  // The front door is the one screen a community member meets before anything
  // else, and the whole product behind it speaks Russian. Register-neutral on
  // purpose («на своих машинах», not «твоих»/«ваших»): the community screens say
  // «ты», Settings still says «вы», and the door should not pick that fight.
  if (authState === 'offline') {
    return <div className="auth-screen"><div className="auth-card"><span className="topbar-brand"><HegaiMark size={18} mono="var(--action)" /> heg<b>ai</b> remote</span><h1>Нет связи с хабом</h1><p>Приложение загрузилось из кэша, но до хаба не достучаться. Сессии идут на машинах и ничего не теряют — экран вернётся сам, как только появится сеть.</p><button className="btn primary auth-login" onClick={() => void refreshIdentity()}>Попробовать сейчас</button></div></div>;
  }
  // Signed in with the first factor only: the hub's session opens nothing yet.
  if (authState === 'mfa' && mfaState) {
    return <MfaScreen state={mfaState} brand={publicConfig?.brandName ?? 'Hegai Code'} onSignOut={() => teamApi.logout().then(() => location.reload())} />;
  }
  // The door is a page, not a card: see `Landing` for why two sentences were
  // not enough once people started arriving from a community invitation.
  if (authState === 'unauthenticated') {
    // A customer's own hub shows its sign-in screen instead of the community
    // landing; the answer is already in flight from boot, so the wait is brief.
    if (publicConfig === undefined) return <div className="auth-screen"><div className="auth-card"><p>Загружаем…</p></div></div>;
    return isExternal(publicConfig) && publicConfig ? <SignInScreen config={publicConfig} /> : <Landing />;
  }
  // [community] Before activation there is nothing behind the rail — one card
  // instead of the shell. `identity` is non-null here (authState is 'ready').
  if (gated && identity) {
    return <>
      <TelegramSignedInBanner userId={identity.userId} />
      <AccessGate viewer={identity} onRefresh={refreshIdentity} onLogout={() => teamApi.logout().then(() => location.reload())} />
    </>;
  }

  // The first screens: automatically until the person has a machine of their own
  // with a coder signed in (and has not finished or skipped), and by hand at
  // `/w/start`. Existing users with a machine and a login never see them.
  if (c.hydrated && viewer && onboardingDecided.current !== viewer.userId) {
    onboardingDecided.current = viewer.userId;
    if (!onboardingDone(viewer.userId) && needsOnboarding(c)) onboardingOpen.current = true;
  }
  if (c.hydrated && viewer && (route.kind === 'start' || onboardingOpen.current)) {
    return (
      <Suspense fallback={<div className="auth-screen"><div className="auth-card"><p>Загружаем…</p></div></div>}>
        <Onboarding central={c} viewer={viewer} onFinish={finishOnboarding} />
      </Suspense>
    );
  }

  const topbar = (
    <TopBar
      central={c}
      gatewayQuota={gatewayQuota}
      themePref={themePref}
      onChooseTheme={chooseTheme}
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
      onJump={openSession}
      accountInitials={initials}
      accountUserId={viewer?.userId}
      sidebarCollapsed={sidebar.collapsed}
      onToggleSidebar={sidebar.toggle}
      onOpenDrawer={phone ? () => setDrawerOpen(true) : undefined}
      // Always on a desk, collapsed or not (25.09.2026, by request): the top
      // bar keeps only the limits. With the panel collapsed, the account, the
      // theme and the bell are one click away — the panel toggle, top left.
      actionsInPanel={showPanel}
      othersWork={othersWork}
      onNewChat={() => openNewChat()}
      onOpenPalette={() => setPaletteOpen(true)}
    />
  );

  /* A pending approval that a pane of the split is already showing. The shell's
     own session view and the pane's are two views on the one socket, and each
     keeps the prompts of the run it follows — so when both follow the same run,
     both hold the same question, and both would draw it. `ModalHost` yields to the pane: it is
     the one sitting under the transcript the question is about.

     Matched on the RUN the request belongs to, not merely on the focused
     session: the two agree today (a `tool_request` for anything but the focused
     run is dropped), but keying on the route alone would silently swallow a real
     prompt the day that guard moves. A run the inventory has not caught up with
     is not suppressed — an unanswerable question is worse than a doubled one. */
  const pendingRun =
    c.toolReq && c.activeRuns.find((r) => r.runId === c.toolReq?.runId);
  const toolReqOwnedByColumn =
    route.kind === 'columns' &&
    !!pendingRun &&
    // On a phone the split is tabs and only the front one is mounted — a pane
    // behind a tab cannot show its approval, so the shell's modal must.
    sessionPanes(phone ? route.panes.slice(Math.min(splitFocus, route.panes.length - 1)).slice(0, 1) : route.panes).some(
      (r) => r.machineId === pendingRun.machineId && r.sessionId === pendingRun.sessionId,
    );

  /** The single screen: a page, a session that cannot be found, or the
   *  session itself. The columns route never reaches it. */
  const mainBody = () =>
    route.kind === 'columns' ? null : route.kind !== 'session' ? (
            renderPage(route)
          ) : selected && selected.sessionId && !session && !pendingNew && c.status === 'open' && c.hydrated ? (
            // The URL names a session the snapshot cannot resolve — deleted,
            // beyond the snapshot cap, or scoped away by a workspace switch.
            // Silence here used to leave the StartScreen with no explanation
            // and read as «клик не работает»; say what is known instead. Guards:
            // pendingNew (a new session mid-start on another machine must not
            // flash «не найдено»), status+hydrated (before the first snapshot
            // an unresolved route means loading, not missing). If the session
            // arrives later via a delta, the memo recomputes and this branch
            // self-heals into the workspace.
            <div className="placeholder">
              <div className="ph-sub">
                {selectedMachine
                  ? `Сессия не найдена на «${selectedMachine.machine.name}» — она могла быть удалена или выпасть из снимка.`
                  : 'Эта машина недоступна в текущем воркспейсе.'}
              </div>
              <div style={{ marginTop: 16 }}>
                <button className="btn" onClick={() => navigate(SESSIONS)}>
                  К списку сессий
                </button>
              </div>
            </div>
          ) : !session || !selected ? (
            renderPage(route)
          ) : (
            <SessionWorkspace
              central={c}
              session={session}
              selected={selected}
              runIndex={runIndex}
              infoOpen={infoOpen}
              onToggleInfo={toggleInfo}
              canEdit={canEditSelected}
              canDrive={canDriveSelected}
              ownsSelected={ownsSelected}
              carriedDraft={carriedDraft}
              onRename={() => void renameSession(selected, session)}
              onRenameTo={canEditSelected || canDriveSelected ? (title) => renameTo(selected, title, session) : undefined}
              onDelete={() => void deleteSession(selected, session)}
              onToggleClosed={() => closeSession(selected, session)}
              onOpenDrawer={() => setDrawerOpen(true)}
            />
    );

  /**
   * One screen of the app, drawn for a route — the main column's body, and the
   * body of a split pane. A closure over the shell on purpose: every screen
   * already takes its dependencies from here, and a pane is the same screen in
   * a narrower box, on the same socket.
   *
   * A session is NOT drawn here: the single view draws `SessionWorkspace` and a
   * pane draws `SessionColumn` with a socket of its own. A `session` route that
   * reaches this (a placeholder with nothing pending) is the composer it came
   * from.
   */
  const renderPage = (r: PaneRoute): ReactNode => {
    switch (r.kind) {
      case 'team':
        // The team screens need a workspace, and `central.viewer` is null until
        // the socket's hello lands. Доступ goes before that guard: it reads REST
        // identity only, so a hard reload straight onto it must not sit on
        // «Подключаемся».
        return (
            r.tab === 'access' ? <TeamAccess viewer={viewer} />
            : !c.viewer ? (
              <div className="team-page"><div className="team-empty">Подключаемся к хабу…</div></div>
            ) : r.tab === 'people' ? <TeamMembers central={c} workspace={c.viewer.workspace} canInvite={canInvite} onOpen={openSession} viewer={viewer} onSelectWorkspace={selectWorkspace} onWorkspaceCreated={refreshIdentity} />
            : r.tab === 'projects' ? <TeamProjects central={c} workspace={c.viewer.workspace} viewer={viewer} onSelectWorkspace={selectWorkspace} />
            : r.tab === 'usage' && canSeeUsageTab(viewer) ? <TeamUsage central={c} workspace={c.viewer.workspace} viewer={viewer} onSelectWorkspace={selectWorkspace} />
            : r.tab === 'audit' ? <TeamAudit central={c} workspace={c.viewer.workspace} viewer={viewer} onSelectWorkspace={selectWorkspace} />
            : <TeamOverview central={c} onOpen={openSession} viewer={viewer} onSelectWorkspace={selectWorkspace} />
        );
      case 'settings':
        return (
            // Машины · Приложения · Аккаунт · Вид. Each keeps its own
            // `.board-head` — the strip names the section, the head names the
            // screen, and they say different things.
            <div className="settings-shell">
              <SettingsTabs active={r.tab} />
              {r.tab === 'hardware' ? <Hardware central={c} viewer={viewer} />
                : r.tab === 'apps' ? <AppsTab />
                : r.tab === 'look' ? <Appearance pref={themePref} onChoose={chooseTheme} />
                : r.tab === 'browser' ? <BrowserSettings />
                : <WorkspaceSettings central={c} viewer={viewer} onWorkspaceCreated={refreshIdentity} onSelectWorkspace={selectWorkspace} />}
            </div>
        );
      case 'start':
        return <Onboarding central={c} viewer={viewer} onFinish={finishOnboarding} />;
      case 'files':
        return (
            <Files
              central={c}
              route={r}
              targets={fileTargets}
              // Writable only where the viewer controls the machine AND its
              // owner has not made it chat-only — the agent refuses writes there.
              canControl={(machineId) => {
                const m = c.machines.find((x) => x.machine.machineId === machineId);
                return m?.canControl === true && m.machine.policy?.chatOnly !== true;
              }}
            />
        );
      case 'board':
        // Its own data (`/api/board`), its own filters in the URL; no `central`
        // needed — the hub already scoped the cards to this viewer.
        return <Board route={r} providerOf={(m, s) => c.findSession(m, s)?.provider} />;
      case 'reports':
        // Its own data (`/api/reports`); the hub scopes it to author + admins.
        return <Reports route={r} />;
      case 'projects':
        return (
            <Projects
              central={c}
              route={r}
              projects={owned.projects}
              roots={owned.roots}
              runIndex={runIndex}
              loading={owned.loading}
              onOpen={openSession}
              refresh={owned.refresh}
            />
        );
      case 'project':
        // A project opens onto its sessions, the way it does on the phone —
        // not onto the composer aimed at it (see ProjectSessions).
        return (
            <ProjectSessions
              project={r.project}
              viewerId={viewer?.userId}
              machines={sidebarMachines}
              activeRuns={c.listedRuns}
              runIndex={runIndex}
              onOpen={openSession}
              onSessionMenu={sessionMenu.open}
            />
        );
      default:
        return (
            <StartScreen
              // One more composer from the tab strip's «+» is a screen of its
              // own: switching tabs between two of them must remount.
              key={r.kind === 'new' && r.n ? `new:${r.n}` : 'new'}
              instance={r.kind === 'new' ? r.n : undefined}
              central={c}
              onNewSession={startNewSession}
              extraTargets={extraTargets}
              // `/w/new?m=…&cwd=…` — «Новая сессия» pressed inside a project on
              // the Проекты screen. A label could not say WHICH `crm`.
              initialTarget={
                r.kind === 'new' && r.machineId && r.cwd
                  ? { machineId: r.machineId, cwd: r.cwd }
                  : undefined
              }
              // `/w/new?cat=sync` — a shareable address for "start a sync
              // session here".
              initialCategory={r.kind === 'new' ? r.cat : undefined}
              // [community] `/w/new?create=1` opens «Новый проект»; a create
              // or remove there re-asks the agents for their root scans.
              initialCreate={r.kind === 'new' ? r.create : undefined}
              viewer={viewer}
              onProjectsChanged={owned.refresh}
            />
        );
    }
  };

  return (
    <SeatContext.Provider value={seat}>
    <div className="app" ref={appRoot} style={drawer.style} data-dragging={drawer.dragging ? '1' : undefined}>
      <TelegramSignedInBanner userId={identity?.userId} />
      {/* ABOVE the panel, not beside it — the bar spans the window.
          It used to live inside `.main-col`, so its left edge started where the
          panel ended, and collapsing the panel slid the whole row 320px left:
          the toggle you had just pressed moved out from under the cursor, which
          is the one thing a toggle must never do. It is also what a title bar
          has to be on Windows, where this row IS the window's frame. */}
      {topbar}
      <div className="body">
        {/* Collapsed means GONE — no panel and no strip.
            There was a 68px rail of icons here for one release, on the argument
            that navigation must survive the collapse. It does: the panel's
            toggle, the history arrows, search, notifications and the account
            all live in the top bar now, which renders on every screen. What the
            strip actually cost was the thing collapsing is FOR — the width —
            while still drawing a second copy of controls that already existed
            eighty pixels away. */}
        {showPanel && (
          <SidePanel
            collapsed={sidebar.collapsed}
            central={c}
            machines={sidebarMachines}
            machineFilter={machineFilter}
            onMachineFilter={setMachineFilter}
            selected={openKeys}
            runIndex={runIndex}
            favorites={favorites}
            onSelect={openSessionStable}
            onToggleFav={toggleFav}
            drilled={projDrilled}
            onDrillChange={setProjDrilled}
            onSessionMenu={sessionMenu.open}
            viewerId={viewer?.userId}
            othersWork={othersWork}
            unread={c.unread}
            notifOpen={notifOpen}
            onBell={() => {
              setNotifOpen((v) => !v);
              setSettingsOpen(false);
              c.markRead();
              c.requestNotifyPermission();
            }}
            width={sidebar.width}
            resizing={sidebar.resizing}
            onStartResize={sidebar.startResize}
            // In a split, the focused pane is where you are.
            active={destinationOf(
              route.kind === 'columns' ? (route.panes[Math.min(splitFocus, route.panes.length - 1)] ?? route) : route,
            )}
            onNewSession={openNewChat}
            onAddColumn={sessionMenu.addColumn}
            foot={{
              initials,
              userId: viewer?.userId,
              name: displayName.trim() || viewer?.fullName || viewer?.email || 'Аккаунт',
              accountOpen: settingsOpen,
              onToggleAccount: () => {
                setSettingsOpen((v) => !v);
                setNotifOpen(false);
              },
            }}
          />
        )}

        <div className="main-col">
          <main className="main">
          {/* One boundary for every route body: they are alternatives, never
              siblings, so a boundary each would be five copies of one rule. */}
          <Suspense fallback={<div className="route-pending" aria-hidden="true" />}>
          {/* A single screen is a group of one: on a desk it sits in a tab
              frame. In the VS Code theme a second session opened over it keeps
              the first as a tab, and a tab dragged to its edge becomes a
              column; the Hegai themes hide the strip and keep no tabs (CSS,
              tabs.ts). The frame is there in every theme and at every width
              (a phone dissolves it, CSS `display: contents`), so neither a
              theme switch nor crossing 860px remounts the screen. */}
          {route.kind !== 'columns' && tabGroups[0] ? (
            <div className="tab-frame">
              <TabStrip group={tabGroups[0]} groupIndex={0} focused info={tabInfo} newTab={newTabRoute} />
              <div className="tab-frame-body">
                <GroupDropZone groupIndex={0} />
                {mainBody()}
              </div>
            </div>
          ) : route.kind === 'columns' ? (
            <SessionColumns
              central={c}
              stacked={phone}
              panes={route.panes}
              groups={tabGroups}
              tabInfo={tabInfo}
              newTab={newTabRoute}
              canRename={canRenameSession}
              onRename={renameTo}
              onSessionMenu={sessionMenu.open}
              renderPage={renderPage}
              resolveSession={resolveSession}
              pendingSession={
                pendingNew && pendingSummary && !pendingSummary.sessionId
                  ? { machineId: pendingNew.machineId, session: pendingSummary }
                  : undefined
              }
            />
          ) : (
            mainBody()
          )}
          </Suspense>
          </main>
        </div>
      </div>

      {/* Смонтирована, пока открыта, пока её ТЯНУТ и пока уезжает. Тянуть
          можно только то, что есть в дереве, а уезжать — только тому, кого не
          сняли на первом же кадре. Монтировать её ВСЕГДА (как на телефоне)
          здесь нельзя тем же аргументом, каким она вообще условная: внутри
          второе полное дерево проектов, а `LazyVStack`, которым телефон это
          оплатил, у React нет. Признак ставится на claim — шестом пикселе
          жеста, — и у монтирования остаётся весь остаток тяги. */}
      {drawer.mounted && (
        <SessionDrawer
          central={c}
          machines={sidebarMachines}
          selected={openKeys}
          runIndex={runIndex}
          favorites={favorites}
          onSelect={(machineId, sessionId) => {
            setDrawerOpen(false);
            openSession(machineId, sessionId);
          }}
          onToggleFav={toggleFav}
          onSessionMenu={sessionMenu.open}
          viewerId={viewer?.userId}
          onClose={() => setDrawerOpen(false)}
          onNewSession={() => {
            setDrawerOpen(false);
            openStartScreen();
          }}
          onSearch={() => {
            setDrawerOpen(false);
            setPaletteOpen(true);
          }}
          themePref={themePref}
          onCycleTheme={cycleTheme}
          onOpenNotifications={() => {
            setNotifOpen(true);
            setSettingsOpen(false);
            c.markRead();
            c.requestNotifyPermission();
          }}
          othersWork={othersWork}
        />
      )}

      {/* Mounted only once opened: ⌘K is a deliberate act, and cmdk is not
          worth carrying on every first paint for it. */}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            central={c}
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            onJump={openSession}
          />
        </Suspense>
      )}

      {/* One menu for the whole shell — the desk panel and the phone drawer
          both raise coordinates into it. Mounted at the app root because it is
          positioned in VIEWPORT coordinates and must not be clipped by the
          scrolling list it was summoned from. */}
      <ContextMenu
        at={sessionMenu.at}
        actions={sessionMenu.actions}
        onClose={sessionMenu.close}
        label="Действия с сессией"
      />

      {/* The split's panes each own a session view AND their own approval
          surface, while the shell's hook stays attached to whatever session it
          last focused — nothing detaches it on the way here. So a plan raised
          by a session that is also in a pane arrived twice on one screen: two
          stacked modals with the same text, and answering one left the other
          up. The pane is the copy that belongs to what you are looking at. */}
      <ModalHost central={c} suppressToolReq={toolReqOwnedByColumn} />

      {/* The cloud browser's sheet. The shell's, not a screen's: it stays open
          while the person moves between sessions under it. */}
      <BrowserSheetHost />
    </div>
    </SeatContext.Provider>
  );
}
