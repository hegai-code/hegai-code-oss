import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { SessionSummary } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { SessionColumn } from './SessionColumn.js';
import { AgentMark } from './AgentMark.js';
import { Chat } from '../panels/Chat.js';
import { ColumnsIcon, X } from '../icons.js';
import { paneLabel, type TabInfo } from './tabInfo.js';
import { GroupDropZone, TabStrip } from './TabStrip.js';
import type { TabGroup } from '../tabs.js';
import {
  SESSIONS,
  navigate,
  setSplitFocus,
  splitRoute,
  useSplitFocus,
  type ColRef,
  type PaneRoute,
} from '../router.js';
import { storageGet, storageRemove, storageSet } from '../storage.js';

/** A pane's narrowest width while resizing — the same floor as `.session-col`'s
 *  `min-width` in styles.css, so a drag never asks for less than CSS allows. */
const PANE_MIN = 300;

/** Where the split's widths are remembered: per browser and per NUMBER of
 *  panes — three panes sized for one pair of sessions mean nothing to two. */
const GROW_PREFIX = 'cc-col-grow::';

function loadGrow(n: number): number[] {
  try {
    const raw = JSON.parse(storageGet(GROW_PREFIX + n) ?? 'null') as unknown;
    if (Array.isArray(raw) && raw.length === n && raw.every((x) => typeof x === 'number' && x > 0 && Number.isFinite(x))) {
      return raw as number[];
    }
  } catch {
    // unreadable — equal widths
  }
  return Array.from({ length: n }, () => 1);
}

function saveGrow(n: number, grow: number[]): void {
  // Storage unavailable — the widths still hold for this page.
  if (grow.every((g) => Math.abs(g - 1) < 0.001)) storageRemove(GROW_PREFIX + n);
  else storageSet(GROW_PREFIX + n, JSON.stringify(grow.map((g) => Math.round(g * 1000) / 1000)));
}

/**
 * The split: the screen divided into 2–4 panes (router `COL_MAX`), each showing
 * any screen of the app — a live session, Файлы, Проекты, Команда, Настройки,
 * the new-chat composer.
 *
 * It began as sessions only, side by side, and grew into this on request
 * (24.09.2026): the split is a division of the SCREEN. One pane has focus — the
 * last one pressed, marked by its header — and everything chosen outside the
 * panes opens in it: a session from the side panel, a destination, «Новый чат».
 * The routing lives in `navigate` (`intoPane`, router.ts), so the screens inside
 * the panes are the ordinary screens and do not know they are in one.
 *
 * Only SESSION panes carry a session view of their own (`SessionColumn`, one
 * per session — that is what lets four runs stream at once). Since 24.09.2026
 * that view rides the shell's socket rather than opening one: the window holds
 * ONE /ui socket however many panes it shows (web/src/sessionChannel.ts).
 * Every other pane is rendered by the shell (`renderPage`).
 *
 * The set lives in the URL (`?s=…`), so a split survives a refresh and can be
 * handed to someone else. Panes are added with right-click → «Добавить в
 * колонку», reordered by dragging a header, closed with ✕; a split of one
 * dissolves into that screen.
 */
