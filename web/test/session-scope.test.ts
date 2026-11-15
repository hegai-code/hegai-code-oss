import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActiveRunInfo, SessionSummary } from '@cc-remote/shared';
import { sessionIsActive, sessionIsMine } from '../src/lib.js';

/**
 * The sidebar splits «моё» from «Команда» and lifts live work above dormant.
 * Both halves are one-liners and both have an obvious wrong version that
 * looks right until you run it against a real fleet, so each case below is
 * the one that would have been shipped.
 */

const ME = 'u-me';
const THEM = { userId: 'u-them', fullName: 'Маша' };
const MINE = { userId: ME, fullName: 'Владелец' };

/** A personal device: the wire OMITS `kind` for one (server-rs/hub/wire.rs
 *  — "present only as 'sandbox'"), so this is what the snapshot really looks
 *  like and the helper must not require `kind === 'personal'` to exist. */
const laptop = (owner?: { userId: string }) => (owner ? { owner } : {});
/** A shared box — the employee sandbox several people work on. */
const sandbox = (owner?: { userId: string }) =>
  ({ ...(owner ? { owner } : {}), kind: 'sandbox' }) as const;
/** The shape the REAL shared box has: `devbox` enrolled as a personal device of
 *  its owner and carries no `kind` at all, so only `shared` — the hub answering
 *  "does anybody else hold a share here" — tells it apart from a laptop. */
const sharedBox = (owner?: { userId: string }) =>
  ({ ...(owner ? { owner } : {}), shared: true }) as const;

test('on a personal machine a session with no owner belongs to whoever owns it', () => {
  // THE case this whole helper exists for. The hub records an owner only for
  // sessions cc-remote itself started; every terminal and every VS Code
  // window arrives ownerless forever. `s.owner?.userId === viewerId` would
  // therefore file almost all of the fleet owner's own work under «Команда».
  assert.equal(sessionIsMine({}, laptop(MINE), ME), true);
  assert.equal(sessionIsMine({}, laptop(THEM), ME), false);
  // An older snapshot can omit the machine owner entirely — unknown is not a
  // reason to hide work from the only person looking at it.
  assert.equal(sessionIsMine({}, undefined, ME), true);
});

test('on a SHARED machine an unowned session belongs to nobody', () => {
  // Deliberately the opposite of the case above, and the reason the machine is
  // now passed whole instead of as its owner. A sandbox is one box several
  // people type in, so the "one person at this keyboard" assumption behind the
  // fallback is false there: crediting every ownerless terminal to the box's
  // owner is what put the whole team's work in his «Только мои».
  assert.equal(sessionIsMine({}, sandbox(MINE), ME), false);
  assert.equal(sessionIsMine({}, sandbox(THEM), ME), false);
  // An attributed session is still read the same way anywhere — the kind only
  // decides what an ABSENT owner means.
  assert.equal(sessionIsMine({ owner: MINE }, sandbox(THEM), ME), true);
  assert.equal(sessionIsMine({ owner: THEM }, sandbox(MINE), ME), false);
});

test('a box with shares is shared even when it calls itself personal', () => {
  // The case that made the first version of this fix inert. `kind` records how
  // a machine ENROLLED, and the employee sandbox enrolled as its owner's
  // personal device: in the live fleet `devbox` says `personal` while carrying
  // nine team shares, and the only box labelled `sandbox` is a one-person
  // community seat. So the label cannot be the test — the share is.
  assert.equal(sessionIsMine({}, sharedBox(MINE), ME), false);
  assert.equal(sessionIsMine({}, sharedBox(THEM), ME), false);
  assert.equal(sessionIsMine({ owner: MINE }, sharedBox(MINE), ME), true);
});

test('a recorded owner outranks the machine it ran on', () => {
  // A teammate's session on my box is theirs...
  assert.equal(sessionIsMine({ owner: THEM }, laptop(MINE), ME), false);
  // ...and mine on their box is mine. Both directions matter: shares mean
  // people work on machines they do not own.
  assert.equal(sessionIsMine({ owner: MINE }, laptop(THEM), ME), true);
});

