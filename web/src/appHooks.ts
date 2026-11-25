import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ProjectsResult, SessionSummary, SessionForkResult } from '@cc-remote/shared';
import type { CentralState } from './useCentral.js';
import { apiJsonOrNull } from './api.js';
import { toMillis } from './lib.js';
import { storageGet, storageSet } from './storage.js';
import { askConfirm, askText, showNotice } from './dialogs.js';

/** Desktop sidebar: collapse-to-nothing + drag-resize (240–480px), both
 *  persisted. `resizing` kills the width transition so the edge tracks the
 *  pointer crisply. */
export function usePersistentSidebar() {
  const [collapsed, setCollapsed] = useState(() => storageGet('cc-sidebar-collapsed') === '1');
  const [width, setWidth] = useState(() => {
    const w = Number(storageGet('cc-sidebar-width'));
    return Number.isFinite(w) && w >= 260 && w <= 480 ? w : 320;
  });
  const [resizing, setResizing] = useState(false);

  const toggle = useCallback(() => {
    setCollapsed((v) => {
      storageSet('cc-sidebar-collapsed', v ? '0' : '1');
      return !v;
    });
  }, []);

  // Tears down a drag in progress: its listeners and the body's cursor and
  // text-selection lock. Kept in a ref so the drag can also end WITHOUT a
  // `pointerup` — the browser cancelling the gesture (`pointercancel`: a touch
  // taken over by a scroll, a stolen capture) or the sidebar unmounting
  // mid-drag. Either used to leave the window listeners attached and the page
  // stuck in `col-resize` with selection off.
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  const startResize = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    endDrag.current?.();
    setResizing(true);
    const onMove = (ev: PointerEvent) => setWidth(Math.min(480, Math.max(260, ev.clientX)));
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      endDrag.current = null;
    };
    const onUp = () => {
      cleanup();
      setResizing(false);
      setWidth((w) => {
        storageSet('cc-sidebar-width', String(w));
        return w;
      });
    };
    endDrag.current = cleanup;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  return { collapsed, toggle, width, resizing, startResize };
}

/** Favorite sessions, persisted as a set of `machine::session` keys. */
export function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(storageGet('cc-favs') ?? '[]'));
    } catch {
      return new Set<string>();
    }
  });
  const toggleFav = useCallback((key: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      storageSet('cc-favs', JSON.stringify([...next]));
      return next;
    });
  }, []);
  return { favorites, toggleFav };
}

/**
 * Projects this person hid from the side panel, by panel key (the label the
 * card is grouped under). Per device, like favourites: a hide is a personal
 * tidy-up, not a statement about the project, and nothing is deleted — the
 * panel keeps a folded «Скрытые» section to bring one back.
 */
/** A per-device set of project keys in localStorage, shared live between every
 *  mounted panel (desk panel + phone drawer) without a reload. Hidden, pinned
 *  and folded projects are three of these. */
function projectSetStore(storageKey: string) {
  const listeners = new Set<(next: Set<string>) => void>();
  let cache: Set<string> | null = null;
  const read = (): Set<string> => {
    try {
      const raw: unknown = JSON.parse(storageGet(storageKey) ?? '[]');
      return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set<string>();
    }
  };
  const current = () => (cache ??= read());
  return function useProjectSet() {
    const [set, setSet] = useState<Set<string>>(current);
    useEffect(() => {
      listeners.add(setSet);
      return () => {
        listeners.delete(setSet);
      };
    }, []);
    const toggle = useCallback((key: string, on: boolean) => {
      const next = new Set(current());
      if (on) next.add(key);
      else next.delete(key);
      cache = next;
      // Private mode: lasts until reload.
      storageSet(storageKey, JSON.stringify([...next]));
      for (const l of listeners) l(next);
    }, []);
    return [set, toggle] as const;
  };
}

const useHiddenSet = projectSetStore('cc-hidden-projects');
export function useHiddenProjects() {
  const [hidden, setProjectHidden] = useHiddenSet();
  return { hidden, setProjectHidden };
}

/** Servers the start screen hides — same shelf, same live sharing, per device. */
export const useHiddenMachines = projectSetStore('cc-hidden-machines');

/** Projects pinned to the top of the side panel («Закрепить» in a project's
 *  «…» menu, 08.10.2026). Per device, like hiding. */
export const usePinnedProjects = projectSetStore('cc-pinned-projects');

/** Projects folded to their heading in the side panel (the folder glyph). */
export const useFoldedProjects = projectSetStore('cc-folded-projects');

