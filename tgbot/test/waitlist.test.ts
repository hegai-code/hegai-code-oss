/**
 * The waitlist watcher's decisions: who is news, who left, and what the
 * message says. The failure modes worth pinning are the loud ones — replaying
 * the whole list on a fresh state file, and a button whose callback_data
 * Telegram refuses (it then silently drops the whole message's keyboard).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WaitlistMemory } from '../src/state.js';
import { assertCallbackData } from '../src/telegram.js';
import {
  planWaitlist,
  settledLine,
  waitlistKeyboard,
  waitlistRef,
  waitlistText,
  type WaitlistRow,
} from '../src/waitlist.js';

const max: WaitlistRow = {
  userId: 'd26eefff-06e7-4208-9d27-3b212157950b',
  email: 'max@example.com',
  fullName: 'Максим <Резниченко>',
  note: 'Потрогать бету',
  requestedAt: Date.now() - 5 * 60_000,
};

function remember(rows: WaitlistRow[], sent = true): WaitlistMemory {
  const known: WaitlistMemory['known'] = {};
  for (const row of rows) {
    known[waitlistRef(row.userId)] = {
      userId: row.userId,
      fingerprint: JSON.stringify([row.fullName ?? '', row.note ?? '', row.invitedTo ?? []]),
      row,
      messages: sent ? [{ chatId: 1, messageId: 10 }] : [],
    };
  }
  return { known };
}

test('the first poll seeds silently instead of announcing everyone already waiting', () => {
  const plan = planWaitlist([max], undefined);
  assert.equal(plan.seed, true);
  assert.deepEqual(plan.announce, []);
});

test('a new person is announced once; a known one is not', () => {
  const other = { ...max, userId: 'u2', email: 'b@x' };
  const plan = planWaitlist([max, other], remember([max]));
  assert.deepEqual(
    plan.announce.map((r) => r.userId),
    ['u2'],
  );
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.gone, []);
});

test('a note written after sign-up re-renders the announced message', () => {
  const before = { ...max, note: undefined };
  const plan = planWaitlist([max], remember([before]));
  assert.deepEqual(plan.update.map((r) => r.userId), [max.userId]);
});

test('a note change on a seeded (never messaged) person is not an edit', () => {
  const before = { ...max, note: undefined };
  const plan = planWaitlist([max], remember([before], false));
  assert.deepEqual(plan.update, []);
});

test('someone activated in the web leaves the list and their button is retired', () => {
  const plan = planWaitlist([], remember([max]));
  assert.deepEqual(plan.gone, [waitlistRef(max.userId)]);
});

test('the button fits Telegram for any user id, and the ref is stable', () => {
  const long = { ...max, userId: `local-${'x'.repeat(200)}` };
  const data = waitlistKeyboard(long)[0]![0]!.callback_data!;
  assert.doesNotThrow(() => assertCallbackData(data));
  assert.equal(waitlistRef(long.userId), waitlistRef(long.userId));
  assert.notEqual(waitlistRef('a'), waitlistRef('b'));
});

test('the message escapes what the person typed', () => {
  const text = waitlistText({ ...max, note: '<script>' }, 3);
  assert.ok(text.includes('Максим &lt;Резниченко&gt;'));
  assert.ok(text.includes('&lt;script&gt;'));
  assert.ok(text.includes('В листе ожидания: 3'));
  assert.ok(!text.includes('<script>'));
});

test('no note says so instead of printing an empty quote', () => {
  assert.ok(waitlistText({ ...max, note: '  ' }, 1).includes('о себе пока ничего не написал'));
});

test('every outcome has words, and an unknown reason is escaped', () => {
  assert.equal(settledLine('activated'), '✅ Доступ открыт');
  assert.ok(settledLine('<x>').includes('&lt;x&gt;'));
});

test('a Telegram-only waitlister (no email) is announced by name, never «undefined»', () => {
  const tg: WaitlistRow = { userId: 'tg-5f3a9c21-0000', fullName: 'Данис Латыпов', requestedAt: Date.now() };
  const text = waitlistText(tg, 1);
  assert.match(text, /<b>Данис Латыпов<\/b> · <i>без почты, id tg-5f3a9<\/i>/);
  assert.doesNotMatch(text, /undefined/);
  const bare = waitlistText({ userId: 'tg-5f3a9c21-0000' }, 1);
  assert.match(bare, /<b>Без имени<\/b> · <i>без почты, id tg-5f3a9<\/i>/);
  // A name posing as an address still gets the marker: it has no real one.
  const poser = waitlistText({ userId: 'tg-5f3a9c21-0000', fullName: 'owner@x.test' }, 1);
  assert.match(poser, /без почты, id tg-5f3a9/);
});
