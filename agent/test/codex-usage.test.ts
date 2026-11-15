import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapCodexRateLimits, reduceCodexFrames } from '../src/codex-usage.js';

/**
 * The reading the machine card shows is folded from the app-server's answers.
 * The point of these: a server that REFUSES is a word («нет входа»), where it
 * used to be the same `null` as a server that was never found.
 */
describe('reduceCodexFrames', () => {
  const limits = {
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 10, windowDurationMins: 300 }, planType: 'plus' } },
  };

  it('limits plus account → usage carrying the email', () => {
    const r = reduceCodexFrames([
      { id: 2, result: { account: { email: 'ilya@example.com', planType: 'Plus' } } },
      { id: 3, result: limits },
    ]);
    assert.equal(r.error, undefined);
    assert.equal(r.usage?.account, 'ilya@example.com');
    assert.equal(r.usage?.subscription, 'plus');
    assert.deepEqual(r.account, { email: 'ilya@example.com', plan: 'plus' });
  });

  it('«authentication required» on the limits call is not_logged_in, with no usage', () => {
    const r = reduceCodexFrames([
      { id: 2, result: { account: null } },
      { id: 3, error: { code: -32000, message: 'codex account authentication required to read rate limits' } },
    ]);
    assert.equal(r.error, 'not_logged_in');
    assert.equal(r.usage, null);
  });

  it('any other refusal is app_server_error and keeps the message', () => {
    const r = reduceCodexFrames([{ id: 3, error: { message: 'internal: state db locked' } }]);
    assert.equal(r.error, 'app_server_error');
    assert.match(r.detail ?? '', /state db locked/);
  });

  it('limits without an account still map', () => {
    const r = reduceCodexFrames([{ id: 3, result: limits }]);
    assert.equal(r.error, undefined);
    assert.equal(r.usage?.limits?.length, 1);
    assert.equal(r.usage?.account, undefined);
  });
});

describe('mapCodexRateLimits', () => {
  it('maps the official primary and secondary windows', () => {
    const before = Date.now();
    const usage = mapCodexRateLimits({
      rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2_000_000_000 }, planType: 'pro' },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 2_000_000_001 },
          secondary: { usedPercent: 64, windowDurationMins: 10_080, resetsAt: 2_000_000_002 },
          planType: 'plus',
        },
      },
    });
    assert.equal(usage?.subscription, 'plus');
    assert.deepEqual(usage?.limits, [
      { key: 'session', label: 'Session (5hr)', group: 'session', percent: 28, resetsAt: 2_000_000_001_000 },
      { key: 'weekly_all', label: 'Weekly (1 week)', group: 'weekly', percent: 64, resetsAt: 2_000_000_002_000 },
    ]);
    assert.ok((usage?.updatedAt ?? 0) >= before);
  });

  it('returns null when no windows are usable', () => {
    assert.equal(mapCodexRateLimits({ rateLimits: {} }), null);
  });
});