/** Which session an action is about. */
export interface SessionRef {
  machineId: string;
  sessionId: string;
}

/**
 * Rename / delete / fork / close a session. The browser prompt/confirm/alert UX
 * lives here so callers just wire buttons.
 *
 * Each action takes its TARGET rather than closing over the selected session.
 * It used to close over it, which was fine while the only door to these was the
 * «О сессии» panel of the session you were reading — and wrong the moment the
 * session list grew a right-click menu, because that menu is most often opened
 * on a row you have NOT opened. The summary is looked up from the inventory;
 * `session` overrides it for a brand-new session that is not in one yet.
 *
 * `clearSelection` receives the target so a caller can decide whether the thing
 * that was deleted is the thing on screen. Dropping the selection because
 * somebody deleted an unrelated row is how you lose your place.
 */
export function useSessionActions(
  c: CentralState,
  { openSession, clearSelection }: {
    openSession: (machineId: string, sessionId: string) => void;
    clearSelection: (target: SessionRef) => void;
  },
) {
  /** The rename itself, with the title already decided — what an inline editor
   *  calls. Throws on failure so the caller can put the old title back. */
  const renameTo = useCallback(async (target: SessionRef, title: string, session?: SessionSummary) => {
    const s = session ?? c.findSession(target.machineId, target.sessionId);
    if (!s?.cwd) throw new Error('сессии нет в списке машины');
    await c.rpc(target.machineId, 'session.rename', { sessionId: target.sessionId, cwd: s.cwd, title, source: s.source });
    c.rescan(target.machineId);
  }, [c]);

  const renameSession = useCallback(async (target: SessionRef, session?: SessionSummary) => {
    const s = session ?? c.findSession(target.machineId, target.sessionId);
    if (!s?.cwd) return;
    const title = await askText('Новое название', s.title);
    if (!title) return;
    try {
      await renameTo(target, title, s);
    } catch (err) {
      void showNotice(`Не удалось переименовать: ${(err as Error).message}`);
    }
  }, [c, renameTo]);

  const deleteSession = useCallback(async (target: SessionRef, session?: SessionSummary) => {
    const s = session ?? c.findSession(target.machineId, target.sessionId);
    if (!s?.cwd) return;
    if (!(await askConfirm('Удалить запись этой сессии?', { confirmLabel: 'Удалить', danger: true }))) return;
    try {
      await c.rpc(target.machineId, 'session.delete', { sessionId: target.sessionId, cwd: s.cwd, source: s.source });
      clearSelection(target);
      c.rescan(target.machineId);
    } catch (err) {
      void showNotice(`Не удалось удалить: ${(err as Error).message}`);
    }
  }, [c, clearSelection]);

  const forkSession = useCallback(async (target: SessionRef, session?: SessionSummary) => {
    const s = session ?? c.findSession(target.machineId, target.sessionId);
    if (!s?.cwd) return;
    try {
      const r = await c.rpc<SessionForkResult>(target.machineId, 'session.fork', {
        sessionId: target.sessionId,
        cwd: s.cwd,
      });
      c.rescan(target.machineId);
      if (r?.sessionId) openSession(target.machineId, r.sessionId);
    } catch (err) {
      void showNotice(`Не удалось ответвить сессию: ${(err as Error).message}`);
    }
  }, [c, openSession]);

  /**
   * Close the session, or put it back to work.
   *
   * NOT an RPC and deliberately not one: closing changes nothing on the
   * machine. It writes the stage `done` (`set_stage`), which the hub persists
   * per (machine, session) and records in the audit trail — so «closed by whom,
   * when» stays answerable after the fact. The transcript is untouched; only
   * the lists stop carrying it (see `showClosed`).
   *
   * The web board that used to read the other stages is gone; this write is
   * not. The field is the protocol's and the iPhone's Flow lens still draws the
   * whole ladder — removing the write here would quietly stop a session closed
   * on a laptop from showing as closed on a phone.
   *
   * No confirm: this is reversible by the same button, and a dialog in front of
   * an undoable action is the one that teaches people to click through dialogs.
   */
  const closeSession = useCallback((target: SessionRef, session?: SessionSummary) => {
    const s = session ?? c.findSession(target.machineId, target.sessionId);
    const closed = s?.stage === 'done';
    c.setStage(target.machineId, target.sessionId, closed ? undefined : 'done');
    // Leaving the list under someone who just closed the session they are
    // reading is the wrong end of the action — they closed it to stop looking
    // at it, so drop the selection and let the list settle without it.
    if (!closed) clearSelection(target);
  }, [c, clearSelection]);

  return { renameTo, renameSession, deleteSession, forkSession, closeSession };
}

