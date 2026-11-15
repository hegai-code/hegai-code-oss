import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActiveRunInfo } from '@cc-remote/shared';
import {
  alreadyFocused,
  bellStamp,
  dropStamped,
  mergeStamps,
  parseBellSync,
  stampCovers,
  dropReadNotifications,
  mergeReads,
  foldStreamEvent,
  freezeStreamingTail,
  reconcileActivity,
  type TranscriptLine,
  keepUnansweredTail,
  mergeTeamMachines,
} from '../src/central-reducers.js';

test('a freshly named session is not treated as a session switch', () => {
  // The shape right after `session_started`: we hold the run, and the router
  // re-focuses the route it just navigated to. Rebuilding the attachment here
  // unsubscribes our own live run and empties the transcript.
  const justNamed = { runId: 'r1', machineId: 'm1', sessionId: 'minted' };
  assert.equal(alreadyFocused(justNamed, 'm1', 'minted'), true);
  // A genuine switch still rebuilds: other session, other machine, or a
  // dormant view with no run to keep.
  assert.equal(alreadyFocused(justNamed, 'm1', 'other'), false);
  assert.equal(alreadyFocused(justNamed, 'm2', 'minted'), false);
  assert.equal(alreadyFocused({ machineId: 'm1', sessionId: 'minted' }, 'm1', 'minted'), false);
  assert.equal(alreadyFocused(null, 'm1', 'minted'), false);
});

// Live speech is stamped at arrival (every turn shows its own time now), so the
// clock is injected the way `nextId` is — a reducer that reads Date.now itself
// cannot be asserted on.
const T0 = 1_700_000_000_000;
const clock = () => T0;

test('stream folding merges partials, freezes results, and starts a fresh tail', () => {
  let id = 0;
  const nextId = () => ++id;
  let lines: TranscriptLine[] = [];
  lines = foldStreamEvent(lines, { kind: 'partial', text: 'hel' }, nextId, clock);
  lines = foldStreamEvent(lines, { kind: 'partial', text: 'lo' }, nextId, () => T0 + 40_000);
  // The stamp is the moment the turn STARTED — a delta 40s later does not move it.
  assert.deepEqual(lines, [{ id: 1, kind: 'assistant', text: 'hello', streaming: true, ts: T0 }]);

  lines = foldStreamEvent(lines, { kind: 'result' }, nextId, clock);
  assert.equal(lines[0]?.streaming, false);
  lines = foldStreamEvent(lines, { kind: 'partial', text: 'next' }, nextId, clock);
  assert.equal(lines.length, 2);
  assert.equal(lines[1]?.id, 2);
});

/**
 * Two turns can legitimately give the same answer, and short answers repeat
 * constantly — «Готово.», «Да.», «Сделал.». The re-emission guard searched the
 * whole buffer backwards for an identical assistant line, so the SECOND
 * «Готово.» was read as an echo of the first and dropped: that turn finished
 * with nothing on screen. A re-emission is the same TURN speaking twice, so the
 * search stops at the human turn in between.
 */
test('a second turn answering the same words is still an answer', () => {
  let id = 0;
  const nextId = () => ++id;
  let lines: TranscriptLine[] = [];
  lines = foldStreamEvent(lines, { kind: 'assistant', text: 'Готово.' }, nextId, clock);
  // The same turn saying it twice IS an echo — that is what the guard is for.
  lines = foldStreamEvent(lines, { kind: 'assistant', text: 'Готово.' }, nextId, clock);
  assert.equal(lines.length, 1, 'a re-emission inside one turn is still folded away');

  // A person asks for something else, and the answer happens to be the same.
  lines = [...lines, { id: ++id, kind: 'user', text: 'теперь второе' }];
  lines = foldStreamEvent(lines, { kind: 'assistant', text: 'Готово.' }, nextId, clock);
  assert.equal(lines.length, 3, 'the second turn has an answer of its own');
  assert.equal(lines[2]?.kind, 'assistant');
});