test('a signed-out viewer owns nothing that is attributed', () => {
  assert.equal(sessionIsMine({ owner: MINE }, laptop(MINE), undefined), false);
  // Unowned work on an unowned machine still has to render somewhere.
  assert.equal(sessionIsMine({}, undefined, undefined), true);
});

const run = (state: ActiveRunInfo['state']): ActiveRunInfo => ({
  runId: 'r-1',
  machineId: 'm-1',
  sessionId: 's-1',
  state,
  since: 0,
});

test('live means either signal, and an idle run is still live', () => {
  // `livePid` is the half the old «Сейчас в работе» never saw: a pid file
  // under ~/.claude/sessions, i.e. someone's editor.
  assert.equal(sessionIsActive({ livePid: 4321 }, undefined), true);
  // An open run holds the single-writer lock whether or not the agent is
  // mid-turn, so `idle` is held, not free.
  assert.equal(sessionIsActive({}, run('idle')), true);
  assert.equal(sessionIsActive({}, run('working')), true);
  assert.equal(sessionIsActive({}, run('needs_attention')), true);
  assert.equal(sessionIsActive({}, run('error')), true);
  assert.equal(sessionIsActive({}, undefined), false);
});

// --- card ordering -------------------------------------------------------
//
// The card is now the ONLY place live work shows, so the ordering it uses is
// load-bearing rather than cosmetic. This mirrors `order` + the split in
// ProjectList; if that changes shape, this is the test that should fail.

type Row = { id: string; livePid?: number; lastModified: number };

const CARD_SESSIONS = 3;
const CARD_ACTIVE = 10;

function cardRows(rows: Row[]): { shown: string[]; hiddenLive: number } {
  const sorted = [...rows].sort(
    (a, b) =>
      Number(sessionIsActive(b, undefined)) - Number(sessionIsActive(a, undefined)) ||
      b.lastModified - a.lastModified,
  );
  const liveCount = sorted.filter((r) => sessionIsActive(r, undefined)).length;
  const shown = [
    ...sorted.slice(0, Math.min(liveCount, CARD_ACTIVE)),
    ...sorted.slice(liveCount, liveCount + CARD_SESSIONS),
  ];
  return { shown: shown.map((r) => r.id), hiddenLive: Math.max(0, liveCount - CARD_ACTIVE) };
}

test('a live session outranks a fresher dormant one', () => {
  // The exact regression: a VS Code window open since this morning must not
  // sink below three messages someone sent a minute ago.
  const { shown } = cardRows([
    { id: 'dormant-now', lastModified: 1_000 },
    { id: 'live-old', livePid: 7, lastModified: 1 },
  ]);
  assert.deepEqual(shown, ['live-old', 'dormant-now']);
});

test('every live row is shown up to the ceiling, dormant rows stay capped at three', () => {
  const rows: Row[] = [];
  for (let i = 0; i < 12; i++) rows.push({ id: `live-${i}`, livePid: 100 + i, lastModified: 500 - i });
  for (let i = 0; i < 9; i++) rows.push({ id: `dormant-${i}`, lastModified: 400 - i });
  const { shown, hiddenLive } = cardRows(rows);
  assert.equal(shown.filter((id) => id.startsWith('live-')).length, CARD_ACTIVE);
  assert.equal(shown.filter((id) => id.startsWith('dormant-')).length, CARD_SESSIONS);
  assert.equal(hiddenLive, 2);
  // Newest of each half leads, and nothing dormant jumps the live block.
  assert.equal(shown[0], 'live-0');
  assert.equal(shown[CARD_ACTIVE], 'dormant-0');
});

test('a project with nothing live still previews its three newest', () => {
  const rows: Row[] = [
    { id: 'a', lastModified: 3 },
    { id: 'b', lastModified: 2 },
    { id: 'c', lastModified: 1 },
    { id: 'd', lastModified: 0 },
  ];
  const { shown, hiddenLive } = cardRows(rows);
  assert.deepEqual(shown, ['a', 'b', 'c']);
  assert.equal(hiddenLive, 0);
});
