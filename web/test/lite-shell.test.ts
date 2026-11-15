import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActiveRunInfo, MachineSnapshot, RuntimeStatus, SessionSummary } from '@cc-remote/shared';
import { indexRuns } from '../src/lib.js';
import { pickRuntime, runtimeUsable } from '../src/components/runtimeChips.js';
import { DONE_KEEP, deriveTasks, markSeen, sessionState, type Seen } from '../src/lite/tasks.js';
import { projectSlug, uniqueSlug } from '../src/lite/slug.js';
import { canCreateOn, pickEngine, pickMachine, pinnedToCodex, startBlock } from '../src/lite/pick.js';

/**
 * The light shell (remote.acme.test) decides three things for the person that
 * the full client asks: which pile a task is in, what a new project's folder
 * is called, and which machine and runtime it starts on. All three are pure,
 * and all three are the kind of rule that is wrong quietly.
 */

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const ME = 'u-me';

const session = (sessionId: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId,
  title: `task ${sessionId}`,
  cwd: `/home/me/work/${sessionId}`,
  project: 'proj',
  lastModified: NOW - HOUR,
  ...over,
});

const machine = (id: string, sessions: SessionSummary[], over: Partial<MachineSnapshot> = {}): MachineSnapshot => ({
  machine: { machineId: id, name: id, os: 'linux', agentVersion: '0.1.0' } as MachineSnapshot['machine'],
  owner: { userId: ME },
  canControl: true,
  online: true,
  lastSeen: NOW,
  sessions,
  ...over,
});

const run = (sessionId: string, state: ActiveRunInfo['state'], over: Partial<ActiveRunInfo> = {}): ActiveRunInfo => ({
  runId: `r-${sessionId}`,
  machineId: 'm1',
  sessionId,
  state,
  since: NOW - 5 * MIN,
  ownerUserId: ME,
  ...over,
});

const seenAt = (base: number, at: Record<string, number> = {}): Seen => ({ base, at });

test('a run decides the pile; an editor session speaks through its own status', () => {
  assert.equal(sessionState({}, run('a', 'working')), 'working');
  assert.equal(sessionState({ livePid: 1, liveStatus: 'waiting' }, undefined), 'needs_attention');
  assert.equal(sessionState({ livePid: 1, liveStatus: 'busy' }, undefined), 'working');
  // An editor left open with no status is not known to be doing anything.
  assert.equal(sessionState({ livePid: 1 }, undefined), undefined);
  assert.equal(sessionState({}, undefined), undefined);
});

test('tasks fall into waiting, working and done', () => {
  const m = machine('m1', [session('ask'), session('err'), session('work'), session('fin'), session('old', { lastModified: NOW - 30 * HOUR })]);
  const runs = indexRuns([
    run('ask', 'needs_attention', { pendingKind: 'question', since: NOW - 2 * MIN }),
    run('err', 'error', { since: NOW - 9 * MIN }),
    run('work', 'working', { taskStartedAt: NOW - MIN }),
    run('fin', 'idle', { since: NOW - 3 * MIN, preview: 'готово, проверь' }),
  ]);
  const t = deriveTasks([m], runs, ME, seenAt(NOW - HOUR), NOW);
  // The longest wait leads.
  assert.deepEqual(t.attention.map((x) => [x.sessionId, x.label]), [['err', 'ошибка'], ['ask', 'ждёт ответа']]);
  assert.deepEqual(t.working.map((x) => x.sessionId), ['work']);
  assert.equal(t.working[0]!.at, NOW - MIN);
  // `old` finished more than a day ago and was never ours to announce.
  assert.deepEqual(t.done.map((x) => [x.sessionId, x.unread, x.preview]), [['fin', true, 'готово, проверь']]);
});

test('what finished before the first visit is not news', () => {
  const m = machine('m1', [session('fin')]);
  const runs = indexRuns([run('fin', 'idle', { since: NOW - 3 * MIN })]);
  const t = deriveTasks([m], runs, ME, seenAt(NOW), NOW);
  assert.deepEqual(t.done.map((x) => x.unread), [false]);
});

