import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimit, rateLimitCurrent, rateLimitDismissKey, rateLimitText } from '../src/rateLimit.js';

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const S = (ms: number) => Math.floor(ms / 1000);

test('rate limit: the 76% of VS Code, from the SDK fraction and seconds', () => {
  const n = parseRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.768, resetsAt: S(NOW + 2 * 86_400_000 + 3_600_000) });
  assert.ok(n);
  assert.equal(n.percent, 76);
  assert.equal(rateLimitText(n, NOW), 'Использовано 76% недельного лимита · сброс через 2 дн.');
});

test('rate limit: allowed and malformed are no notice', () => {
  assert.equal(parseRateLimit({ status: 'allowed', utilization: 0.1 }), null);
  assert.equal(parseRateLimit(undefined), null);
  assert.equal(parseRateLimit({}), null);
});

test('rate limit: no utilization still names the window; a spent one says so', () => {
  const warn = parseRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: S(NOW + 90 * 60_000) })!;
  assert.equal(rateLimitText(warn, NOW), 'Близко к исчерпанию лимита сессии (5 ч) · сброс через 1 ч');
  const spent = parseRateLimit({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: S(NOW + 5 * 60_000) })!;
  assert.equal(rateLimitText(spent, NOW), 'Недельный лимит исчерпан · сброс через 5 мин');
  assert.equal(rateLimitText({ status: 'rejected' }, NOW), 'Лимит подписки исчерпан');
});

test('rate limit: a notice past its reset is gone', () => {
  const n = parseRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: S(NOW - 1000) })!;
  assert.equal(rateLimitCurrent(n, NOW), false);
  assert.equal(rateLimitCurrent(null, NOW), false);
});

test('rate limit: «×» holds until the news gets worse', () => {
  const at = S(NOW + 86_400_000);
  const k = (u: number, status = 'allowed_warning') =>
    rateLimitDismissKey('m1', parseRateLimit({ status, rateLimitType: 'seven_day', utilization: u, resetsAt: at })!);
  assert.equal(k(0.76), k(0.79));
  assert.notEqual(k(0.76), k(0.9));
  assert.notEqual(k(0.95), k(1, 'rejected'));
});