/**
 * Keep the shell the size of the area the user can actually see.
 *
 * `html,body,#root{height:100%}` resolves against the LAYOUT viewport, which a
 * software keyboard does not shrink — it overlays the VISUAL one. So the bottom
 * of the shell keeps rendering underneath the keyboard: the composer's send
 * button, the mobile tab bar, and the bottom of the transcript where
 * `pinToBottom()` parks the newest message. `body{overflow:hidden}` means there
 * is no scrolling to any of it, which is why a reply arriving with the keyboard
 * open reads as "the scroll jumped and nothing is visible".
 *
 * `interactive-widget=resizes-content` (index.html) fixes this on Chrome/Android
 * and Safari 26+ with no JS at all. Every older iOS Safari ignores it, so
 * measure the visual viewport and publish it as `--app-h` for `.app` to use.
 *
 * Pinch-zoom shrinks the visual viewport too, and that one must NOT resize the
 * shell — see the 16px-font note in styles.css for the last time these two got
 * confused. `scale` separates them.
 */
/** REVERTED from use — see the note on `.app` in styles.css. Shipping this
 *  collapsed the shell on a phone with the keyboard up. Kept only as the record
 *  of what was tried; do not wire it back without measuring on a device. */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      const h = vv.scale > 1.01 ? window.innerHeight : vv.height;
      root.style.setProperty('--app-h', `${Math.round(h)}px`);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      root.style.removeProperty('--app-h');
    };
  }, []);
}

// ---------------------------------------------------------------------------
// [community] Projects the viewer owns, asked of each machine's agent
// ---------------------------------------------------------------------------

/** One row of `projects.list`, stamped with the machine it came from. */
export interface OwnedProject {
  machineId: string;
  cwd: string;
  label: string;
  origin?: 'sessions' | 'root' | 'adopted';
  lastModified: number;
  count: number;
}

/**
 * `projects.list` from every ONLINE machine the viewer controls.
 *
 * The fleet snapshot only knows a project once a session has run in it, so a
 * project created a moment ago — `git init`, README, one commit, no session —
 * is invisible to the shelf until the agent is asked directly. This asks once
 * per machine, and again when:
 *
 * - the SET of controllable online machines changes (a reconnect, a sandbox
 *   joining the fleet) — keyed on the sorted id list, not on the snapshot
 *   object, so the ~6 s inventory ticks do not re-ask;
 * - the socket reopens (`rpc` is rebound to the new `send`);
 * - a caller says so via `refresh()` after a create or remove.
 *
 * Each trigger is debounced 400 ms: a hub restart flips every machine online
 * within a second, and one round of RPCs is enough.
 */