test('opening a task clears its dot and keeps its place', () => {
  const m = machine('m1', [session('a'), session('b')]);
  const runs = indexRuns([run('a', 'idle', { since: NOW - 3 * MIN }), run('b', 'idle', { since: NOW - 4 * MIN })]);
  let seen = seenAt(NOW - HOUR);
  assert.deepEqual(deriveTasks([m], runs, ME, seen, NOW).done.map((x) => [x.sessionId, x.unread]), [['a', true], ['b', true]]);
  seen = markSeen(seen, 'm1::a', NOW);
  assert.deepEqual(deriveTasks([m], runs, ME, seen, NOW).done.map((x) => [x.sessionId, x.unread]), [['a', false], ['b', true]]);
  // Marking again at the same instant is a no-op the caller can detect.
  assert.equal(markSeen(seen, 'm1::a', NOW), seen);
  // A later answer in a task once opened here is news again, with no run left.
  const later = machine('m1', [session('a', { lastModified: NOW + MIN })]);
  assert.equal(deriveTasks([later], new Map(), ME, seen, NOW + 2 * MIN).done[0]!.unread, true);
});

test('a receipt stamped at the result\'s own time clears the dot under a clock that runs ahead', () => {
  // The hub says the turn ended two minutes into this browser's future.
  const since = NOW + 2 * MIN;
  const m = machine('m1', [session('a')]);
  const runs = indexRuns([run('a', 'idle', { since })]);
  // `Date.now()` alone would leave it unread…
  assert.equal(deriveTasks([m], runs, ME, markSeen(seenAt(NOW - HOUR), 'm1::a', NOW), NOW).done[0]!.unread, true);
  // …so the shell stamps the newest of the three.
  const seen = markSeen(seenAt(NOW - HOUR), 'm1::a', Math.max(NOW, since));
  assert.equal(deriveTasks([m], runs, ME, seen, NOW).done[0]!.unread, false);
});

test("a session typed into in the person's own terminal is never «new»", () => {
  const m = machine('m1', [session('term', { lastModified: NOW - MIN })]);
  const t = deriveTasks([m], new Map(), ME, seenAt(NOW - HOUR), NOW);
  assert.deepEqual(t.done.map((x) => [x.sessionId, x.unread]), [['term', false]]);
});

test('a result of a session started through the product stays news after its run is released', () => {
  // The agent restarted: the idle run is gone, the session is in the inventory
  // with the hub's owner stamp and nothing else to say it was ours.
  const m = machine('m1', [
    session('mine', { owner: { userId: ME }, lastModified: NOW - MIN }),
    session('disk', { lastModified: NOW - MIN }),
  ]);
  const t = deriveTasks([m], new Map(), ME, seenAt(NOW - HOUR), NOW);
  assert.deepEqual(t.done.map((x) => [x.sessionId, x.unread]).sort(), [['disk', false], ['mine', true]]);
});

test('every unread result stays; read ones are a bounded tail of the last day', () => {
  const read = Array.from({ length: DONE_KEEP + 4 }, (_, i) => session(`r${i}`, { lastModified: NOW - (i + 1) * MIN }));
  const stale = session('stale');
  const m = machine('m1', [...read, stale]);
  const runs = indexRuns([run('stale', 'idle', { since: NOW - 40 * HOUR })]);
  const t = deriveTasks([m], runs, ME, seenAt(NOW - 100 * HOUR), NOW);
  assert.equal(t.done.filter((x) => !x.unread).length, DONE_KEEP);
  assert.deepEqual(t.done.filter((x) => x.unread).map((x) => x.sessionId), ['stale']);
  assert.deepEqual(t.done.slice(0, 2).map((x) => x.sessionId), ['r0', 'r1']);
});

test("other people's work, automated runs and a shared box's strays are not mine", () => {
  const mine = machine('m1', [
    session('own'),
    session('theirs', { owner: { userId: 'u-other' } }),
    session('cron', { entrypoint: 'sdk-cli' }),
  ]);
  const shared = machine('m2', [session('stray')], { shared: true });
  const t = deriveTasks([mine, shared], new Map(), ME, seenAt(NOW - 100 * HOUR), NOW);
  assert.deepEqual(t.done.map((x) => x.sessionId), ['own']);
});