test('a Codex turn reaches the transcript: assistant is its only carrier', () => {
  let id = 0;
  const nextId = () => ++id;
  let lines: TranscriptLine[] = [];
  // codex-run.ts emits status/tool_use/assistant/result — never `partial`.
  lines = foldStreamEvent(lines, { kind: 'tool_use', text: '$ npm run build' }, nextId, clock);
  lines = foldStreamEvent(lines, { kind: 'status', text: '→ completed' }, nextId, clock);
  lines = foldStreamEvent(lines, { kind: 'assistant', text: 'Готово, превью на :5173.' }, nextId, clock);
  lines = foldStreamEvent(lines, { kind: 'result', text: 'done' }, nextId, clock);
  assert.deepEqual(lines[2], { id: 3, kind: 'assistant', text: 'Готово, превью на :5173.', ts: T0 });
  // Machinery carries no stamp: only speech is dated in the gutter.
  assert.equal(lines[0]?.ts, undefined);
  assert.equal(lines[1]?.ts, undefined);
});

test('a streamed Claude turn takes the final text without printing twice', () => {
  let id = 0;
  const nextId = () => ++id;
  let lines: TranscriptLine[] = [];
  lines = foldStreamEvent(lines, { kind: 'partial', text: 'hel' }, nextId, clock);
  lines = foldStreamEvent(lines, { kind: 'partial', text: 'lo' }, nextId, clock);
  lines = foldStreamEvent(lines, { kind: 'assistant', text: 'hello' }, nextId, clock);
  assert.deepEqual(lines, [{ id: 1, kind: 'assistant', text: 'hello', streaming: false, ts: T0 }]);
  // A second text block in the same message appends rather than overwriting.
  lines = foldStreamEvent(lines, { kind: 'assistant', text: 'and more' }, nextId);
  assert.equal(lines.length, 2);
  assert.equal(lines[1]?.text, 'and more');
});

test('reconnect freezes only a streaming tail', () => {
  const lines: TranscriptLine[] = [
    { id: 1, kind: 'user', text: 'go' },
    { id: 2, kind: 'assistant', text: 'working', streaming: true },
  ];
  const frozen = freezeStreamingTail(lines);
  assert.equal(frozen[1]?.streaming, false);
  assert.equal(freezeStreamingTail(frozen), frozen, 'stable buffers preserve identity');
});

function run(state: ActiveRunInfo['state'], overrides: Partial<ActiveRunInfo> = {}): ActiveRunInfo {
  return {
    runId: 'r1', machineId: 'm1', sessionId: 's1', state, since: 1, ownerUserId: 'me',
    ...overrides,
  };
}

test('activity reconciliation seeds silently and emits only genuine background transitions', () => {
  let id = 0;
  const seeded = reconcileActivity({
    rawRuns: [run('working')], active: null, attachedRunId: null,
    previousStates: new Map(), seeded: false, notify: true, viewerId: 'me', now: 10, nextId: () => ++id,
  });
  assert.equal(seeded.notifications.length, 0);

  const changed = reconcileActivity({
    rawRuns: [run('needs_attention')], active: null, attachedRunId: null,
    previousStates: seeded.nextStates, seeded: true, notify: true, viewerId: 'me', now: 20, nextId: () => ++id,
  });
  assert.equal(changed.notifications.length, 1);
  assert.equal(changed.notifications[0]?.state, 'needs_attention');

  const unchanged = reconcileActivity({
    rawRuns: [run('needs_attention')], active: null, attachedRunId: null,
    previousStates: changed.nextStates, seeded: true, notify: true, viewerId: 'me', now: 30, nextId: () => ++id,
  });
  assert.equal(unchanged.notifications.length, 0);
});

test('a run that re-appears already waiting does not ring again', () => {
  // A hub restart or an agent reconnect: the run leaves the list and comes
  // back with the state it already had. That is an entrance, not news.
  let id = 0;
  const seeded = reconcileActivity({
    rawRuns: [run('needs_attention')], active: null, attachedRunId: null,
    previousStates: new Map(), seeded: false, notify: true, viewerId: 'me', now: 10, nextId: () => ++id,
  });
  const gone = reconcileActivity({
    rawRuns: [], active: null, attachedRunId: null,
    previousStates: seeded.nextStates, seeded: true, notify: true, viewerId: 'me', now: 20, nextId: () => ++id,
  });
  const back = reconcileActivity({
    rawRuns: [run('needs_attention')], active: null, attachedRunId: null,
    previousStates: gone.nextStates, seeded: true, notify: true, viewerId: 'me', now: 30, nextId: () => ++id,
  });
  assert.equal(back.notifications.length, 0);
});

