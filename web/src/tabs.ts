import { useSyncExternalStore } from 'react';
import {
  COL_MAX,
  asPane,
  getSplitFocus,
  navigate,
  paneAddress,
  paneSlot,
  parseRoute,
  setSplitFocus,
  setTabLocator,
  splitRoute,
  subscribeRoute,
  type PaneRoute,
  type Route,
} from './router.js';

/**
 * Editor tabs over the split (28.09.2026, by request — VS Code's editor groups
 * as the reference). A feature of the VS Code THEME only (asked the same day):
 * in the Hegai themes every group is exactly its one visible pane, as the split
 * always was, and nothing is remembered behind it — see `tabsOn`.
 *
 * Each column of the split is a GROUP of tabs; only the active tab of each
 * group is on screen. The URL keeps describing exactly what is on screen — one
 * pane per group, as it always has (`?s=`, or a single screen) — so every link,
 * every Back/Forward and every screen that reads the route works unchanged.
 * The background tabs live here, beside the route, and follow it:
 *
 *   - a group whose visible pane is navigated elsewhere (a click in the side
 *     panel, ⌘K, a notification) keeps what it showed as a tab when that was
 *     a SESSION, and replaces it when it was a screen (Доска, Файлы, the
 *     composer) — screens behave like VS Code's preview tabs, or every folder
 *     opened in Файлы would leave a tab behind;
 *   - a tab clicked, closed or dragged is an edit made here first and then
 *     written to the URL, so `reconcile` finds nothing to change.
 *
 * Background tabs are not mounted: a hidden session would still read its
 * history and hold its stream, for nothing on screen (the same reason the
 * phone's stacked split mounts only its front pane).
 *
 * Kept per browser in localStorage. Losing it is cheap — the URL still says
 * what is on screen; only the background tabs are forgotten.
 */

export type TabGroup = { tabs: PaneRoute[]; active: number };

/** More than this and the oldest background tab of the group is closed. */
export const TAB_MAX = 10;

const KEY = 'cc-tabs:v1';

/** Identity of a tab. A session is itself; a session with no id yet is one
 *  slot (`pending`); the plain composer is one slot, a composer the strip's «+»
 *  opened is its own (`n`); any other screen is its address, so the same screen
 *  at another place (another folder) is another key. Same slots as the split's
 *  `paneSlot`. */
export function tabKey(p: PaneRoute): string {
  return paneSlot(p) ?? paneAddress(p);
}

function isSessionTab(p: PaneRoute | undefined): boolean {
  return !!p && p.kind === 'session' && !!p.sessionId;
}

/** The panes a route puts on screen, one per group. */
export function visiblePanes(route: Route): PaneRoute[] {
  if (route.kind === 'columns') return route.panes;
  const p = asPane(route);
  return p ? [p] : [];
}

function capGroup(g: TabGroup): TabGroup {
  const tabs = g.tabs.slice();
  let active = g.active;
  while (tabs.length > TAB_MAX) {
    const drop = active === 0 ? 1 : 0;
    tabs.splice(drop, 1);
    if (drop < active) active -= 1;
  }
  return { tabs, active };
}

/**
 * The groups for what is now on screen, given the groups for what was.
 *
 * Pure, and idempotent: reconciling a result against its own visible panes
 * returns it unchanged — which is what makes an edit made here first (then
 * written to the URL) a no-op when the route change comes back round.
 *
 * Each visible pane finds its group, in this order:
 *   1. the group whose ACTIVE tab it is (a group that did not change, or moved);
 *   2. the group at the same position, when the number of groups is the same
 *      and that group's active tab is no longer on screen anywhere — the group
 *      was navigated: activate the pane if it is one of its tabs, otherwise add
 *      it after a session or put it in place of a screen;
 *   3. a group that holds it as a background tab;
 *   4. a new group of one.
 * Then no tab may appear twice anywhere: a background copy of something on
 * screen elsewhere is dropped.
 */
