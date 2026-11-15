import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, hhmm, stamp } from '../src/lib.js';

// These run in the reader's timezone by design — a transcript is read as wall
// clock, not UTC — so every case here is built from local-time Date parts
// rather than an ISO string, which would drift with the runner's TZ.
const at = (y: number, m: number, d: number, hh = 12, mm = 0) =>
  new Date(y, m, d, hh, mm).getTime();

test('a day boundary is calendar-based, not elapsed time', () => {
  // 90 minutes apart, different days.
  assert.notEqual(dayKey(at(2026, 7, 14, 23, 30)), dayKey(at(2026, 7, 15, 1, 0)));
  // 20 hours apart, same day. Any elapsed-ms threshold gets one of these wrong.
  assert.equal(dayKey(at(2026, 7, 14, 1, 0)), dayKey(at(2026, 7, 14, 21, 0)));
});

test('the same date in different months or years is not the same day', () => {
  assert.notEqual(dayKey(at(2026, 6, 14)), dayKey(at(2026, 7, 14)));
  assert.notEqual(dayKey(at(2025, 7, 14)), dayKey(at(2026, 7, 14)));
});

test("today's turns are the clock alone, older ones carry their date", () => {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Same calendar day, so the date would be noise on every line.
  assert.equal(stamp(midnight.getTime() + 3_600_000), hhmm(midnight.getTime() + 3_600_000));
  // Yesterday is already a different day and says so — a transcript is read
  // days later, when "yesterday" is not a fact the reader can reconstruct.
  const yday = midnight.getTime() - 3_600_000;
  assert.notEqual(stamp(yday), hhmm(yday));
  assert.ok(stamp(yday).endsWith(hhmm(yday)), `time should close the stamp: "${stamp(yday)}"`);
});

test('a previous year shows it, the current one is implied', () => {
  const now = new Date();
  // A month neither this one nor adjacent, so it cannot be today whenever the
  // suite happens to run.
  const month = (now.getMonth() + 6) % 12;
  const thisYear = stamp(at(now.getFullYear(), month, 14, 9, 5));
  const twoBack = stamp(at(now.getFullYear() - 2, month, 14, 9, 5));
  const yy = String(now.getFullYear() - 2).slice(2);
  assert.ok(twoBack.includes(yy), `expected a year in "${twoBack}"`);
  assert.ok(twoBack.length > thisYear.length, `year should be implied in "${thisYear}"`);
});

test('the stamp stays one mono line — it lives in a 76px gutter', () => {
  const now = new Date();
  const month = (now.getMonth() + 6) % 12;
  assert.ok(stamp(at(now.getFullYear(), month, 14, 23, 59)).length <= 11);
  assert.ok(stamp(at(now.getFullYear() - 2, month, 14, 23, 59)).length <= 14);
});

test('the time is zero-padded 24h, so the mono gutter stays aligned', () => {
  assert.equal(hhmm(at(2026, 7, 14, 9, 5)), '09:05');
  assert.equal(hhmm(at(2026, 7, 14, 14, 32)), '14:32');
  assert.equal(hhmm(at(2026, 7, 14, 0, 0)), '00:00');
  assert.equal(hhmm(at(2026, 7, 14, 23, 59)), '23:59');
});