test('a colleague\'s session never rings: notifications are owner-scoped', () => {
  let id = 0;
  const mine = run('working');
  const theirs = run('working', { runId: 'r2', sessionId: 's2', ownerUserId: 'varya' });
  const seeded = reconcileActivity({
    rawRuns: [mine, theirs], active: null, attachedRunId: null,
    previousStates: new Map(), seeded: false, notify: true, viewerId: 'me', now: 10, nextId: () => ++id,
  });
  const moved = reconcileActivity({
    rawRuns: [run('idle'), run('needs_attention', { runId: 'r2', sessionId: 's2', ownerUserId: 'varya' })],
    active: null, attachedRunId: null,
    previousStates: seeded.nextStates, seeded: true, notify: true, viewerId: 'me', now: 20, nextId: () => ++id,
  });
  assert.deepEqual(moved.notifications.map((n) => n.runId), ['r1'], 'only the viewer\'s own run notifies');
  // The board still tracks every visible run — only the bell is scoped.
  assert.equal(moved.runs.length, 2);
  assert.equal(moved.nextStates.get('r2'), 'needs_attention');
});

test('an unresolved viewer stays silent rather than ringing for the whole fleet', () => {
  let id = 0;
  const seeded = reconcileActivity({
    rawRuns: [run('working')], active: null, attachedRunId: null,
    previousStates: new Map(), seeded: false, notify: true, viewerId: null, now: 10, nextId: () => ++id,
  });
  const moved = reconcileActivity({
    rawRuns: [run('needs_attention')], active: null, attachedRunId: null,
    previousStates: seeded.nextStates, seeded: true, notify: true, viewerId: null, now: 20, nextId: () => ++id,
  });
  assert.equal(moved.notifications.length, 0);
});

test('reconnect re-attaches by durable run id and terminal state recovers dormant focus', () => {
  const active = { runId: 'r1', machineId: 'm1', sessionId: '' };
  const resumed = reconcileActivity({
    rawRuns: [run('working', { sessionId: 'minted' })], active, attachedRunId: null,
    previousStates: new Map(), seeded: false, notify: false, viewerId: 'me', now: 1, nextId: () => 1,
  });
  assert.equal(resumed.subscribeRunId, 'r1');
  assert.deepEqual(resumed.active, { runId: 'r1', machineId: 'm1', sessionId: 'minted' });
  assert.equal(resumed.busy, true);

  const ended = reconcileActivity({
    rawRuns: [], active: resumed.active, attachedRunId: 'r1',
    previousStates: resumed.nextStates, seeded: true, notify: false, viewerId: 'me', now: 2, nextId: () => 2,
  });
  assert.deepEqual(ended.active, { machineId: 'm1', sessionId: 'minted' });
  assert.equal(ended.attachedRunId, null);
  assert.equal(ended.busy, false);
  assert.equal(ended.clearToolRequest, true);
});

test('a view that missed session_started takes the name from activity (20.10.2026)', () => {
  // Attached to its new_session run, but still on the placeholder id.
  const out = reconcileActivity({
    rawRuns: [run('idle', { sessionId: 'minted', since: 0 })],
    active: { runId: 'r1', machineId: 'm1', sessionId: '' },
    attachedRunId: 'r1',
    previousStates: new Map(), seeded: true, notify: false, viewerId: 'me', now: 100_000, nextId: () => 1,
  });
  assert.deepEqual(out.active, { runId: 'r1', machineId: 'm1', sessionId: 'minted' });
  assert.equal(out.activeChanged, true);
  assert.equal(out.subscribeRunId, undefined, 'already attached — no second subscribe');
});

test('a lost run id is replaced by the session\'s live run in the same round (20.10.2026)', () => {
  const out = reconcileActivity({
    rawRuns: [run('idle', { runId: 'r2', sessionId: 's1' })],
    active: { runId: 'gone', machineId: 'm1', sessionId: 's1' },
    attachedRunId: 'gone',
    previousStates: new Map(), seeded: true, notify: false, viewerId: 'me', now: 10, nextId: () => 1,
  });
  assert.deepEqual(out.active, { runId: 'r2', machineId: 'm1', sessionId: 's1' });
  assert.equal(out.subscribeRunId, 'r2');

  // A placeholder with no name never grabs another id-less run.
  const unnamed = reconcileActivity({
    rawRuns: [run('working', { runId: 'r3', sessionId: '' })],
    active: { runId: 'gone', machineId: 'm1', sessionId: '' },
    attachedRunId: 'gone',
    previousStates: new Map(), seeded: true, notify: false, viewerId: 'me', now: 10, nextId: () => 1,
  });
  assert.deepEqual(unnamed.active, { machineId: 'm1', sessionId: '' });
  assert.equal(unnamed.subscribeRunId, undefined);
});

