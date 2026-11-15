import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COL_MAX, intoPane, newChatRoute, parseRoute, pathFor, splitRoute, type PaneRoute, type Route } from '../src/router.js';

/** `parseRoute` takes the pathname and the search separately, the way the
 *  browser hands them over; the tests below speak in whole URLs. */
const route = (path: string): Route => {
  const i = path.indexOf('?');
  return i === -1 ? parseRoute(path, '') : parseRoute(path.slice(0, i), path.slice(i));
};
const panesOf = (r: Route): PaneRoute[] => (r.kind === 'columns' ? r.panes : []);

/**
 * The split is a division of the screen: each pane is any screen but the split
 * itself, and the set is the URL. These pin the address format — old links must
 * keep opening — and the rule that routes a navigation into a pane.
 */

test('a split of sessions keeps the address it has always had', () => {
  // Links in chat histories are `m:s,m:s`; they must parse, and a split of only
  // sessions must print back to exactly that.
  const url = '/w/sessions/columns?s=stage:a-1,mac-mini:b-2';
  const r = route(url);
  assert.deepEqual(panesOf(r), [
    { kind: 'session', machineId: 'stage', sessionId: 'a-1' },
    { kind: 'session', machineId: 'mac-mini', sessionId: 'b-2' },
  ]);
  assert.equal(pathFor(r), url);
});

test('any screen can be a pane, and survives the round trip', () => {
  const panes: PaneRoute[] = [
    { kind: 'session', machineId: 'stage', sessionId: 'a-1' },
    { kind: 'files', machineId: 'stage', root: '/srv/main-source', p: 'web/src', f: 'App.tsx' },
    { kind: 'team', tab: 'people' },
    { kind: 'new', machineId: 'stage', cwd: '/srv/x,y?z&w' },
  ];
  const back = route(pathFor({ kind: 'columns', panes }));
  assert.deepEqual(panesOf(back), panes);
});

test('the cap and the dedupe: one pane per session, one composer', () => {
  const r = route('/w/sessions/columns?s=m:1,m:1,%2Fw%2Fnew,%2Fw%2Fnew,m:2,m:3,m:4');
  const panes = panesOf(r);
  assert.equal(panes.length, COL_MAX);
  assert.deepEqual(panes.slice(0, 2), [
    { kind: 'session', machineId: 'm', sessionId: '1' },
    { kind: 'new' },
  ]);
});

test('the old «new chat inside a split» link becomes the split with a composer', () => {
  const r = route('/w/new?cols=stage:a-1,mac-mini:b-2');
  assert.deepEqual(panesOf(r), [
    { kind: 'session', machineId: 'stage', sessionId: 'a-1' },
    { kind: 'session', machineId: 'mac-mini', sessionId: 'b-2' },
    { kind: 'new' },
  ]);
  assert.deepEqual(route('/w/new'), { kind: 'new' });
});

test('a split of one is that screen, and of none the list', () => {
  assert.deepEqual(splitRoute([{ kind: 'files' }]), { kind: 'files' });
  assert.deepEqual(splitRoute([]), { kind: 'sessions' });
});

const two: PaneRoute[] = [
  { kind: 'session', machineId: 'm', sessionId: '1' },
  { kind: 'session', machineId: 'm', sessionId: '2' },
];

test('a navigation lands in the focused pane', () => {
  const r = intoPane(two, 1, { kind: 'files' });
  assert.ok('panes' in r);
  assert.deepEqual(r.panes, [two[0], { kind: 'files' }]);
  assert.equal(r.focus, 1);
});

test('a session already on screen only takes focus — never a second pane of it', () => {
  const r = intoPane(two, 1, { kind: 'session', machineId: 'm', sessionId: '1' });
  assert.deepEqual(r, { focus: 0 });
});

test('a composer goes where the composer already is', () => {
  const panes: PaneRoute[] = [{ kind: 'new' }, two[1] as PaneRoute];
  const r = intoPane(panes, 1, { kind: 'sessions' });
  assert.ok('panes' in r);
  assert.equal(r.focus, 0);
  // …and the session started from it takes the same slot, as its placeholder.
  const started = intoPane(panes, 1, { kind: 'session', machineId: 'm', sessionId: '' });
  assert.ok('panes' in started);
  assert.deepEqual(started.panes[0], { kind: 'session', machineId: 'm', sessionId: '' });
});

test('a comma inside a pane address does not split the pane', () => {
  // `p` is written with its slashes raw on purpose, so a folder named `a,b&c`
  // reaches the split with its comma — it must stay inside its pane. (An `&` in
  // `p` breaks the standalone Files address too; that is Files' own, older issue.)
  const panes: PaneRoute[] = [
    { kind: 'files', machineId: 'stage', root: '/srv', p: 'a,b/d' },
    { kind: 'session', machineId: 'm', sessionId: '1' },
  ];
  assert.deepEqual(panesOf(route(pathFor({ kind: 'columns', panes }))), panes);
});