export function reconcile(prev: TabGroup[], next: PaneRoute[]): TabGroup[] {
  const nextKeys = next.map(tabKey);
  const visible = new Set(nextKeys);
  const claimed = new Set<number>();
  const assign: (number | undefined)[] = next.map(() => undefined);
  const activeKey = (g: TabGroup) => {
    const t = g.tabs[g.active];
    return t ? tabKey(t) : '';
  };

  next.forEach((_, i) => {
    const g = prev.findIndex((G, gi) => !claimed.has(gi) && activeKey(G) === nextKeys[i]);
    if (g >= 0) {
      claimed.add(g);
      assign[i] = g;
    }
  });
  if (prev.length === next.length) {
    next.forEach((_, i) => {
      if (assign[i] !== undefined || claimed.has(i) || !prev[i]) return;
      if (visible.has(activeKey(prev[i]!))) return;
      claimed.add(i);
      assign[i] = i;
    });
  }
  next.forEach((_, i) => {
    if (assign[i] !== undefined) return;
    const g = prev.findIndex((G, gi) => !claimed.has(gi) && G.tabs.some((t) => tabKey(t) === nextKeys[i]));
    if (g >= 0) {
      claimed.add(g);
      assign[i] = g;
    }
  });

  const out: TabGroup[] = next.map((pane, i) => {
    const gi = assign[i];
    const src = gi === undefined ? undefined : prev[gi];
    if (!src) return { tabs: [pane], active: 0 };
    const tabs = src.tabs.slice();
    const at = tabs.findIndex((t) => tabKey(t) === nextKeys[i]);
    if (at >= 0) {
      tabs[at] = pane;
      return { tabs, active: at };
    }
    const cur = tabs[src.active];
    if (isSessionTab(cur)) {
      tabs.splice(src.active + 1, 0, pane);
      return { tabs, active: src.active + 1 };
    }
    tabs[src.active] = pane;
    return { tabs, active: src.active };
  });

  // One tab per thing: nothing on screen in one group lingers in another, and
  // no group holds the same thing twice. The active tab always stays.
  return out.map((g) => {
    const activeTab = g.tabs[g.active]!;
    const seen = new Set<string>([tabKey(activeTab)]);
    const tabs: PaneRoute[] = [];
    g.tabs.forEach((t, j) => {
      if (j === g.active) {
        tabs.push(t);
        return;
      }
      const k = tabKey(t);
      if (seen.has(k) || visible.has(k)) return;
      seen.add(k);
      tabs.push(t);
    });
    return capGroup({ tabs, active: tabs.indexOf(activeTab) });
  });
}

// ---- the store ----

let groups: TabGroup[] = [];
const subs = new Set<() => void>();

function emit() {
  for (const fn of subs) fn();
}

function save() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(groups.map((g) => ({ tabs: g.tabs.map(paneAddress), active: g.active }))),
    );
  } catch {
    // storage unavailable — the tabs still hold for this page
  }
}

function load(): TabGroup[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown;
    if (!Array.isArray(raw)) return [];
    const out: TabGroup[] = [];
    for (const g of raw as { tabs?: unknown; active?: unknown }[]) {
      if (!g || !Array.isArray(g.tabs)) continue;
      const tabs: PaneRoute[] = [];
      for (const addr of g.tabs) {
        if (typeof addr !== 'string' || !addr.startsWith('/w')) continue;
        const q = addr.indexOf('?');
        const p = asPane(parseRoute(q < 0 ? addr : addr.slice(0, q), q < 0 ? '' : addr.slice(q)));
        if (p) tabs.push(p);
      }
      if (!tabs.length) continue;
      const active = typeof g.active === 'number' && g.active >= 0 && g.active < tabs.length ? g.active : 0;
      out.push({ tabs, active });
    }
    return out;
  } catch {
    return [];
  }
}

function set(next: TabGroup[], persist = true) {
  groups = next;
  if (persist) save();
  emit();
}

/** Tabs exist only in the VS Code theme. Read from the document rather than
 *  passed in: the theme is applied to <html> before React runs (index.html),
 *  and the store has to be right from its first read. */
export function tabsOn(): boolean {
  return DOM && document.documentElement.dataset.theme === 'vscode';
}

/** Off: one tab per pane, nothing behind it. The saved tabs are left alone, so
 *  switching back to the VS Code theme brings them back. */
function singles(panes: PaneRoute[]): TabGroup[] {
  return panes.map((p) => ({ tabs: [p], active: 0 }));
}

function currentRoute(): Route {
  return parseRoute(location.pathname, location.search);
}

const shape = (gs: TabGroup[]) => JSON.stringify(gs.map((g) => [g.active, g.tabs.map(paneAddress)]));

function sync() {
  const visible = visiblePanes(currentRoute());
  if (!tabsOn()) {
    const next = singles(visible);
    if (shape(next) !== shape(groups)) set(next, false);
    return;
  }
  const next = reconcile(groups, visible);
  if (shape(next) !== shape(groups)) set(next);
}