/**
 * The optimistic line has to SURVIVE a reconnect, and nothing asserted that.
 *
 * `ws.onopen` dropped the whole live buffer — right for the agent's gapped
 * output, wrong for the turn you sent two seconds ago: that one is not in the
 * `.jsonl` yet, so it left the screen and came back only after a history
 * round-trip. On a phone, where locking the screen reconnects the socket, that
 * was most sends, and it read as «сообщение не видно, надо подождать».
 */
test('a reconnect keeps the turns you just sent, and nothing else', () => {
  const l = (id: number, kind: TranscriptLine['kind'], text: string): TranscriptLine => ({ id, kind, text });
  const lines: TranscriptLine[] = [
    l(1, 'user', 'первый вопрос'),
    l(2, 'assistant', 'ответ'),
    l(3, 'tool_use', 'Read foo.ts'),
    l(4, 'user', 'а теперь так'),
    l(5, 'user', 'и ещё вот так'),
  ];
  // Only the unanswered tail: the agent's output is re-read from the file.
  assert.deepEqual(
    keepUnansweredTail(lines).map((x) => x.text),
    ['а теперь так', 'и ещё вот так'],
  );
  // Kept lines end up at the HEAD, which is where `dropEchoedUserLine` looks —
  // that is what makes keeping them safe rather than a duplicate waiting to
  // happen.
  const kept = keepUnansweredTail(lines);
  assert.equal(kept[0]?.kind, 'user');
});

test('a reconnect mid-answer keeps nothing — there is nothing unanswered', () => {
  const lines: TranscriptLine[] = [
    { id: 1, kind: 'user', text: 'вопрос' },
    { id: 2, kind: 'assistant', text: 'пишу…', streaming: true },
  ];
  assert.deepEqual(keepUnansweredTail(lines), []);
  assert.deepEqual(keepUnansweredTail([]), []);
});

test('the inbox keeps one entry per session: a retry that fails again is not a second row', async () => {
  const { mergeInbox } = await import('../src/central-reducers.js');
  const item = (id: number, sessionId: string, state: 'error' | 'idle', ts: number) =>
    ({ id, runId: `r${id}`, machineId: 'stage', sessionId, title: sessionId, state, ts });
  let inbox = mergeInbox([], [item(1, 'a', 'error', 1), item(2, 'b', 'error', 2)]);
  assert.equal(inbox.added, 2);
  inbox = mergeInbox(inbox.items, [item(3, 'a', 'error', 3)]);
  assert.equal(inbox.added, 0, 'the badge does not grow for a session already there');
  assert.deepEqual(inbox.items.map((n) => n.id), [3, 2], 'the newest word about a session, on top, once');
  inbox = mergeInbox(inbox.items, [item(4, 'c', 'idle', 4), item(5, 'c', 'error', 5)]);
  assert.deepEqual(inbox.items.map((n) => n.id), [5, 3, 2], 'within one batch the last state wins');
  assert.equal(inbox.added, 1);
});

test('the bell keeps only what still needs you (28.09.2026)', async () => {
  const { pruneInbox } = await import('../src/central-reducers.js');
  type Item = Parameters<typeof pruneInbox>[0][number];
  const entry = (runId: string, state: Item['state'], pendingRequestId?: string): Item => ({
    id: Number(runId.slice(1)),
    runId,
    machineId: 'm',
    sessionId: `s-${runId}`,
    title: runId,
    state,
    ts: 0,
    pendingRequestId,
  });
  const run = (runId: string, state: ActiveRunInfo['state'], pendingRequestId?: string) =>
    ({ runId, machineId: 'm', sessionId: `s-${runId}`, state, pendingRequestId }) as unknown as ActiveRunInfo;
  const nowhere = () => false;

  // A plan approval answered — on this device or any other — leaves the bell.
  const asked = [entry('r1', 'needs_attention', 'q1')];
  assert.deepEqual(pruneInbox(asked, [run('r1', 'working')], nowhere), []);
  // Still stopped on the same prompt: it stays (and the array is the same one,
  // so nothing re-renders).
  assert.equal(pruneInbox(asked, [run('r1', 'needs_attention', 'q1')], nowhere), asked);
  // Stopped on a NEW prompt: the old entry is stale; the new one rings itself.
  assert.deepEqual(pruneInbox(asked, [run('r1', 'needs_attention', 'q2')], nowhere), []);
  // The run is gone: nothing left to answer.
  assert.deepEqual(pruneInbox(asked, [], nowhere), []);

  // «готова» and «ошибка» are news until someone acts on them…
  const done = [entry('r2', 'idle'), entry('r3', 'error')];
  assert.equal(pruneInbox(done, [run('r2', 'idle'), run('r3', 'error')], nowhere), done);
  assert.equal(pruneInbox(done, [], nowhere), done, 'a finished result is still news after the run closes');
  // …a new turn or a retry is someone acting on it…
  assert.deepEqual(pruneInbox(done, [run('r2', 'working'), run('r3', 'working')], nowhere), []);
  // …and so is opening the session.
  assert.deepEqual(
    pruneInbox(done, [run('r2', 'idle'), run('r3', 'error')], (n) => n.runId === 'r2').map((n) => n.runId),
    ['r3'],
  );
});