export function useOwnedProjects(c: CentralState): {
  projects: OwnedProject[];
  /** Per machine, the directories its agent scans for projects — where «Добавить
   *  проект» starts browsing. Empty for an agent older than the field: the
   *  picker then falls back to the parents of the projects it did report, rather
   *  than opening on nothing. */
  roots: Record<string, string[]>;
  /**
   * A round of `projects.list` is in flight and has not answered yet.
   *
   * Without it a caller cannot tell "this machine has no projects" from "nobody
   * has asked it yet", and the two look identical: an empty array. The projects
   * screen spent the first ten seconds of every load telling the truth about the
   * wrong thing — «Агент не нашёл здесь ни одного репозитория» on seven machines
   * holding 127 projects between them.
   */
  loading: boolean;
  refresh: () => void;
} {
  const [projects, setProjects] = useState<OwnedProject[]>([]);
  const [roots, setRoots] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const key = useMemo(
    () =>
      c.machines
        .filter((m) => m.online && m.canControl === true)
        .map((m) => m.machine.machineId)
        .sort()
        .join(','),
    [c.machines],
  );
  useEffect(() => {
    if (c.status !== 'open' || !key) {
      setProjects([]);
      setRoots({});
      // Not "still asking" — there is nobody to ask. A disconnected socket or a
      // fleet with no controllable machine is a final answer, and a caller that
      // waited on it would spin forever.
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const ids = key.split(',');
    const t = window.setTimeout(async () => {
      const rows = await Promise.all(
        ids.map(async (machineId) => {
          try {
            const r = await c.rpc<ProjectsResult>(machineId, 'projects.list', {});
            return {
              machineId,
              roots: r.roots ?? [],
              projects: r.projects.map<OwnedProject>((p) => ({
                machineId,
                cwd: p.cwd,
                label: p.label,
                lastModified: p.lastModified,
                count: p.count,
                ...(p.origin ? { origin: p.origin } : {}),
              })),
            };
          } catch {
            // An agent older than `projects.list`, or one mid-reconnect: the
            // shelf simply falls back to what the snapshot knows.
            return { machineId, roots: [] as string[], projects: [] as OwnedProject[] };
          }
        }),
      );
      if (!alive) return;
      setProjects(rows.flatMap((r) => r.projects));
      setRoots(Object.fromEntries(rows.map((r) => [r.machineId, r.roots])));
      setLoading(false);
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [key, c.status, c.rpc, tick]);
  return { projects, roots, loading, refresh };
}

// ---------------------------------------------------------------------------
// [community] The viewer's share of the model pool — `GET /api/budget`
// ---------------------------------------------------------------------------

/** The hub's projection of the seat's gateway limits. Every field is optional:
 *  the endpoint is newer than some hubs (404 → null) and a seat without a
 *  ceiling answers with an empty `limits`. Windows arrive either as a duration
 *  string ("1d", "1h") or seconds; `resetAt` in seconds or ms — both tolerated. */
export interface BudgetLimits {
  tokens?: number;
  tokensUsed?: number;
  tokensWindow?: string | number;
  requests?: number;
  requestsUsed?: number;
  requestsWindow?: string | number;
  resetAt?: number;
}
export interface BudgetInfo {
  plan?: string;
  limits?: BudgetLimits;
}

/** ms epoch of the reset, whichever unit the hub used. */
export function budgetResetMs(limits: BudgetLimits | undefined): number | undefined {
  const r = limits?.resetAt;
  if (!r || r <= 0) return undefined;
  return toMillis(r);
}

/** Human label for a limit window: "день", "час", "7 д". */
export function budgetWindowLabel(w: string | number | undefined): string {
  if (w === undefined || w === null || w === '') return '';
  if (typeof w === 'number') {
    const h = Math.round(w / 3600);
    if (h >= 24 && h % 24 === 0) return h === 24 ? 'день' : `${h / 24} д`;
    return h <= 1 ? 'час' : `${h} ч`;
  }
  const m = /^(\d+)\s*([dhm])$/i.exec(w.trim());
  if (!m) return w;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  if (u === 'd') return n === 1 ? 'день' : `${n} д`;
  if (u === 'h') return n === 1 ? 'час' : `${n} ч`;
  return `${n} мин`;
}

/**
 * Poll the seat's budget every 60 s while `enabled`. `null` = nothing to
 * show: not a community seat, the hub has no endpoint yet, or no ceiling.
 * Only App calls this; everything that renders the figure reads `useSeat()`.
 */
export function useBudget(enabled: boolean): BudgetInfo | null {
  const [budget, setBudget] = useState<BudgetInfo | null>(null);
  useEffect(() => {
    if (!enabled) {
      setBudget(null);
      return;
    }
    let alive = true;
    const load = () =>
      apiJsonOrNull<BudgetInfo>('/api/budget')
        .then((d) => {
          if (!alive) return;
          const l = d?.limits;
          const has = !!l && ((l.tokens ?? 0) > 0 || (l.requests ?? 0) > 0);
          setBudget(has ? d : null);
        })
        .catch(() => {});
    void load();
    const t = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [enabled]);
  return budget;
}

/**
 * What a component deep in the transcript needs to know about the person
 * looking at it, without threading four props through Chat and the blocks.
 * Provided once by App; the transcript's budget card, the usage meter and the
 * session info column read it.
 */
export interface Seat {
  viewerId?: string;
  /** A community seat: its own share of the pool, the sandbox, «Забрать своё». */
  community: boolean;
  budget: BudgetInfo | null;
  /** The session whose run this browser currently holds, if any. */
  activeSessionId?: string;
}
/** The roots shared with the viewer, per machine: where the hub lets a member
 *  write. Read deep in the session panes. */
export const ShareRootsContext = createContext<readonly { machineId: string; cwd: string }[]>([]);

export const SeatContext = createContext<Seat>({ community: false, budget: null });
export function useSeat(): Seat {
  return useContext(SeatContext);
}
