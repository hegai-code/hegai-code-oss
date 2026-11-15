import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageReport } from '@cc-remote/shared';
import { canSeeUsageTab, fillDays, fmtTokens, barTone, periodRange, windowIsOver, utcDay } from '../src/usageModel.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');

test('period ends today and spans N inclusive UTC days', () => {
  assert.deepEqual(periodRange(7, NOW), { from: '2026-10-24', to: '2026-10-30' });
  assert.deepEqual(periodRange(30, NOW), { from: '2026-10-01', to: '2026-10-30' });
  assert.equal(utcDay(Date.parse('2026-10-30T23:59:59Z')), '2026-10-30');
});

test('quiet days are zero so the sparkline keeps its shape', () => {
  assert.deepEqual(fillDays([{ day: '2026-10-25', tokens: 5, requests: 1 }], '2026-10-24', '2026-10-26'), [0, 5, 0]);
});

test('token counts read in Russian short form', () => {
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1234), '1,2 тыс');
  assert.equal(fmtTokens(460_000), '460 тыс');
  assert.equal(fmtTokens(3_510_000), '3,5 млн');
});

test('bar tone and elapsed windows', () => {
  assert.equal(barTone(50), 'ok');
  assert.equal(barTone(75), 'edge');
  assert.equal(barTone(95), 'over');
  assert.equal(windowIsOver({ resetsAt: NOW - 1 }, NOW), true);
  assert.equal(windowIsOver({}, NOW), false);
});

test('the tab is for owners and managers on a hub with a gateway', () => {
  const v = (role: 'owner' | 'manager' | 'member', llmUsage?: boolean) => ({ llmUsage, workspace: { role } }) as never;
  assert.equal(canSeeUsageTab(v('owner', true)), true);
  assert.equal(canSeeUsageTab(v('manager', true)), true);
  assert.equal(canSeeUsageTab(v('member', true)), false);
  assert.equal(canSeeUsageTab(v('owner')), false);
  assert.equal(canSeeUsageTab(null), false);
});

test('the hub report shape parses; extra fields are tolerated, absent optionals stay absent', () => {
  const report = {
    from: '2026-10-24', to: '2026-10-30', configured: true, scope: 'assigned', collectedAt: 1,
    members: [{
      userId: 'u', email: 'a@x.io', hitsLimit: false,
      gateway: { requests: 1, errors: 0, promptTokens: 1, completionTokens: 1, cachedTokens: 0, totalTokens: 2, models: [{ model: 'm', requests: 1, tokens: 2 }], days: [{ day: '2026-10-30', tokens: 2, requests: 1 }] },
      limit: { active: true, percent: 5.5 },
      subscriptions: [{ provider: 'claude', windows: [{ key: 'session', label: 's', percent: 1, sampledAt: 1, hitDays: 0, peakPercent: 1 }] }],
      futureField: 1,
    }],
  };
  const parsed = UsageReport.parse(report);
  assert.equal(parsed.members[0]?.limit?.tokens, undefined);
  assert.throws(() => UsageReport.parse({ ...report, scope: 'everyone' }));
  assert.throws(() => UsageReport.parse({ ...report, from: 'yesterday' }));
});