export function SessionColumns({
  central,
  panes,
  canRename,
  onRename,
  onSessionMenu,
  renderPage,
  resolveSession,
  pendingSession,
  stacked = false,
  groups = [],
  tabInfo,
  newTab,
}: {
  /** What a strip's «+» opens beside its active tab. */
  newTab?: (beside: PaneRoute | undefined) => PaneRoute;
  /** The tab groups, one per pane (tabs.ts). Absent or short → no strips. */
  groups?: TabGroup[];
  /** A tab's face — title, agent, state. */
  tabInfo?: (p: PaneRoute) => TabInfo;
  /** A narrow window: the panes become TABS over one pane, instead of the
   *  split being dissolved into its focused session (which is what it did
   *  until 25.09.2026 — narrow the window and the other columns were gone
   *  for good, even after widening it again). The set stays in the URL, so
   *  widening the window brings the columns straight back. */
  stacked?: boolean;
  central: CentralState;
  panes: PaneRoute[];
  /** Whether the viewer may rename this pane's session. */
  canRename: (ref: ColRef) => boolean;
  /** Rename a pane's session — the pane's title is an inline editor. */
  onRename: (ref: ColRef, title: string, session: SessionSummary) => Promise<void>;
  /** A pane head's «…»: the session menu, as on a side-panel row. */
  onSessionMenu?: (machineId: string, sessionId: string, x: number, y: number) => void;
  /** The shell's own rendering of a non-session screen, for a pane. */
  renderPage: (pane: PaneRoute) => ReactNode;
  /** A session by ref: the inventory, or the one just started and not in it yet. */
  resolveSession: (machineId: string, sessionId: string) => SessionSummary | undefined;
  /** The session started from a composer pane, while it has no id yet. */
  pendingSession?: { machineId: string; session: SessionSummary };
}) {
  const focus = Math.min(useSplitFocus(), Math.max(0, panes.length - 1));
  const machineName = (id: string) => central.machines.find((m) => m.machine.machineId === id)?.machine.name;
  const loaded = central.machines.length > 0;

  // A session pane whose session is gone (a rebuilt machine, a deleted session)
  // is not drawn. Before the inventory lands nothing resolves, so nothing is
  // judged gone yet.
  const gone = (p: PaneRoute) =>
    loaded && p.kind === 'session' && !!p.sessionId && !resolveSession(p.machineId, p.sessionId);
  const stale = loaded && panes.length > 0 && panes.every(gone);

  /** Replace the set. Edits to the split are not travel, so `replace`; and they
   *  mean the whole window, so `whole` — they must not be routed into a pane. */
  const commit = (next: PaneRoute[], nextFocus: number) => {
    setSplitFocus(Math.max(0, Math.min(nextFocus, next.length - 1)));
    navigate(splitRoute(next), { replace: true, whole: true });
  };

  const remove = (i: number) => {
    // Dead panes go with it: they hold the cap hostage and cannot be seen.
    const keep = panes.map((p, j) => j !== i && !gone(p));
    const next = panes.filter((_, j) => keep[j]);
    // Focus stays on the pane it was on; closing the focused one hands it to
    // the neighbour that slides into its place.
    const before = panes.slice(0, focus).filter((_, j) => keep[j]).length;
    commit(next, i === focus ? Math.min(before, next.length - 1) : before);
  };

  // Reordering by dragging a pane's header. The order IS the set in the URL, so
  // a rearranged split is still a link.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const endDrag = () => {
    setDragIdx(null);
    setOverIdx(null);
  };
  const reorder = (from: number, to: number) => {
    endDrag();
    if (from === to) return;
    const next = panes.slice();
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    // Focus follows the pane, not the position.
    const focused = panes[focus];
    commit(next, focused ? next.indexOf(focused) : 0);
  };

  // Below 861px the split is drawn `stacked` — its panes as a row of chips over
  // one pane — so there are no page dots and no scroll-snap here.

  // ---- widths: a handle in each gap, dragged to move the boundary ----
  // Each pane's share is its `flex-grow` over a zero basis (styles.css), so the
  // widths are the shares, and a drag only ever trades width between the two
  // panes either side of the handle — the others do not move. Double-click a
  // handle to go back to equal. (Asked for 27.09.2026.)
  const count = panes.length;
  const [grow, setGrow] = useState<number[]>(() => loadGrow(count));
  const growRef = useRef(grow);
  growRef.current = grow;
  useEffect(() => {
    setGrow(loadGrow(count));
  }, [count]);
  const [resizing, setResizing] = useState(false);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>, a: number, b: number) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const left = handle.previousElementSibling as HTMLElement | null;
    const right = handle.nextElementSibling as HTMLElement | null;
    if (!left || !right) return;
    e.preventDefault();
    const wa = left.getBoundingClientRect().width;
    const wb = right.getBoundingClientRect().width;
    const g0 = growRef.current.length === count ? growRef.current : loadGrow(count);
    const total = (g0[a] ?? 1) + (g0[b] ?? 1);
    const x0 = e.clientX;
    setResizing(true);
    // The last value COMPUTED, not the last one rendered: a pointerup can
    // arrive before React has drawn the final move, and saving `growRef` there
    // remembered the width one step short of where the drag ended.
    let latest = g0;
    const move = (ev: PointerEvent) => {
      const na = Math.max(PANE_MIN, Math.min(wa + wb - PANE_MIN, wa + (ev.clientX - x0)));
      const next = g0.slice();
      next[a] = (total * na) / (wa + wb);
      next[b] = total - next[a]!;
      latest = next;
      setGrow(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setResizing(false);
      saveGrow(count, latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const resetWidths = () => {
    const eq = Array.from({ length: count }, () => 1);
    setGrow(eq);
    saveGrow(count, eq);
  };

  if (stale) {
    return (
      <div className="columns-empty">
        <ColumnsIcon size={40} />
        <div className="ce-title">Этих сессий больше нет</div>
        <div className="ce-sub">
          Ссылка ведёт на сессии, которых уже не найти — машина сменилась или их удалили.
        </div>
        <div className="ce-actions">
          <button className="btn primary" onClick={() => navigate(SESSIONS, { whole: true })}>
            К списку сессий
          </button>
        </div>
      </div>
    );
  }

  // React keys: a session pane is its session, so reordering never reconnects
  // its socket; any other pane is its kind plus how many of that kind come
  // before it, so Файлы keep their state while their folder changes.
  const seen = new Map<string, number>();
  const keyOf = (p: PaneRoute) => {
    if (p.kind === 'session' && p.sessionId) return `s:${p.machineId}::${p.sessionId}`;
    // Two «+» composers are two screens: switching tabs between them must
    // remount, or the second shows the first one's state.
    if (p.kind === 'new' && p.n) return `new:${p.n}`;
    const n = seen.get(p.kind) ?? 0;
    seen.set(p.kind, n + 1);
    return `${p.kind}#${n}`;
  };

  /** The pane in front when stacked. `focus` is module state that outlives a
   *  route, so it can name a pane that is gone — then the first live one. */
  const front = stacked && panes[focus] && gone(panes[focus]!) ? Math.max(0, panes.findIndex((p) => !gone(p))) : focus;

  /** The tab's name: the session's title, or the screen the pane shows. */
  const tabOf = (p: PaneRoute): { title: string; source?: string; provider?: string; working: boolean } => {
    if (p.kind === 'session' && p.sessionId) {
      const s = resolveSession(p.machineId, p.sessionId);
      const working = central.runFor(p.machineId, p.sessionId)?.state === 'working';
      return { title: s?.title || p.sessionId.slice(0, 8), source: s?.source, provider: s?.provider, working };
    }
    const shown: PaneRoute = p.kind === 'session' ? { kind: 'new' } : p;
    return { title: paneLabel(shown, machineName).title, working: false };
  };

  const paneNodes: { i: number; node: ReactNode }[] = [];
  panes.forEach((p, i) => {
    const k = keyOf(p);
    if (gone(p)) return;
    // Stacked: only the tab in front is mounted — a hidden pane would
    // still read its history and hold its stream, for nothing on screen.
    if (stacked && i !== front) return;
    const drag = {
      dragging: dragIdx === i,
      dropTarget: dragIdx !== null && overIdx === i && dragIdx !== i,
      onDragStart: () => setDragIdx(i),
      onDragEnd: endDrag,
      onDragOver: () => setOverIdx(i),
      onDrop: () => dragIdx !== null && reorder(dragIdx, i),
    };
    const width = stacked ? undefined : grow[i];
    const focusProps = {
      focused: i === focus,
      onFocusPane: () => setSplitFocus(i),
    };
    // Not when stacked: the phone draws the split as its own row of chips.
    const group = groups[i];
    const tabs =
      !stacked && group && tabInfo ? (
        <>
          <TabStrip group={group} groupIndex={i} focused={i === focus} info={tabInfo} newTab={newTab} />
          <GroupDropZone groupIndex={i} />
        </>
      ) : undefined;

    if (p.kind === 'session' && p.sessionId) {
      const session = resolveSession(p.machineId, p.sessionId);
      // Not in the inventory yet and not the one just started: the socket
      // has not seen it. Keep the pane's place, draw it when it arrives.
      if (!session) return;
      const ref = { machineId: p.machineId, sessionId: p.sessionId };
      paneNodes.push({ i, node: (
        <SessionColumn
          key={k}
          central={central}
          session={session}
          machineId={p.machineId}
          machineName={machineName(p.machineId)}
          onClose={() => remove(i)}
          onMenu={onSessionMenu ? (x, y) => onSessionMenu(p.machineId, p.sessionId, x, y) : undefined}
          onRename={canRename(ref) ? (title) => onRename(ref, title, session) : undefined}
          {...focusProps}
          {...drag}
          grow={width}
          tabs={tabs}
        />
      ) });
      return;
    }

    // A session started from this pane's composer, before the agent has
    // named it. It streams on the SHELL's socket — the one that started it
    // and holds its first line — until the id arrives and the pane becomes
    // an ordinary session pane with a session view of its own.
    if (p.kind === 'session' && pendingSession && pendingSession.machineId === p.machineId) {
      paneNodes.push({ i, node: (
        <PagePane
          key={k}
          grow={width}
          title="Новый чат"
          sub="запускается…"
          onClose={() => remove(i)}
          {...focusProps}
          {...drag}
          tabs={tabs}
        >
          <Chat central={central} session={pendingSession.session} machineId={p.machineId} takingOver={false} />
        </PagePane>
      ) });
      return;
    }

    const shown: PaneRoute = p.kind === 'session' ? { kind: 'new' } : p;
    const label = paneLabel(shown, machineName);
    paneNodes.push({ i, node: (
      <PagePane key={k} grow={width} title={label.title} sub={label.sub} onClose={() => remove(i)} {...focusProps} {...drag} tabs={tabs} page>
        {renderPage(shown)}
      </PagePane>
    ) });
  });

  return (
    <div className={`session-columns${stacked ? ' stacked' : ''}${resizing ? ' resizing' : ''}`}>
      {stacked && (
        <div className="cols-tabs" role="tablist" aria-label="Колонки">
          {panes.map((p, i) => {
            if (gone(p)) return null;
            const t = tabOf(p);
            return (
              <div key={`tab-${i}`} className={`cols-tab${i === front ? ' on' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={i === front}
                  className="cols-tab-main"
                  onClick={() => setSplitFocus(i)}
                  title={t.title}
                >
                  {t.working && <AgentMark source={t.source} provider={t.provider} size={11} />}
                  <span className="cols-tab-title">{t.title}</span>
                </button>
                <button type="button" className="cols-tab-x" onClick={() => remove(i)} aria-label={`Закрыть «${t.title}»`}>
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {stacked
        ? paneNodes.map((x) => x.node)
        : paneNodes.flatMap((x, j) => {
            const prev = paneNodes[j - 1];
            if (!prev) return [x.node];
            return [
              <div
                key={`rz-${prev.i}-${x.i}`}
                className="col-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label="Ширина колонок"
                title="Потянуть — изменить ширину, двойной щелчок — поровну"
                onPointerDown={(e) => startResize(e, prev.i, x.i)}
                onDoubleClick={resetWidths}
              />,
              x.node,
            ];
          })}
    </div>
  );
}

/** A pane that shows a screen rather than a session: the same header — title,
 *  ✕, dragged to reorder — over the screen itself. */
function PagePane({
  grow,
  title,
  sub,
  onClose,
  focused,
  onFocusPane,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  page = false,
  tabs,
  children,
}: {
  tabs?: ReactNode;
  /** Share of the split's width — see `grow` on SessionColumn. */
  grow?: number;
  title: string;
  sub?: string;
  onClose: () => void;
  focused: boolean;
  onFocusPane: () => void;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  /** A full screen inside: it needs the `.main` flex contract to scroll itself. */
  page?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`session-col pane${focused ? ' focused' : ''}${dragging ? ' dragging' : ''}${dropTarget ? ' drop' : ''}`}
      aria-current={focused ? 'true' : undefined}
      style={grow !== undefined ? { flexGrow: grow } : undefined}
      onPointerDownCapture={onFocusPane}
      onFocusCapture={onFocusPane}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      {tabs}
      <header
        className="sc-col-head"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', title);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
      >
        <div className="sc-col-titles">
          <div className="sc-col-title static">{title}</div>
          {/* Always a second line, empty or not: a pane's head is the same
              height whatever it shows, or the panes' bodies start at
              different heights side by side. */}
          <div className="sc-col-sub">
            <span className="sc-col-src">{sub ?? '\u00a0'}</span>
          </div>
        </div>
        <button className="icon-btn sc-col-close" onClick={onClose} title="Закрыть панель" aria-label="Закрыть панель">
          <X size={16} />
        </button>
      </header>
      {page ? <div className="pane-body main">{children}</div> : children}
    </section>
  );
}