test('a status between two deltas does not split the sentence (10.10.2026)', () => {
  // Three background agents had just started: `background_tasks` landed
  // between «Пока аг» and «енты работают…», the second delta opened a new
  // line, and the final text replaced only that one — «Пока аг» stayed above
  // the whole sentence.
  let id = 0;
  const nextId = () => ++id;
  let lines: TranscriptLine[] = [];
  const fold = (e: Parameters<typeof foldStreamEvent>[1]) => {
    lines = foldStreamEvent(lines, e, nextId, () => 0);
  };
  fold({ kind: 'partial', text: 'Пока аг' });
  fold({ kind: 'status', code: 'background_tasks', text: '', data: { tasks: [] } });
  fold({ kind: 'partial', text: 'енты работают.' });
  fold({ kind: 'assistant', text: 'Пока агенты работают.' });
  fold({ kind: 'result', text: '' });
  assert.deepEqual(
    lines.filter((l) => l.kind === 'assistant').map((l) => l.text),
    ['Пока агенты работают.'],
  );
  // A tool call DOES end the sentence: the next delta is a new paragraph.
  fold({ kind: 'partial', text: 'Первый' });
  fold({ kind: 'tool_use', text: 'Read {}' });
  fold({ kind: 'partial', text: 'Второй' });
  assert.deepEqual(
    lines.filter((l) => l.kind === 'assistant').map((l) => l.text),
    ['Пока агенты работают.', 'Первый', 'Второй'],
  );
});

test('session_reads: marks only move forward and clear bell entries seen elsewhere', () => {
  const marks = mergeReads(new Map(), [{ machineId: 'm1', sessionId: 's1', at: 500 }]);
  const older = mergeReads(marks, [{ machineId: 'm1', sessionId: 's1', at: 100 }]);
  assert.equal(older.get('m1::s1'), 500);
  const mk = (id: number, sessionId: string, ts: number) => ({
    id,
    runId: `r${id}`,
    machineId: 'm1',
    sessionId,
    title: 't',
    state: 'idle' as const,
    ts,
  });
  const items = [mk(1, 's1', 400), mk(2, 's1', 900), mk(3, 's2', 100)];
  const kept = dropReadNotifications(items, older);
  assert.deepEqual(
    kept.map((n) => n.id),
    [2, 3],
  );
  // Nothing to drop keeps the same array, so React does not re-render.
  assert.equal(dropReadNotifications(kept, older), kept);
});

test('session_reads: a bell entry is compared by the run\'s hub time, not the browser clock', () => {
  const marks = new Map([['m1::s1', 1000]]);
  const mk = (id: number, since: number | undefined, ts: number) => ({
    id,
    runId: `r${id}`,
    machineId: 'm1',
    sessionId: 's1',
    title: 't',
    state: 'idle' as const,
    ts,
    since,
  });
  // The browser clock runs far ahead (ts 9000) but the run finished at hub 900,
  // before the read at 1000: it is seen. A run that finished at hub 1100 is not.
  assert.deepEqual(
    dropReadNotifications([mk(1, 900, 9000), mk(2, 1100, 50)], marks).map((n) => n.id),
    [2],
  );
  // No hub time on an old cached entry: falls back to ts.
  assert.deepEqual(dropReadNotifications([mk(3, undefined, 2000)], marks).map((n) => n.id), [3]);
});

