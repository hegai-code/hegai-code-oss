import { MfaScreen } from '../MfaScreen.js';
import { pendingMfa, type MfaState } from '../mfaApi.js';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileInput, ImageInput, SessionSummary, ViewerContext } from '@cc-remote/shared';
import { useCentral, type StartSettings } from '../useCentral.js';
import { useTheme } from '../useTheme.js';
import { SeatContext, ShareRootsContext, useBudget, useOwnedProjects, type Seat } from '../appHooks.js';
import { githubStartHref, googleStartHref, indexRuns, sessionKey, type ExtraTarget } from '../lib.js';
import { ApiError, teamApi } from '../teamApi.js';
import { LocalCache } from '../localCache.js';
import { isAccessActive, lastWorkspaceId, noteWorkspace, pickWorkspace } from '../shell/workspace.js';
import { SESSIONS, linkProps, navigate, parseRoute, pathFor, useRoute } from '../router.js';
import { AccessGate } from '../components/AccessGate.js';
import { HegaiMark } from '../components/HegaiMark.js';
import { TelegramSignInButton, TelegramSignedInBanner } from '../components/TelegramSignIn.js';
import { ModalHost } from '../shell/ModalHost.js';
import { ArrowSquareOut } from '../icons.js';
import { Home } from './Home.js';
import { TaskView } from './TaskView.js';
import { FULL_ORIGIN, fullHref } from './origin.js';
import { loadSeen, markSeen, saveSeen, withReads, type Seen } from './tasks.js';
import { storageGet } from '../storage.js';
import { usePublicConfig } from '../publicConfig.js';

// Отчёты is a route of its own and most visits never open one.
const Reports = lazy(() => import('../components/reports/Reports.js').then((m) => ({ default: m.Reports })));

/**
 * The light shell — `remote.acme.test`.
 *
 * The same hub, account, machines and sessions as the full client, behind one
 * question: «что сделать?». It is a second ENTRY into `web/`, not a second
 * application: the socket, the reducers, the device cache, the router and the
 * transcript are the full client's own modules, imported. What is written here
 * is only what differs — a home that is a prompt and three piles of tasks, and
 * the choices the full client asks for (machine, runtime, model, mode, a
 * project's name) made on the person's behalf.
 *
 * What it deliberately does not have: the side panel, the split, the tab
 * strip, the palette, Команда, Файлы, Настройки. Each of those is one click
 * away under the same address on the full client (`fullHref`).
 */

/** Pages that exist only on the full client. They are reached by links that
 *  were written for it — an invitation, a machine's connection code — and a
 *  person following one here must end up there, not on a prompt box. */
const FULL_ONLY = /^\/(link|access|install)(\/|$)/;

type Auth = 'loading' | 'ready' | 'unauthenticated' | 'offline' | 'mfa';

interface PendingNew {
  machineId: string;
  cwd: string;
  project?: string;
  source?: 'claude' | 'codex';
  /** When it was sent — a start that never got an id stops blocking. */
  at: number;
}

/** «Войти через GitHub» on the light shell's door, only when this hub has it on. */
function GithubDoorButton() {
  const config = usePublicConfig();
  return config?.auth.github ? <a className="btn auth-login" href={githubStartHref()}>Войти через GitHub</a> : null;
}

export function LiteApp() {
  if (FULL_ONLY.test(location.pathname)) {
    location.replace(fullHref(location.pathname + location.search + location.hash));
    return null;
  }
  return <Shell />;
}

function Brand() {
  return (
    <span className="lt-brand">
      <HegaiMark size={18} mono="var(--action)" /> Hegai Code
    </span>
  );
}