const DOM = typeof window !== 'undefined' && typeof location !== 'undefined' && typeof document !== 'undefined';
let wasOn = false;
if (DOM) {
  wasOn = tabsOn();
  groups = wasOn ? reconcile(load(), visiblePanes(currentRoute())) : singles(visiblePanes(currentRoute()));
  // The theme changes under a running page (Настройки → Вид). Turning tabs on
  // picks the saved ones back up; turning them off drops to one per pane.
  new MutationObserver(() => {
    const on = tabsOn();
    if (on === wasOn) return;
    wasOn = on;
    if (on) groups = load();
    sync();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // Before any component subscribes to the route, so the store is already
  // current when React renders the new route.
  subscribeRoute(sync);
  setTabLocator((to) => {
    if (!tabsOn()) return null;
    const p = asPane(to);
    if (!p || !isSessionTab(p)) return null;
    const k = tabKey(p);
    const g = groups.findIndex((G) => G.tabs.some((t, j) => j !== G.active && tabKey(t) === k));
    return g >= 0 ? g : null;
  });
}

export function getTabGroups(): TabGroup[] {
  return groups;
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** The tab groups, one per pane on screen, in order. */
export function useTabGroups(): TabGroup[] {
  return useSyncExternalStore(subscribe, getTabGroups, getTabGroups);
}

// ---- edits ----
// Each builds the next groups, stores them, and writes what is on screen to the
// URL. Rearranging tabs is not travel, so the URL is replaced — except picking
// another tab of a single screen, which is the same as picking it in the side
// panel and gets its own Back step.

function commit(next: TabGroup[], focus: number, opts: { push?: boolean } = {}) {
  const clean = next.filter((g) => g.tabs.length > 0);
  set(clean);
  const visible = clean.map((g) => g.tabs[g.active]!).filter(Boolean);
  setSplitFocus(Math.max(0, Math.min(focus, visible.length - 1)));
  navigate(splitRoute(visible), opts.push ? { whole: true } : { replace: true, whole: true });
}

function cloneGroups(): TabGroup[] {
  return groups.map((g) => ({ tabs: g.tabs.slice(), active: g.active }));
}

/** Show tab `index` of group `g`. */
export function activateTab(g: number, index: number) {
  const next = cloneGroups();
  const G = next[g];
  if (!G || !G.tabs[index]) return;
  if (G.active === index) {
    setSplitFocus(g);
    return;
  }
  G.active = index;
  commit(next, g, { push: next.length === 1 });
}

/** Close tab `index` of group `g`. The last tab of a group closes the group;
 *  the last tab of the last group leaves the landing. */
export function closeTab(g: number, index: number) {
  const next = cloneGroups();
  const G = next[g];
  if (!G || !G.tabs[index]) return;
  if (index !== G.active) {
    G.tabs.splice(index, 1);
    if (index < G.active) G.active -= 1;
    set(next);
    return;
  }
  G.tabs.splice(index, 1);
  G.active = Math.max(0, Math.min(index - 1, G.tabs.length - 1));
  if (G.tabs.length === 0) {
    next.splice(g, 1);
    const focus = getSplitFocus();
    commit(next, g === focus ? Math.max(0, g - 1) : focus > g ? focus - 1 : focus);
    return;
  }
  commit(next, g);
}

/**
 * The strip's «+»: a new tab right after the active one in group `g`, shown
 * (VS Code's «new editor»). `tab` is normally a composer aimed at the active
 * tab's project, with an `n` of its own — so every press is one more tab
 * (30.09.2026; before, every composer was one slot, and a second «+» only moved
 * the first). A tab that IS already somewhere (same key) is taken out first and
 * opens here.
 */
export function openTabBeside(g: number, tab: PaneRoute) {
  const next = cloneGroups();
  const k = tabKey(tab);
  let target = g;
  // The group we were asked to add to may vanish here, if its only tab was
  // that composer: then the new tab starts a group in its place.
  let targetGone = false;
  for (let i = next.length - 1; i >= 0; i--) {
    // A session still starting (`pending`) goes too, as it did when it shared
    // the composer's slot: only the visible placeholder gets its real id, so
    // one left behind as a background tab would lead nowhere. The session
    // keeps starting and shows up in the list.
    const at = next[i]!.tabs.findIndex((t) => tabKey(t) === k || tabKey(t) === 'pending');
    if (at < 0) continue;
    const r = takeOut(next, i, at);
    if (!r?.dropped) continue;
    if (i === target) targetGone = true;
    else if (i < target) target -= 1;
  }
  if (targetGone) {
    next.splice(target, 0, { tabs: [tab], active: 0 });
  } else {
    const G = next[target];
    if (!G) return;
    G.tabs.splice(G.active + 1, 0, tab);
    G.active += 1;
    next[target] = capGroup(G);
  }
  commit(next, target, { push: next.length === 1 });
}

/** Take a tab out of its group; returns it, and the groups with the empty
 *  source dropped, plus how target indices shift because of that drop. */
function takeOut(next: TabGroup[], g: number, index: number): { tab: PaneRoute; dropped: boolean } | null {
  const G = next[g];
  const tab = G?.tabs[index];
  if (!G || !tab) return null;
  G.tabs.splice(index, 1);
  if (index < G.active || (index === G.active && G.active > 0 && G.active >= G.tabs.length)) G.active -= 1;
  else if (index === G.active) G.active = Math.max(0, Math.min(G.active, G.tabs.length - 1));
  if (G.tabs.length === 0) {
    next.splice(g, 1);
    return { tab, dropped: true };
  }
  return { tab, dropped: false };
}

/** Where a dragged thing comes from: a tab of the split, or a session row from
 *  the side panel (which may already have a tab somewhere). */
export type DragSource = { kind: 'tab'; group: number; index: number } | { kind: 'session'; machineId: string; sessionId: string };

function resolveSource(next: TabGroup[], src: DragSource): { tab: PaneRoute; from?: { group: number; index: number } } {
  if (src.kind === 'tab') {
    const tab = next[src.group]?.tabs[src.index];
    return tab ? { tab, from: { group: src.group, index: src.index } } : { tab: { kind: 'new' } };
  }
  const tab: PaneRoute = { kind: 'session', machineId: src.machineId, sessionId: src.sessionId };
  const k = tabKey(tab);
  for (let g = 0; g < next.length; g++) {
    const index = next[g]!.tabs.findIndex((t) => tabKey(t) === k);
    if (index >= 0) return { tab, from: { group: g, index } };
  }
  return { tab };
}

/** Drop into group `g` at tab position `at` (end when absent). */
export function dropIntoGroup(src: DragSource, g: number, at?: number) {
  const next = cloneGroups();
  const { tab, from } = resolveSource(next, src);
  if (src.kind === 'tab' && !from) return;
  let target = g;
  let pos = at ?? next[g]?.tabs.length ?? 0;
  if (from) {
    if (from.group === g) {
      // A reorder inside one strip: nothing on screen changes, so no URL.
      const G = next[g]!;
      const activeTab = G.tabs[G.active]!;
      G.tabs.splice(from.index, 1);
      if (from.index < pos) pos -= 1;
      G.tabs.splice(Math.max(0, Math.min(pos, G.tabs.length)), 0, tab);
      // A session row dropped here asks to SEE that session; a tab dragged
      // along its own strip only asks to move.
      if (src.kind === 'session') {
        G.active = G.tabs.indexOf(tab);
        commit(next, g);
        return;
      }
      G.active = Math.max(0, G.tabs.indexOf(activeTab));
      set(next);
      return;
    }
    const r = takeOut(next, from.group, from.index);
    if (!r) return;
    if (r.dropped && from.group < target) target -= 1;
  }
  const G = next[target];
  if (!G) return;
  pos = Math.max(0, Math.min(pos, G.tabs.length));
  G.tabs.splice(pos, 0, tab);
  G.active = pos;
  next[target] = capGroup(G);
  commit(next, target);
}

/** Drop onto a group's left or right edge: a new group beside it, holding the
 *  dragged tab. A full split takes the tab into the group instead. */
export function dropBeside(src: DragSource, g: number, side: 'left' | 'right') {
  const next = cloneGroups();
  const { tab, from } = resolveSource(next, src);
  if (src.kind === 'tab' && !from) return;
  // Dragging a group's only tab beside itself changes nothing.
  if (from && from.group === g && next[g]!.tabs.length === 1) return;
  const willDrop = !!from && next[from.group]!.tabs.length === 1;
  const groupsAfter = next.length + 1 - (willDrop ? 1 : 0);
  if (groupsAfter > COL_MAX) {
    dropIntoGroup(src, g);
    return;
  }
  let target = side === 'left' ? g : g + 1;
  if (from) {
    const r = takeOut(next, from.group, from.index);
    if (!r) return;
    if (r.dropped && from.group < target) target -= 1;
  }
  next.splice(target, 0, { tabs: [tab], active: 0 });
  commit(next, target);
}

// ---- drag state ----
// Set while a tab or a session row is being dragged, so the drop zones over
// the panes appear only for OUR drags — never for a file dragged in from the
// desktop, which the composer takes itself.

export const TAB_MIME = 'application/x-cc-tab';

let dragging: DragSource | null = null;
const dragSubs = new Set<() => void>();
export function setDragging(src: DragSource | null) {
  dragging = src;
  for (const fn of dragSubs) fn();
}
// A drag whose source was removed mid-flight never gets its dragend, and the
// drop zones would then sit over every pane swallowing clicks. No mousemove
// arrives during a native drag, so the first one after it clears the state.
if (typeof window !== 'undefined') {
  window.addEventListener(
    'mousemove',
    () => {
      if (dragging) setDragging(null);
    },
    true,
  );
}
export function getDragging(): DragSource | null {
  return dragging;
}
export function useDragging(): DragSource | null {
  return useSyncExternalStore(
    (fn) => {
      dragSubs.add(fn);
      return () => {
        dragSubs.delete(fn);
      };
    },
    getDragging,
    getDragging,
  );
}
