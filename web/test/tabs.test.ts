import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_MAX, reconcile, tabKey, type TabGroup } from '../src/tabs.js';
import type { PaneRoute } from '../src/router.js';

/**
 * Editor tabs follow the route: the URL says what is on screen (one pane per
 * group), `reconcile` keeps the background tabs around it. These pin the rules
 * a person feels — a session opened over another keeps the first as a tab, a
 * screen is replaced rather than piled up, nothing is open twice.
 */

const S = (id: string, m = 'm'): PaneRoute => ({ kind: 'session', machineId: m, sessionId: id });
const BOARD: PaneRoute = { kind: 'board' };
const FILES = (p: string): PaneRoute => ({ kind: 'files', machineId: 'm', root: '/srv', p });
const NEW: PaneRoute = { kind: 'new' };
const keys = (gs: TabGroup[]) => gs.map((g) => ({ tabs: g.tabs.map(tabKey), active: g.active }));

test('the first screen is a group of one', () => {
  assert.deepEqual(keys(reconcile([], [S('a')])), [{ tabs: ['s:m::a'], active: 0 }]);
});

test('opening a session over a session keeps the first as a tab', () => {
  const g1 = reconcile([], [S('a')]);
  const g2 = reconcile(g1, [S('b')]);
  assert.deepEqual(keys(g2), [{ tabs: ['s:m::a', 's:m::b'], active: 1 }]);
  // …and back to the first activates its tab rather than adding a third.
  const g3 = reconcile(g2, [S('a')]);
  assert.deepEqual(keys(g3), [{ tabs: ['s:m::a', 's:m::b'], active: 0 }]);
});

test('a new tab goes right after the active one', () => {
  const g = reconcile([{ tabs: [S('a'), S('b'), S('c')], active: 0 }], [S('d')]);
  assert.deepEqual(keys(g)[0]!.tabs, ['s:m::a', 's:m::d', 's:m::b', 's:m::c']);
});

test('a screen is replaced in place, not piled up', () => {
  // Доска, then Файлы, then a folder inside Файлы, then a session: the screen
  // tab is reused each time, and only the session gets a tab of its own.
  let g = reconcile([], [S('a')]);
  g = reconcile(g, [BOARD]);
  assert.deepEqual(keys(g)[0]!.tabs, ['s:m::a', '/w/board']);
  g = reconcile(g, [FILES('x')]);
  g = reconcile(g, [FILES('x/y')]);
  assert.equal(g[0]!.tabs.length, 2);
  g = reconcile(g, [S('b')]);
  assert.deepEqual(keys(g), [{ tabs: ['s:m::a', 's:m::b'], active: 1 }]);
});

test('the composer becoming its session takes the composer tab', () => {
  let g = reconcile([], [S('a')]);
  g = reconcile(g, [NEW]);
  g = reconcile(g, [{ kind: 'session', machineId: 'm', sessionId: '' }]);
  g = reconcile(g, [S('fresh')]);
  assert.deepEqual(keys(g), [{ tabs: ['s:m::a', 's:m::fresh'], active: 1 }]);
});

test('reconcile is idempotent — an edit made first is not undone by the URL', () => {
  const edited: TabGroup[] = [
    { tabs: [S('a'), S('b')], active: 1 },
    { tabs: [S('c')], active: 0 },
  ];
  assert.deepEqual(keys(reconcile(edited, [S('b'), S('c')])), keys(edited));
});

test('groups follow their panes when the split is reordered', () => {
  const prev: TabGroup[] = [
    { tabs: [S('a'), S('x')], active: 0 },
    { tabs: [S('b'), S('y')], active: 0 },
  ];
  assert.deepEqual(keys(reconcile(prev, [S('b'), S('a')])), [
    { tabs: ['s:m::b', 's:m::y'], active: 0 },
    { tabs: ['s:m::a', 's:m::x'], active: 0 },
  ]);
});

test('closing a pane keeps the other groups whole', () => {
  const prev: TabGroup[] = [
    { tabs: [S('a'), S('x')], active: 0 },
    { tabs: [S('b'), S('y')], active: 0 },
  ];
  assert.deepEqual(keys(reconcile(prev, [S('b')])), [{ tabs: ['s:m::b', 's:m::y'], active: 0 }]);
});

test('each group navigates on its own', () => {
  const prev: TabGroup[] = [
    { tabs: [S('a')], active: 0 },
    { tabs: [S('b')], active: 0 },
  ];
  assert.deepEqual(keys(reconcile(prev, [S('a'), S('c')])), [
    { tabs: ['s:m::a'], active: 0 },
    { tabs: ['s:m::b', 's:m::c'], active: 1 },
  ]);
});

test('nothing is open twice: a background copy of an on-screen session goes', () => {
  // `b` is a background tab of the first group and comes on screen in the
  // second — it must not also stay behind in the first.
  const prev: TabGroup[] = [
    { tabs: [S('a'), S('b')], active: 0 },
    { tabs: [S('c')], active: 0 },
  ];
  const g = reconcile(prev, [S('a'), S('b')]);
  assert.deepEqual(keys(g), [
    { tabs: ['s:m::a'], active: 0 },
    { tabs: ['s:m::c', 's:m::b'], active: 1 },
  ]);
});

test('a group never grows past TAB_MAX: the oldest background tab goes', () => {
  let g = reconcile([], [S('0')]);
  for (let i = 1; i <= TAB_MAX + 2; i++) g = reconcile(g, [S(String(i))]);
  assert.equal(g[0]!.tabs.length, TAB_MAX);
  assert.equal(tabKey(g[0]!.tabs[g[0]!.active]!), `s:m::${TAB_MAX + 2}`);
  assert.ok(!g[0]!.tabs.some((t) => tabKey(t) === 's:m::0'));
});

test('a session on the same id on another machine is another tab', () => {
  const g = reconcile(reconcile([], [S('a', 'm1')]), [S('a', 'm2')]);
  assert.equal(g[0]!.tabs.length, 2);
});

test('«+» pressed twice is two composer tabs, not one moved (30.09.2026)', async () => {
  const { makeNewTabRoute } = await import('../src/components/tabInfo.js');
  let i = 0;
  const plus = makeNewTabRoute(() => ({ sessionId: 'a', title: 'a', lastModified: 0, cwd: '/srv/x' }), () => `n${++i}`);
  const first = plus(S('a'));
  const second = plus(first);
  // Both aimed at the project of the session they stood beside.
  assert.deepEqual(first, { kind: 'new', machineId: 'm', cwd: '/srv/x', n: 'n1' });
  assert.deepEqual(second, { kind: 'new', machineId: 'm', cwd: '/srv/x', n: 'n2' });
  assert.notEqual(tabKey(first), tabKey(second));
  // A group holding both keeps both: nothing dedupes them into one.
  const g = reconcile([{ tabs: [S('a'), first, second], active: 2 }], [second]);
  assert.equal(g[0]!.tabs.length, 3);
});

test('a session started from one of several composers leaves the others', () => {
  const A: PaneRoute = { kind: 'new', n: 'a1' };
  let g = reconcile([], [A]);
  g = [{ tabs: [NEW, A], active: 1 }];
  g = reconcile(g, [{ kind: 'session', machineId: 'm', sessionId: '' }]);
  // The plain composer in the background survives the placeholder.
  assert.deepEqual(keys(g), [{ tabs: ['start', 'pending'], active: 1 }]);
});