test('reconcileActivity stamps a new bell entry with the run\'s hub time', () => {
  const run = {
    runId: 'r1',
    machineId: 'm1',
    machineName: 'M',
    sessionId: 's1',
    title: 't',
    state: 'idle',
    since: 4242,
    ownerUserId: 'u1',
  } as unknown as ActiveRunInfo;
  const seededWorking = new Map([['r1', 'working']]);
  const out = reconcileActivity({
    rawRuns: [run],
    active: null,
    attachedRunId: null,
    previousStates: seededWorking as never,
    seeded: true,
    notify: true,
    viewerId: 'u1',
    now: 99,
    nextId: () => 1,
  } as never);
  assert.equal(out.notifications[0]?.since, 4242);
  assert.equal(out.notifications[0]?.ts, 99);
});

test('bell sync: another window clears or marks an entry by session and hub time, not by local id', () => {
  const mk = (id: number, sessionId: string, since: number | undefined, state: 'idle' | 'error' = 'idle') => ({
    id,
    runId: `r${id}`,
    machineId: 'm1',
    sessionId,
    title: 't',
    state,
    ts: 5000 + id,
    since,
  });
  // The other window numbered its entries differently (id 77) and stamped its
  // own browser clock; the session and the hub `since` are what match.
  const theirs = mk(77, 's1', 900);
  const stamps = [bellStamp(theirs)];
  const mine = [mk(1, 's1', 900), mk(2, 's1', 1200), mk(3, 's2', 900)];
  assert.equal(stampCovers(stamps[0], mine[0]), true);
  // A newer turn of the same session is news the other window has not seen.
  assert.equal(stampCovers(stamps[0], mine[1]), false);
  assert.equal(stampCovers(stamps[0], mine[2]), false);
  assert.deepEqual(
    dropStamped([mine[0], mine[2]], stamps).map((n) => n.id),
    [3],
  );
  // Nothing matched: same array.
  const untouched = [mine[2]];
  assert.equal(dropStamped(untouched, stamps), untouched);
  // No hub time on one side: only the same state counts.
  assert.equal(stampCovers(bellStamp(mk(9, 's1', undefined)), mk(4, 's1', 900)), true);
  assert.equal(stampCovers(bellStamp(mk(9, 's1', undefined)), mk(4, 's1', 900, 'error')), false);
});

test('bell sync: junk on the channel is ignored', () => {
  assert.equal(parseBellSync(null), null);
  assert.equal(parseBellSync({ kind: 'nuke', stamps: [] }), null);
  assert.equal(parseBellSync({ kind: 'clear', stamps: 'x' }), null);
  assert.deepEqual(parseBellSync({ kind: 'seen', stamps: [{ key: 'm::s', state: 'idle', since: 3 }, { key: 1 }] }), {
    kind: 'seen',
    stamps: [{ key: 'm::s', state: 'idle', since: 3 }],
  });
});

test('bell sync: a stale mark from a third window does not undo a newer one', () => {
  const a = { key: 'm::s1', state: 'idle' as const, since: 1200 };
  const stale = { key: 'm::s1', state: 'idle' as const, since: 900 };
  const other = { key: 'm::s2', state: 'error' as const, since: 50 };
  assert.deepEqual(mergeStamps([a], [stale, other]), [a, other]);
  // A newer one replaces it and moves to the end.
  const newer = { ...a, since: 1500 };
  assert.deepEqual(mergeStamps([a, other], [newer]), [other, newer]);
  assert.equal(mergeStamps([], [a, other, newer], 1).length, 1);
});

test('team machines: kept apart, deduped, never repeating the viewer\'s own', () => {
  const t = (id: string) => ({ machine: { machineId: id, name: id, os: 'linux' }, owner: { userId: 'u' }, online: true, lastSeen: 1 }) as never;
  const own = [{ machine: { machineId: 'm1' } }];
  assert.deepEqual(mergeTeamMachines(undefined, own), []);
  assert.deepEqual(mergeTeamMachines([], own), []);
  const out = mergeTeamMachines([t('m1'), t('t1'), t('t1'), t('t2')], own);
  assert.deepEqual(out.map((x) => x.machine.machineId), ['t1', 't2']);
  // A view-only shared machine (canControl false) keeps its team card: its
  // hardware is stripped from `machines`.
  const viewOnly = [{ machine: { machineId: 'v1' }, canControl: false }];
  assert.deepEqual(mergeTeamMachines([t('v1')], viewOnly).map((x) => x.machine.machineId), ['v1']);
});
