import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActiveRunInfo, MachineSnapshot } from '@cc-remote/shared';
import { authorOf, groupByPerson, hasOthersWork, NO_AUTHOR, scopeKeeps, sessionIsMine, sessionOwner, shortName } from '../src/lib.js';
import { canSwitchScope } from '../src/shell/workspace.js';

/**
 * «Мои · Команда · Все» (29.09.2026). The switch came back after «Только мои»
 * had been turned into a rule because a chip left off showed colleagues' work
 * for weeks; each test below pins one of the things that keep that from
 * recurring, or one of the layouts the modes promise.
 */

test('the three scopes: mine hides others, team hides mine, all keeps both', () => {
  assert.equal(scopeKeeps('mine', true), true);
  assert.equal(scopeKeeps('mine', false), false);
  assert.equal(scopeKeeps('team', true), false);
  assert.equal(scopeKeeps('team', false), true);
  assert.equal(scopeKeeps('all', true), true);
  assert.equal(scopeKeeps('all', false), true);
});

const org = (role: 'owner' | 'manager' | 'member') => ({
  platformAdmin: false,
  workspace: { workspaceId: 'w', name: 'T', kind: 'organization' as const, role },
});

test('only the people who run a team get the switch', () => {
  assert.equal(canSwitchScope(org('owner')), true);
  assert.equal(canSwitchScope(org('manager')), true);
  assert.equal(canSwitchScope(org('member')), false);
  // A personal workspace has no team to look at, whatever the role says.
  assert.equal(
    canSwitchScope({ platformAdmin: false, workspace: { workspaceId: 'p', name: 'me', kind: 'personal', role: 'owner' } }),
    false,
  );
  assert.equal(canSwitchScope({ ...org('member'), platformAdmin: true }), true);
  assert.equal(canSwitchScope(null), false);
});

const machine: MachineSnapshot['machine'] = { machineId: 'm1', name: 'Laptop', os: 'linux', agentVersion: '1' };

test('others’ work: an ownerless session on a shared box counts, on my laptop it does not', () => {
  const me = 'u-me';
  const laptop = { machine, owner: { userId: me }, sessions: [{ sessionId: 'a', title: '', lastModified: 1 }] };
  assert.equal(hasOthersWork([laptop], me), false);
  const sandbox = { machine, owner: { userId: me }, shared: true, sessions: [{ sessionId: 'b', title: '', lastModified: 1 }] };
  assert.equal(hasOthersWork([sandbox], me), true);
  const colleague = { machine, owner: { userId: me }, sessions: [{ sessionId: 'c', title: '', lastModified: 1, owner: { userId: 'u-ann' } }] };
  assert.equal(hasOthersWork([colleague], me), true);
});

test('the switch includes runs before inventory arrives, but excludes hidden machines', () => {
  const m = { machine, owner: { userId: 'me' }, sessions: [] };
  const run = { machineId: machine.machineId, sessionId: 'new', ownerUserId: 'ann' } as ActiveRunInfo;
  assert.equal(hasOthersWork([m], 'me', [run]), true);
  assert.equal(hasOthersWork([m], 'me', [{ ...run, ownerUserId: 'me' }]), false);
  assert.equal(hasOthersWork([m], 'me', [{ ...run, machineId: 'hidden' }]), false);
});

test('inventory and synthetic rows agree on ownership while the snapshot catches up', () => {
  const run = { machineId: machine.machineId, sessionId: 'new', ownerUserId: 'me', ownerName: 'Я' } as ActiveRunInfo;
  const session = { sessionId: 'new', title: '', lastModified: 1 };
  const m = { machine, shared: true, owner: { userId: 'boss' }, sessions: [session] };
  const owner = sessionOwner(session, run);
  assert.deepEqual(owner, { userId: 'me', fullName: 'Я' });
  assert.equal(sessionIsMine({ owner }, m, 'me'), true);
  assert.equal(hasOthersWork([m], 'me', [run]), false);
  assert.equal(scopeKeeps('team', sessionIsMine({ owner }, m, 'me')), false);
  const recorded = { userId: 'ann', fullName: 'Анна' };
  assert.deepEqual(sessionOwner({ owner: recorded }, run), recorded);
  assert.equal(hasOthersWork([{ ...m, sessions: [{ ...session, owner: recorded }] }], 'me', [run]), true);
  assert.equal(sessionOwner({}, undefined), undefined);
});

