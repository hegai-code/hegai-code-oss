import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codexGatewayConnection } from '../src/runtime-status.js';
import { gatewayLimitsUrl, mapGatewayLimits } from '../src/gateway-limits.js';

const TOML = `model = "gpt-5.6-sol"
model_provider = "hegai"

[projects."/srv/x"]
trust_level = "trusted"

# >>> hegai
[model_providers.hegai]
name = "HegAI Gateway"
base_url = "https://llm.acme.test/v1"
experimental_bearer_token = "sk-bf-secret"
wire_api = "responses"
# <<< hegai
`;

describe('codexGatewayConnection', () => {
  it('reads base_url and bearer of the active provider', () => {
    assert.deepEqual(codexGatewayConnection(TOML), { baseUrl: 'https://llm.acme.test/v1', bearer: 'sk-bf-secret' });
  });
  it('falls back to env_key', () => {
    const t = TOML.replace('experimental_bearer_token = "sk-bf-secret"', 'env_key = "GW_KEY"');
    assert.deepEqual(codexGatewayConnection(t, { GW_KEY: 'k1' }), { baseUrl: 'https://llm.acme.test/v1', bearer: 'k1' });
  });
  it('is empty for own login or another table', () => {
    assert.deepEqual(codexGatewayConnection('model = "x"\n'), {});
    assert.deepEqual(codexGatewayConnection(TOML.replace('model_provider = "hegai"', 'model_provider = "other"')), {});
  });
});

describe('gatewayLimitsUrl', () => {
  it('asks only the trusted gateway, and only when Codex points there', () => {
    const gw = 'https://llm.acme.test/v1';
    assert.equal(gatewayLimitsUrl('https://llm.acme.test/v1', gw)?.href, 'https://llm.acme.test/hegai/limits');
    assert.equal(gatewayLimitsUrl('https://evil.example/v1', gw), null, 'config points elsewhere');
    assert.equal(gatewayLimitsUrl('https://llm.acme.test.evil.example/v1', gw), null);
    assert.equal(gatewayLimitsUrl('https://u:p@llm.acme.test/v1', gw), null);
    assert.equal(gatewayLimitsUrl('https://llm.acme.test/v1', ''), null, 'no trusted gateway (external default)');
    assert.equal(gatewayLimitsUrl('http://127.0.0.1:9/v1', 'http://127.0.0.1:9')?.href, 'http://127.0.0.1:9/hegai/limits');
    assert.equal(gatewayLimitsUrl(undefined, gw), null);
  });
});

describe('mapGatewayLimits', () => {
  it('maps the account quota windows and leaves the key budget out', () => {
    const u = mapGatewayLimits({
      pool: 'pool-a',
      limits: { tokens: 1000, tokensUsed: 250, tokensWindow: '1d', resetAt: 5000, requests: 10, requestsUsed: 5, requestsWindow: '1h', requestsResetAt: 6000 },
      quota: { ok: true, plan: 'pro', primary_used_percent: 40, primary_window_minutes: 300, primary_reset_at: 100, secondary_used_percent: 10, secondary_window_minutes: 10080, secondary_reset_at: 200 },
    }, 1)!;
    assert.equal(u.account, 'шлюз · pool-a');
    assert.equal(u.subscription, 'pro');
    assert.deepEqual(u.limits!.map((l) => l.key), ['gw-primary', 'gw-secondary']);
    assert.equal(u.limits![0]!.label, 'Сессия (5 ч)');
    assert.equal(u.limits![0]!.resetsAt, 100_000);
    assert.equal(u.limits![1]!.label, 'Неделя (7 дней)');
  });
  it('returns null without a usable account quota', () => {
    assert.equal(mapGatewayLimits({ pool: 'p', limits: { tokens: 100, tokensUsed: 1 }, quota: null }), null);
    assert.equal(mapGatewayLimits({ pool: 'p', quota: { ok: false, primary_used_percent: 5, primary_window_minutes: 300 } }), null);
  });
});