test('a task just started is listed before its transcript reaches the inventory', () => {
  const runs = indexRuns([
    run('fresh', 'working', { title: 'Лендинг школы', project: 'lending', machineName: 'mac' }),
    run('not-mine', 'working', { ownerUserId: 'u-other' }),
    run('', 'working'),
  ]);
  const t = deriveTasks([machine('m1', [])], runs, ME, seenAt(NOW), NOW);
  assert.deepEqual(t.working.map((x) => [x.sessionId, x.title, x.machineName]), [['fresh', 'Лендинг школы', 'mac']]);
});

test('a sentence becomes a folder name the agent accepts', () => {
  const day = new Date(2026, 9, 6);
  assert.equal(projectSlug('Сделай лендинг для школы танцев', day), 'lending-shkoly-tantsev');
  assert.equal(projectSlug('Build a CRM for my dental clinic, please', day), 'crm-dental-clinic');
  assert.equal(projectSlug('Нужен телеграм-бот: напоминания о днях рождения', day), 'telegram-bot-napominaniya');
  assert.equal(projectSlug('Щи, ёж и жюри', day), 'schi-ezh-zhyuri');
  // Nothing nameable: only glue words, another script, or nothing at all.
  assert.equal(projectSlug('сделай мне это', day), 'project-261006');
  assert.equal(projectSlug('作ってください 🙏', day), 'project-261006');
  assert.equal(projectSlug('', day), 'project-261006');
  // Cut on a word; a single over-long word is cut rather than dropped.
  assert.equal(projectSlug('информационно-аналитическая система мониторинга', day), 'informatsionno-analiticheskaya');
  assert.equal(projectSlug('x'.repeat(50), day), 'x'.repeat(32));
  for (const p of ['Сделай лендинг', '9 жизней кота', '--- !!! ...', 'a']) {
    assert.match(projectSlug(p, day), /^[a-z0-9][a-z0-9._-]{0,63}$/, p);
  }
});

test('a taken name gets a number, and nine of a kind is a question', () => {
  assert.equal(uniqueSlug('shop', []), 'shop');
  assert.equal(uniqueSlug('shop', ['Shop', 'other']), 'shop-2');
  assert.equal(uniqueSlug('shop', ['shop', 'shop-2', 'shop-3']), 'shop-4');
  assert.equal(uniqueSlug('shop', ['shop', ...Array.from({ length: 8 }, (_, i) => `shop-${i + 2}`)]), null);
});

const claude = (over: Record<string, unknown> = {}) => ({ present: true, auth: 'oauth', checkedAt: 0, ...over });
const codex = (over: Record<string, unknown> = {}) => ({ present: true, auth: 'chatgpt', provider: 'own', checkedAt: 0, ...over });
const rt = (c?: Record<string, unknown>, x?: Record<string, unknown>) =>
  ({ ...(c ? { claude: c } : {}), ...(x ? { codex: x } : {}) }) as RuntimeStatus;

test('a runtime is usable unless the machine has said otherwise', () => {
  assert.equal(runtimeUsable(undefined, 'claude'), true);
  assert.equal(runtimeUsable(rt(), 'codex'), true);
  assert.equal(runtimeUsable(rt(claude()), 'claude'), true);
  // A token with a month left is a warning chip and still runs.
  assert.equal(runtimeUsable(rt(claude({ auth: 'token', error: 'token_expiring' })), 'claude'), true);
  for (const error of ['disabled', 'sdk_binary_missing', 'logged_out', 'token_expired', 'token_rejected']) {
    assert.equal(runtimeUsable(rt(claude({ error })), 'claude'), false, error);
  }
  assert.equal(runtimeUsable(rt(claude({ auth: 'none' })), 'claude'), false);
  assert.equal(runtimeUsable(rt(undefined, codex({ auth: 'none' })), 'codex'), false);
  assert.equal(runtimeUsable(rt(undefined, codex({ present: false })), 'codex'), false);
  // A gateway machine has no login of its own to be missing.
  assert.equal(runtimeUsable(rt(undefined, codex({ auth: 'none', provider: 'gateway' })), 'codex'), true);
});

