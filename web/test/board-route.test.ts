import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoardSince, parseRoute, pathFor, type Route } from '../src/router.js';
import { boardQuery } from '../src/components/board/useBoard.js';
import { DESTINATIONS } from '../src/shell/navModel.js';

const route = (path: string): Route => {
  const i = path.indexOf('?');
  return i === -1 ? parseRoute(path, '') : parseRoute(path.slice(0, i), path.slice(i));
};

test('the board is an address, and a filtered board is a link', () => {
  assert.deepEqual(route('/w/board'), { kind: 'board' });
  const url = '/w/board?owner=u1&project=platform&since=30&card=crd_1&col=testing';
  const r = route(url);
  assert.deepEqual(r, { kind: 'board', owner: 'u1', project: 'platform', since: 30, card: 'crd_1', col: 'testing' });
  assert.equal(pathFor(r), url);
});

test('the default period is never written and junk degrades to it', () => {
  assert.equal(parseBoardSince('14'), undefined);
  assert.equal(parseBoardSince('7'), 7);
  assert.equal(parseBoardSince('5'), undefined);
  assert.equal(parseBoardSince(null), undefined);
  assert.deepEqual(route('/w/board?since=14&col=nope'), { kind: 'board' });
  assert.equal(pathFor({ kind: 'board', since: 7 }), '/w/board?since=7');
});

test('the board survives as a pane of the split', () => {
  const back = route(pathFor({ kind: 'columns', panes: [{ kind: 'session', machineId: 'stage', sessionId: 'a' }, { kind: 'board', owner: 'u1' }] }));
  assert.equal(back.kind, 'columns');
  if (back.kind === 'columns') assert.deepEqual(back.panes[1], { kind: 'board', owner: 'u1' });
});

test('the hub query carries only what filters — never the default period, never the drawer', () => {
  assert.equal(boardQuery({ kind: 'board' }), '');
  assert.equal(boardQuery({ kind: 'board', card: 'crd_1', col: 'done' }), '');
  assert.equal(boardQuery({ kind: 'board', owner: 'u1', project: 'a.test', since: 30 }), '?owner=u1&project=a.test&since=30d');
});

test('«Доска» is a destination, unconditionally', () => {
  const d = DESTINATIONS.find((x) => x.id === 'board');
  assert.ok(d);
  assert.deepEqual(d!.route, { kind: 'board' });
  assert.equal(d!.hasContext, false);
});

test('Настройки is four tabs; Память, Профиль and «Начало» moved', async () => {
  const { SETTINGS_TABS } = await import('../src/shell/navModel.js');
  assert.deepEqual(SETTINGS_TABS.filter((t) => !t.browser).map((t) => t.label), ['Машины', 'Приложения', 'Аккаунт', 'Вид']);
  // The first-run screens are a page of their own, and every old address still lands somewhere.
  assert.deepEqual(route('/w/start'), { kind: 'start' });
  assert.equal(pathFor({ kind: 'start' }), '/w/start');
  assert.deepEqual(route('/w/settings/start'), { kind: 'start' });
  assert.deepEqual(route('/w/settings/memory'), { kind: 'settings', tab: 'overview' });
  assert.deepEqual(route('/w/memory'), { kind: 'settings', tab: 'overview' });
  assert.deepEqual(route('/w/profile'), { kind: 'settings', tab: 'overview' });
  assert.deepEqual(route('/w/settings/apps'), { kind: 'settings', tab: 'apps' });
  assert.deepEqual(route('/w/hardware'), { kind: 'settings', tab: 'hardware' });
});
