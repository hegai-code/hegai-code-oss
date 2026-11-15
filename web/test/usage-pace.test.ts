import test from 'node:test';
import assert from 'node:assert/strict';
import { paceOf, paceText } from '../src/components/usagePace.js';

const H = 3_600_000;
const D = 24 * H;
const now = 1_000 * D;
const week = (percent: number, resetInMs: number) => ({ key: 'weekly_all', label: 'w', group: 'weekly', percent, resetsAt: now + resetInMs });

test('48% with 3 of 7 days left lasts: the average pace reaches the reset', () => {
  const p = paceOf(week(48, 3 * D), now);
  assert.equal(p.status, 'ok');
  assert.ok(Math.abs(p.expected! - (4 / 7) * 100) < 1e-9);
  assert.match(paceText(p), /хватит.*сброс через 3 д/);
});

test('60% after 2 days runs out days early: over', () => {
  const p = paceOf(week(60, 5 * D), now);
  // 30%/day → 40% left lasts 1.33 d, the reset is 5 d away.
  assert.equal(p.status, 'over');
  assert.match(paceText(p), /кончится через 1,5 д/);
});

test('runs out within the last day of the week: edge', () => {
  // 4 days gone, 62% → 15.5%/d, 38% lasts 2.45 d against 3 d to reset.
  assert.equal(paceOf(week(62, 3 * D), now).status, 'edge');
});

test('the first day is too short to extrapolate: absolute thresholds', () => {
  assert.equal(paceOf(week(10, 6.75 * D), now).status, 'ok');
  assert.equal(paceOf(week(80, 6.5 * D), now).status, 'edge');
});

test('100% is out, whatever the time', () => {
  assert.equal(paceOf(week(100, 1 * D), now).status, 'out');
});

test('a 5-hour window paces against 5 hours', () => {
  const p = paceOf({ key: 'session', label: 's', group: 'session', percent: 90, resetsAt: now + 4 * H }, now);
  assert.equal(p.status, 'over');
});

test('seat budgets have no known window: absolute thresholds, no tick', () => {
  const p = paceOf({ key: 'budget_tokens', label: 'b', group: 'session', percent: 50, resetsAt: now + H }, now);
  assert.equal(p.status, 'ok');
  assert.equal(p.expected, undefined);
});

test('the label, not the group, gives the window: a Codex «Session (1 week)» paces as a week', () => {
  // 80% with 4 h of a WEEK left is fine; read as a 5-hour window it was «over».
  const p = paceOf({ key: 'session', label: 'Session (1 week)', group: 'session', percent: 80, resetsAt: now + 4 * H }, now);
  assert.equal(p.status, 'ok');
  assert.equal(paceOf({ key: 'session', label: 'Сессия (5 ч)', group: 'session', percent: 90, resetsAt: now + 4 * H }, now).status, 'over');
  assert.equal(paceOf({ key: 'weekly_all', label: 'Неделя (7 дней)', group: 'weekly', percent: 48, resetsAt: now + 3 * D }, now).status, 'ok');
});