test('the runtime follows the login, and keeps the preference when it can', () => {
  assert.equal(pickRuntime(rt(claude(), codex()), 'claude'), 'claude');
  assert.equal(pickRuntime(rt(claude(), codex()), 'codex'), 'codex');
  assert.equal(pickRuntime(rt(claude({ error: 'logged_out' }), codex()), 'claude'), 'codex');
  assert.equal(pickRuntime(rt(claude(), codex({ auth: 'none' })), 'codex'), 'claude');
  // Neither starts: the failure should name what was asked for.
  assert.equal(pickRuntime(rt(claude({ auth: 'none' }), codex({ auth: 'none' })), 'claude'), 'claude');
  assert.equal(pickEngine(rt(claude({ error: 'disabled' }), codex()), { preferred: 'claude', pinned: false }), 'codex');
  // The hub pins a member to Codex on a machine they do not control — and
  // only there: on their own computer a member chooses like anybody else.
  assert.equal(pinnedToCodex({ canControl: false }, true), true);
  assert.equal(pinnedToCodex(undefined, true), true);
  assert.equal(pinnedToCodex({ canControl: true }, true), false);
  assert.equal(pinnedToCodex({ canControl: false }, false), false);
  assert.equal(pickEngine(rt(claude(), codex()), { preferred: 'claude', pinned: true }), 'codex');
  assert.equal(pickEngine(rt(claude(), codex()), { preferred: 'claude', pinned: false }), 'claude');
});

test('a new project goes to a machine that can run it, the own one first', () => {
  const runtimes: Record<string, RuntimeStatus> = {
    dead: rt(claude({ auth: 'none' }), codex({ auth: 'none' })),
    lent: rt(claude()),
    mine: rt(claude()),
    mine2: rt(claude()),
  };
  const runtimesOf = (m: MachineSnapshot) => runtimes[m.machine.machineId];
  const dead = machine('dead', [session('d', { lastModified: NOW })]);
  const lent = machine('lent', [session('l', { lastModified: NOW })], { owner: { userId: 'u-other' } });
  const mine = machine('mine', [session('a', { lastModified: NOW - HOUR })]);
  const mine2 = machine('mine2', [session('b', { lastModified: NOW - 2 * HOUR })]);
  const off = machine('off', [], { online: false });
  const chat = machine('chat', [], { machine: { machineId: 'chat', name: 'chat', os: 'linux', agentVersion: '0', policy: { chatOnly: true, sync: 'all' } } as MachineSnapshot['machine'] });
  const viewOnly = machine('view', [], { canControl: false, canStart: true });
  assert.equal(canCreateOn(off), false);
  assert.equal(canCreateOn(chat), false);
  assert.equal(canCreateOn(viewOnly), false);
  const all = [dead, lent, mine2, mine, off, chat, viewOnly];
  // Worked on last, among my own that can run something.
  assert.equal(pickMachine(all, { viewerId: ME, runtimesOf })?.machine.machineId, 'mine');
  // The remembered pick wins among equals — never over «can it run».
  assert.equal(pickMachine(all, { viewerId: ME, runtimesOf, remembered: 'mine2' })?.machine.machineId, 'mine2');
  assert.equal(pickMachine(all, { viewerId: ME, runtimesOf, remembered: 'dead' })?.machine.machineId, 'mine');
  // Only a machine that cannot run anything: still an answer, so the failure is specific.
  assert.equal(pickMachine([dead, off], { viewerId: ME, runtimesOf })?.machine.machineId, 'dead');
  assert.equal(pickMachine([off, viewOnly], { viewerId: ME, runtimesOf }), undefined);

  assert.equal(startBlock([off], runtimesOf), 'no-machine');
  assert.equal(startBlock([dead, off], runtimesOf), 'no-runtime');
  assert.equal(startBlock([dead, mine], runtimesOf), null);
  // A shared folder on somebody else's machine is somewhere to start.
  assert.equal(startBlock([viewOnly], runtimesOf), null);
});

test('reads from other devices clear the dot here', async () => {
  const { withReads } = await import('../src/lite/tasks.js');
  const seen = { base: 10, at: { 'm::a': 500 } };
  assert.equal(withReads(seen, new Map([['m::a', 400]])), seen);
  const merged = withReads(seen, new Map([['m::a', 600], ['m::b', 700]]));
  assert.deepEqual(merged.at, { 'm::a': 600, 'm::b': 700 });
  assert.equal(merged.base, 10);
});