test('«Новый чат» opens beside the screen, and takes the focused pane only when the split is full', () => {
  const s = (id: string): PaneRoute => ({ kind: 'session', machineId: 'm', sessionId: id });
  // one screen → it plus a composer, focus on the composer
  assert.deepEqual(newChatRoute(s('1'), 0), { route: { kind: 'columns', panes: [s('1'), { kind: 'new' }] }, focus: 1 });
  assert.deepEqual(newChatRoute({ kind: 'files' }, 0), { route: { kind: 'columns', panes: [{ kind: 'files' }, { kind: 'new' }] }, focus: 1 });
  // nothing to go beside → just the composer
  assert.deepEqual(newChatRoute({ kind: 'sessions' }, 0)?.route, { kind: 'new' });
  assert.deepEqual(newChatRoute({ kind: 'new' }, 0)?.route, { kind: 'new' });
  // …and a composer of the strip's «+» is not swapped for the plain one
  const plus: Route = { kind: 'new', machineId: 'm', cwd: '/srv/crm', n: 'a1' };
  assert.deepEqual(newChatRoute(plus, 0)?.route, plus);
  // a split with room → appended
  const three: Route = { kind: 'columns', panes: [s('1'), s('2'), s('3')] };
  assert.deepEqual(newChatRoute(three, 0), { route: { kind: 'columns', panes: [s('1'), s('2'), s('3'), { kind: 'new' }] }, focus: 3 });
  // a composer already there → focus it, nothing moves
  const withNew: Route = { kind: 'columns', panes: [s('1'), { kind: 'new' }] };
  assert.deepEqual(newChatRoute(withNew, 0), { route: withNew, focus: 1 });
  // a project's pencil: beside the screen too, pencil at its folder…
  const aim = { machineId: 'm', cwd: '/srv/crm' };
  const pencil: PaneRoute = { kind: 'new', machineId: 'm', cwd: '/srv/crm' };
  assert.deepEqual(newChatRoute(s('1'), 0, aim), { route: { kind: 'columns', panes: [s('1'), pencil] }, focus: 1 });
  assert.deepEqual(newChatRoute({ kind: 'sessions' }, 0, aim)?.route, pencil);
  // …and it re-aims the composer already there instead of adding a second
  assert.deepEqual(newChatRoute(withNew, 0, aim), { route: { kind: 'columns', panes: [s('1'), pencil] }, focus: 1 });
  assert.deepEqual(newChatRoute({ kind: 'new' }, 0, aim)?.route, pencil);
  // a numbered composer (the strip's «+») keeps its number — its draft is under it
  assert.deepEqual(newChatRoute({ kind: 'new', n: 'a1' }, 0, aim)?.route, { ...pencil, n: 'a1' });
  const numbered: Route = { kind: 'columns', panes: [s('1'), { kind: 'new', n: 'a1' }] };
  assert.deepEqual(newChatRoute(numbered, 0, aim)?.route, { kind: 'columns', panes: [s('1'), { ...pencil, n: 'a1' }] });
  // a project page is a screen (its session list), not a composer → appended
  const proj: PaneRoute = { kind: 'project', project: 'crm' };
  const withProject: Route = { kind: 'columns', panes: [s('1'), proj] };
  assert.deepEqual(newChatRoute(withProject, 0), { route: { kind: 'columns', panes: [s('1'), proj, { kind: 'new' }] }, focus: 2 });
  assert.deepEqual(newChatRoute(proj, 0), { route: { kind: 'columns', panes: [proj, { kind: 'new' }] }, focus: 1 });
  // an aimed composer keeps its aim
  const aimed: Route = { kind: 'columns', panes: [s('1'), { kind: 'new', machineId: 'm', cwd: '/srv/crm' }] };
  assert.deepEqual(newChatRoute(aimed, 0), { route: aimed, focus: 1 });
  // a session still starting holds the composer slot → the composer takes it
  const starting: Route = { kind: 'columns', panes: [s('1'), { kind: 'session', machineId: 'm', sessionId: '' }] };
  assert.deepEqual(newChatRoute(starting, 0), { route: { kind: 'columns', panes: [s('1'), { kind: 'new' }] }, focus: 1 });
  // full → the caller navigates into the focused pane
  const four: Route = { kind: 'columns', panes: [s('1'), s('2'), s('3'), s('4')] };
  assert.equal(COL_MAX, 4);
  assert.equal(newChatRoute(four, 2), null);
  const r = intoPane((four as { panes: PaneRoute[] }).panes, 2, { kind: 'new' });
  assert.ok('panes' in r);
  assert.deepEqual(r.panes[2], { kind: 'new' });
});

test('several composers: each its own pane and address, the started session takes the one it came from', () => {
  const A: PaneRoute = { kind: 'new', machineId: 'm', cwd: '/srv/x', n: 'a1' };
  // `?n=` survives the address, inside a split too.
  assert.deepEqual(route(pathFor(A)), A);
  const split = route(pathFor({ kind: 'columns', panes: [{ kind: 'new' }, A] }));
  assert.deepEqual(panesOf(split), [{ kind: 'new' }, A]);
  // Sent from the focused «+» composer: its pane, not the plain one's.
  const r = intoPane([{ kind: 'new' }, A], 1, { kind: 'session', machineId: 'm', sessionId: '' });
  assert.ok('panes' in r);
  assert.deepEqual(r.panes, [{ kind: 'new' }, { kind: 'session', machineId: 'm', sessionId: '' }]);
  // …and that split is a valid address: the placeholder is not deduped away.
  assert.equal(panesOf(route(pathFor({ kind: 'columns', panes: r.panes }))).length, 2);
  // A junk `n` is dropped rather than carried into keys and storage.
  assert.deepEqual(route('/w/new?n=%3Cx%3E'), { kind: 'new' });
});