function Shell() {
  const localDev = ['localhost', '127.0.0.1'].includes(location.hostname);
  const token = useState(() => (localDev ? (storageGet('cc-token') ?? 'dev-token') : ''))[0];
  const [identity, setIdentity] = useState<ViewerContext | null>(null);
  const [auth, setAuth] = useState<Auth>('loading');
  // Signed in with the first factor only: the hub's session is pending a code.
  const [mfaState, setMfaState] = useState<MfaState | null>(null);
  const refused = async () => {
    const owed = await pendingMfa();
    if (owed) {
      setMfaState(owed);
      setAuth('mfa');
    } else {
      setAuth('unauthenticated');
    }
  };
  // `/` and anything that is not an app address land on the home, without a
  // history entry — as the full client does.
  if (auth !== 'unauthenticated' && !location.pathname.startsWith('/w/')) {
    history.replaceState(null, '', pathFor(parseRoute(location.pathname, location.search)));
  }
  const [workspaceId, setWorkspaceId] = useState(lastWorkspaceId);
  useEffect(() => noteWorkspace(workspaceId), [workspaceId]);
  useEffect(() => {
    if (auth !== 'unauthenticated') return;
    LocalCache.release();
    noteWorkspace('');
  }, [auth]);
  // A socket that will not open: only a 401 over plain HTTP says «signed out»
  // — the browser hides the status of a failed upgrade (see App.tsx).
  const recheckAuth = async () => {
    try {
      await teamApi.me();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) await refused();
    }
  };
  const c = useCentral(token, {
    workspaceId: workspaceId || undefined,
    enabled: !!workspaceId && auth !== 'unauthenticated' && auth !== 'mfa',
    cacheOwner: identity?.userId,
    onHandshakeFailing: recheckAuth,
  });
  const refreshIdentity = async () => {
    try {
      const viewer = await teamApi.me();
      // Before anything reads the device cache as this person.
      LocalCache.claimFor(viewer.userId);
      setIdentity(viewer);
      setAuth('ready');
      setWorkspaceId(pickWorkspace(viewer).workspaceId);
    } catch (err) {
      // A hub that cannot be reached has not refused anyone.
      if (err instanceof ApiError && err.status === 401) await refused();
      else setAuth(err instanceof ApiError ? 'unauthenticated' : 'offline');
    }
  };
  useEffect(() => {
    void refreshIdentity();
  }, []);
  useEffect(() => {
    if (auth !== 'offline') return;
    const retry = () => void refreshIdentity();
    window.addEventListener('online', retry);
    const t = setInterval(retry, 15_000);
    return () => {
      window.removeEventListener('online', retry);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as in App.tsx
  }, [auth]);
  // Applies the remembered theme to <html>; the shell has no control for it.
  useTheme();

  const route = useRoute();
  const viewer = c.viewer ?? identity;
  const viewerId = viewer?.userId;
  const gated = !!identity && !isAccessActive(identity) && !(c.viewer && isAccessActive(c.viewer));
  const wasGated = useRef(false);
  useEffect(() => {
    if (gated) {
      wasGated.current = true;
      return;
    }
    if (wasGated.current && c.viewer && !isAccessActive(c.viewer)) location.reload();
    wasGated.current = false;
  }, [gated, c.viewer]);

  // Folders shared to the viewer with control, and projects the agents found
  // on disk that no session has run in yet — the same two sources the full
  // start screen offers.
  const [shared, setShared] = useState<ExtraTarget[]>([]);
  useEffect(() => {
    if (auth !== 'ready' || !workspaceId) {
      setShared([]);
      return;
    }
    let alive = true;
    teamApi
      .projects(workspaceId)
      .then((r) => {
        if (alive) setShared(r.projects.filter((p) => p.access === 'control').map((p) => ({ machineId: p.machineId, cwd: p.root, label: p.name })));
      })
      .catch(() => {
        if (alive) setShared([]);
      });
    return () => {
      alive = false;
    };
  }, [auth, workspaceId]);
  const owned = useOwnedProjects(c);
  const extraTargets = useMemo<ExtraTarget[]>(
    () => [
      ...shared,
      ...owned.projects
        .filter((p) => p.origin === 'root' || p.origin === 'adopted')
        .map((p) => ({ machineId: p.machineId, cwd: p.cwd, label: p.label, origin: p.origin, lastModified: p.lastModified })),
    ],
    [shared, owned.projects],
  );

  const communityPlan = identity?.access?.plan === 'community';
  const budget = useBudget(auth === 'ready' && communityPlan && !gated);
  const seat = useMemo<Seat>(
    () => ({ viewerId, community: communityPlan, budget, activeSessionId: c.active?.sessionId || undefined }),
    [viewerId, communityPlan, budget, c.active?.sessionId],
  );

  const runIndex = useMemo(() => indexRuns(c.activeRuns), [c.activeRuns]);

  // What this browser has seen, per task — the «new result» dot.
  const [seen, setSeen] = useState<Seen | null>(null);
  useEffect(() => {
    setSeen(viewerId ? loadSeen(viewerId) : null);
  }, [viewerId]);
  const touch = useCallback(
    (key: string, at: number) => {
      if (!viewerId) return;
      setSeen((prev) => {
        if (!prev) return prev;
        const next = markSeen(prev, key, at);
        if (next !== prev) saveSeen(viewerId, next);
        return next;
      });
    },
    [viewerId],
  );

  const selected = useMemo(
    () => (route.kind === 'session' ? { machineId: route.machineId, sessionId: route.sessionId } : null),
    [route.kind === 'session' ? route.machineId : null, route.kind === 'session' ? route.sessionId : null],
  );
  // A task in flight, before the agent has minted its id (App.tsx `pendingNew`).
  const [pendingNew, setPendingNew] = useState<PendingNew | null>(null);
  const pendingSummary = useMemo<SessionSummary | undefined>(() => {
    if (!pendingNew) return undefined;
    return {
      sessionId: c.active?.sessionId || '',
      title: 'Новая задача',
      cwd: pendingNew.cwd,
      project: pendingNew.project,
      lastModified: Date.now(),
      source: pendingNew.source ?? 'claude',
    } as SessionSummary;
  }, [c.active, pendingNew]);
  const session = useMemo<SessionSummary | undefined>(() => {
    if (!selected) return undefined;
    const real = c.findSession(selected.machineId, selected.sessionId);
    if (real) return real;
    if (pendingNew && pendingNew.machineId === selected.machineId) return pendingSummary;
    return undefined;
  }, [selected, c.findSession, pendingNew, pendingSummary]);

  // When the last start left this browser, and not yet answered with an id.
  // A REF, not the state above: the guard in `startTask` is reached through
  // closures a screen captured at its last render, and two presses can both
  // land before that screen renders again — each then reads `pendingNew` as it
  // was, i.e. empty, and each starts a session. (Seen on production on the
  // first real task: a second press 0.7 s after the first, from a tab whose
  // render had not caught up, started the same task twice.) A ref is the one
  // thing both presses read fresh.
  const startingAt = useRef(0);
  useEffect(() => {
    if (!pendingNew || c.active?.sessionId) startingAt.current = 0;
  }, [pendingNew, c.active?.sessionId]);

  // The placeholder address becomes the session's own once the agent reports
  // its id, and the placeholder is dropped once the inventory has the session.
  useEffect(() => {
    if (!pendingNew) return;
    const realId = c.active?.sessionId;
    if (realId && selected?.sessionId === '' && selected.machineId === pendingNew.machineId) {
      navigate({ kind: 'session', machineId: pendingNew.machineId, sessionId: realId }, { replace: true });
    }
    if (realId) {
      const m = c.machines.find((x) => x.machine.machineId === pendingNew.machineId);
      if (m?.sessions.some((s) => s.sessionId === realId)) setPendingNew(null);
    }
  }, [c.active, c.machines, pendingNew, selected]);

  const startTask = (
    machineId: string,
    cwd: string,
    message: string,
    images: ImageInput[] | undefined,
    files: FileInput[] | undefined,
    project: string | undefined,
    source: 'claude' | 'codex' | undefined,
    startup: StartSettings,
  ): boolean => {
    // One task may be starting at a time: the socket follows one new run. A
    // start that never got an id stops holding the door after 30 s.
    if (startingAt.current && Date.now() - startingAt.current < 30_000) {
      c.notifyError('Предыдущая задача ещё запускается — отправьте через пару секунд.');
      return false;
    }
    // Send first, and stay put if it did not go: the text is only safe while
    // it is still in the box that holds it.
    if (!c.newSession(machineId, cwd, message, images, undefined, source, files, startup)) return false;
    startingAt.current = Date.now();
    setPendingNew({ at: Date.now(), machineId, cwd, ...(project ? { project } : {}), ...(source ? { source } : {}) });
    navigate({ kind: 'session', machineId, sessionId: '' });
    return true;
  };

  // Arriving at a task by any route — a row, a link, a reload, Back — attaches
  // the view. Once per task, and only when the socket and the machine are here.
  const attached = useRef('');
  useEffect(() => {
    if (route.kind !== 'session' || !route.sessionId || c.status !== 'open') return;
    const key = sessionKey(route.machineId, route.sessionId);
    if (attached.current === key) return;
    if (!c.machines.some((m) => m.machine.machineId === route.machineId)) return;
    attached.current = key;
    c.focusSession(route.machineId, route.sessionId);
  }, [route, c.status, c.machines, c.focusSession]);

  // A task on screen has been seen — now, and again each time it stops.
  const openKey = selected?.sessionId ? sessionKey(selected.machineId, selected.sessionId) : '';
  const openRun = openKey ? runIndex.get(openKey) : undefined;
  // The receipt is compared with the HUB's and the machine's timestamps, so it
  // is stamped no earlier than the newest of them: with a clock ahead of this
  // browser's, a receipt of `Date.now()` alone would be older than the result
  // it acknowledges, and the dot would survive being looked at.
  useEffect(() => {
    if (openKey) touch(openKey, Math.max(Date.now(), openRun?.since ?? 0, session?.lastModified ?? 0));
  }, [openKey, openRun?.state, openRun?.since, session?.lastModified, touch]);
  const onScreen = useMemo(() => new Set(openKey ? [openKey] : []), [openKey]);
  // Tell the hub the task in front is seen, and fold in what other devices saw.
  useEffect(() => {
    c.markSessionsRead(onScreen);
  }, [onScreen, openRun?.state, openRun?.since, c.markSessionsRead]);
  const seenWithReads = useMemo(() => (seen ? withReads(seen, c.reads) : seen), [seen, c.reads]);
  useEffect(() => {
    c.dismissOnScreen(onScreen);
  }, [onScreen, c.notifications, c.dismissOnScreen]);

  if (auth === 'loading') {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <Brand />
          <p>Загружаем…</p>
        </div>
      </div>
    );
  }
  if (auth === 'offline') {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <Brand />
          <h1>Нет связи с хабом</h1>
          <p>Задачи идут на машинах и ничего не теряют — экран вернётся сам, как только появится сеть.</p>
          <button className="btn primary auth-login" onClick={() => void refreshIdentity()}>
            Попробовать сейчас
          </button>
        </div>
      </div>
    );
  }
  if (auth === 'mfa' && mfaState) {
    return <MfaScreen state={mfaState} brand="Hegai Code" onSignOut={() => teamApi.logout().then(() => location.reload())} />;
  }
  if (auth === 'unauthenticated') {
    return (
      <div className="auth-screen">
        <div className="auth-card lt-door">
          <Brand />
          <h1>Опишите задачу — агент сделает</h1>
          <p>
            Простой вход в Hegai Code: те же машины, проекты и сессии, что в полной версии, — без пульта. Пишете, что
            нужно, и получаете результат.
          </p>
          <div className="lt-door-actions">
            <a className="btn primary auth-login" href={googleStartHref()}>
              Войти через Google
            </a>
            <GithubDoorButton />
            <TelegramSignInButton />
          </div>
          <a className="lt-quiet" href={FULL_ORIGIN}>
            Полная версия — {FULL_ORIGIN.replace(/^https?:\/\//, '')}
          </a>
        </div>
      </div>
    );
  }
  if (gated && identity) {
    return (
      <>
        <TelegramSignedInBanner userId={identity.userId} />
        <AccessGate viewer={identity} onRefresh={refreshIdentity} onLogout={() => teamApi.logout().then(() => location.reload())} />
      </>
    );
  }

  const selectedMachine = selected ? c.machines.find((m) => m.machine.machineId === selected.machineId) : undefined;
  const canDrive = selectedMachine?.canControl !== false || selectedMachine?.canStart === true;
  // Mid-takeover or already ours: the stale `livePid` can outlive a successful
  // takeover by one inventory refresh (App.tsx `ownsSelected`).
  const ownsSelected =
    !!c.active &&
    c.active.machineId === selected?.machineId &&
    c.active.sessionId === selected?.sessionId &&
    (!!c.active.runId || c.busy);

  const body = () => {
    if (route.kind === 'sessions' || route.kind === 'new') {
      return (
        <Home
          central={c}
          viewer={viewer}
          runIndex={runIndex}
          seen={seenWithReads}
          extraTargets={extraTargets}
          onStart={startTask}
          onProjectsChanged={owned.refresh}
        />
      );
    }
    if (route.kind === 'reports') {
      return (
        <Suspense fallback={<div className="route-pending" aria-hidden="true" />}>
          <Reports route={route} />
        </Suspense>
      );
    }
    if (route.kind === 'session' && selected) {
      if (session) {
        return (
          <TaskView
            central={c}
            session={session}
            machineId={selected.machineId}
            working={openRun?.state === 'working'}
            canDrive={canDrive}
            ownsSelected={ownsSelected}
          />
        );
      }
      // Before the first snapshot an unresolved address means «loading».
      if (!selected.sessionId || c.status !== 'open' || !c.hydrated || pendingNew) {
        return <div className="route-pending" aria-hidden="true" />;
      }
      return (
        <div className="placeholder">
          <div className="ph-sub">
            {selectedMachine
              ? `Задача не найдена на «${selectedMachine.machine.name}» — её могли удалить.`
              : 'Эта машина недоступна в текущем пространстве.'}
          </div>
          <div className="lt-ph-actions">
            <button className="btn" onClick={() => navigate(SESSIONS)}>
              К задачам
            </button>
          </div>
        </div>
      );
    }
    // Команда, Файлы, Настройки, Доска, колонки: real screens, on the full
    // client. Say so rather than draw a home under an address that names
    // something else.
    return (
      <div className="placeholder">
        <div className="ph-sub">Этот экран есть в полной версии Hegai Code.</div>
        <div className="lt-ph-actions">
          <a className="btn primary" href={fullHref()}>
            Открыть в полной версии
          </a>
          <button className="btn" onClick={() => navigate(SESSIONS)}>
            К задачам
          </button>
        </div>
      </div>
    );
  };

  const name = viewer?.fullName || viewer?.email || '';
  // A question belongs to its task. The socket stays attached to the run it
  // followed last, so the request arrives wherever the person is — and the
  // full client's host would raise it right there, over the home, with no
  // conversation under it to say what is being asked. Here it waits as a row
  // under «Ждут вас» and is asked when that task is on screen.
  const askHere =
    !!c.toolReq &&
    !!c.active &&
    c.toolReq.runId === c.active.runId &&
    route.kind === 'session' &&
    route.machineId === c.active.machineId &&
    (route.sessionId === c.active.sessionId || route.sessionId === '');
  // One bar per screen: a task has its own head (back, name, the door to the
  // full client), and two bars are a fifth of a phone.
  const inTask = route.kind === 'session';
  return (
    <SeatContext.Provider value={seat}>
    <ShareRootsContext.Provider value={shared}>
      <div className="app lt-app">
        <TelegramSignedInBanner userId={identity?.userId} />
        {!inTask && <header className="lt-top">
          <a className="lt-home-link" {...linkProps(SESSIONS)} title="К задачам">
            <Brand />
          </a>
          <nav className="lt-nav" aria-label="Разделы">
            <a className={`lt-nav-link${route.kind === 'reports' ? ' here' : ''}`} {...linkProps({ kind: 'reports' })}>
              Отчёты
            </a>
            <a className="lt-nav-link" href={fullHref()} title="Тот же экран в полной версии: машины, файлы, команда, настройки">
              <span>
                Полная<span className="lt-wide"> версия</span>
              </span>
              <ArrowSquareOut size={13} />
            </a>
            <button
              type="button"
              className="lt-nav-link"
              onClick={() => void teamApi.logout().then(() => location.reload())}
              title={name ? `Выйти — ${name}` : 'Выйти'}
            >
              Выйти
            </button>
          </nav>
        </header>}
        <main className="lt-main">{body()}</main>
        <ModalHost central={c} suppressToolReq={!askHere} />
      </div>
    </ShareRootsContext.Provider>
    </SeatContext.Provider>
  );
}