type R = { live: boolean; t: number; session: { owner?: { userId: string; fullName?: string }; project?: string } };
const order = (a: R, b: R) => Number(b.live) - Number(a.live) || b.t - a.t;
const row = (who: string | undefined, project: string | undefined, t: number, live = false): R => ({
  live,
  t,
  session: { owner: who ? { userId: who, fullName: who } : undefined, project },
});

test('«Команда» groups by person, then project; whoever has something live leads', () => {
  const people = groupByPerson(
    [
      row('ann', 'crm', 50),
      row('oleg', 'site', 90),
      row('ann', 'platform', 10, true),
      row('ann', 'crm', 40),
      row(undefined, 'crm', 100, true),
    ],
    order,
    (r) => r.session.owner?.userId ?? NO_AUTHOR,
  );
  // Ann has a live session, so she leads Oleg despite his fresher one; the
  // ownerless card goes last even though it is live and newest — it is not a
  // person.
  assert.deepEqual(people.map((p) => p.key), ['ann', 'oleg', NO_AUTHOR]);
  const ann = people[0];
  // Her projects in the order of their head rows: the live one first.
  assert.deepEqual(ann.projects.map(([p]) => p), ['platform', 'crm']);
  assert.deepEqual(ann.projects[1][1].map((r) => r.t), [50, 40]);
});

test('the author: the recorded owner, else a colleague\u2019s machine, never me on my own box', () => {
  const me = 'u-me';
  const mine = { owner: { userId: me, fullName: 'Владелец' } };
  const annsLaptop = { owner: { userId: 'u-ann', fullName: 'Анна Смирнова' } };
  assert.equal(authorOf({ owner: { userId: 'u-oleg', fullName: 'Олег' } }, mine, me).name, 'Олег');
  // A terminal on a colleague's own laptop is that colleague's.
  assert.deepEqual(authorOf({}, annsLaptop, me), { key: 'u-ann', name: 'Анна Смирнова', userId: 'u-ann' });
  // A terminal on MY shared box is in «someone else's work» because it is not
  // mine — so it must not come back labelled with my name.
  assert.equal(authorOf({}, mine, me).key, NO_AUTHOR);
  // …and on a colleague's SHARED box the owner is a guess for anyone looking:
  // a manager viewing Owner's devbox must not see the team's terminals filed
  // under «Владелец».
  const annsSharedBox = { owner: { userId: 'u-ann', fullName: 'Анна' }, shared: true };
  assert.equal(authorOf({}, annsSharedBox, me).key, NO_AUTHOR);
  assert.equal(authorOf({}, { ...annsLaptop, kind: 'sandbox' as const }, me).key, NO_AUTHOR);
  assert.equal(authorOf({}, undefined, me).name, 'Без автора');
});

test('a row\u2019s small print: first name, but the product\u2019s own labels whole', () => {
  assert.equal(shortName('Анна Смирнова'), 'Анна');
  assert.equal(shortName('ann@a.test'), 'ann');
  assert.equal(shortName('Без автора'), 'без автора');
  assert.equal(shortName('Участник 3f9a01'), 'Участник 3f9a01');
});

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
function sources(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test('the scope is never persisted — a reload starts at «Мои»', () => {
  // Code only: the file's own comment explains why it names no storage.
  const store = readFileSync(join(SRC, 'components/MineOnly.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(store, /localStorage|sessionStorage|indexedDB/);
});

test('notifications, the bell and attention counts do not read the scope', () => {
  // Switching to «Команда» must not make a colleague's turn ring the owner's
  // bell. The scope store is read by the lists only.
  const readers = sources()
    .filter((p) => /useSessionScope|useMineOnly/.test(readFileSync(p, 'utf8')))
    .map((p) => p.slice(SRC.length).replaceAll('\\', '/'))
    .sort();
  assert.deepEqual(readers, [
    'CommandPalette.tsx',
    'components/MineOnly.tsx',
    'components/ProjectList.tsx',
    'components/projects/ProjectDetail.tsx',
    'components/projects/ProjectSessions.tsx',
    'components/projects/Projects.tsx',
    'shell/ScopeSwitch.tsx',
  ]);
});
