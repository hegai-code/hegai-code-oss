import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeAuthVerdict, codexAuthFromAuthJson, codexProviderFromToml } from '../src/runtime-status.js';
import { planFromAccount } from '../src/claude-creds.js';

const jwt = (claims: Record<string, unknown>) =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('codexProviderFromToml', () => {
  it('no provider, or the built-in one, means the person’s own login', () => {
    assert.deepEqual(codexProviderFromToml(''), { provider: 'own' });
    assert.deepEqual(codexProviderFromToml('model = "gpt-5.6-sol"\n'), { provider: 'own' });
    assert.deepEqual(codexProviderFromToml('model_provider = "openai"\n'), { provider: 'own' });
  });

  it('the gateway installer’s top-level key is a gateway, by name', () => {
    const toml = [
      'model = "gpt-5.6-sol"',
      'model_provider = "hegai"',
      'model_reasoning_effort = "medium"',
      '',
      '[model_providers.hegai]',
      'name = "HegAI Gateway"',
      'base_url = "https://llm.acme.test/v1"',
    ].join('\n');
    assert.deepEqual(codexProviderFromToml(toml), { provider: 'gateway', providerName: 'hegai' });
  });

  it('a model_provider AFTER the first table belongs to that table, not the root', () => {
    // The TOML trap the installer avoids: appended keys silently join the last
    // table. Codex itself would not see a provider here, so neither do we.
    const toml = ['[projects."/home/x"]', 'trust_level = "trusted"', 'model_provider = "hegai"'].join('\n');
    assert.deepEqual(codexProviderFromToml(toml), { provider: 'own' });
  });

  it('ignores comments and single quotes work too', () => {
    assert.deepEqual(codexProviderFromToml("# model_provider = \"x\"\nmodel_provider = 'corp'\n"), {
      provider: 'gateway',
      providerName: 'corp',
    });
  });
});

describe('codexAuthFromAuthJson', () => {
  it('a ChatGPT login: email and plan from the id_token, top-level claims', () => {
    const r = codexAuthFromAuthJson({ tokens: { id_token: jwt({ email: 'ilya@example.com', chatgpt_plan_type: 'Plus' }) } });
    assert.deepEqual(r, { auth: 'chatgpt', account: 'ilya@example.com', plan: 'plus' });
  });

  it('…and under the openai auth namespace', () => {
    const r = codexAuthFromAuthJson({
      tokens: { id_token: jwt({ 'https://api.openai.com/auth': { email: 'p@a.test', chatgpt_plan_type: 'pro' } }) },
    });
    assert.deepEqual(r, { auth: 'chatgpt', account: 'p@a.test', plan: 'pro' });
  });

  it('an API key in the file or the environment is apikey', () => {
    assert.deepEqual(codexAuthFromAuthJson({ OPENAI_API_KEY: 'sk-…' }), { auth: 'apikey' });
    assert.deepEqual(codexAuthFromAuthJson({}, { OPENAI_API_KEY: 'sk-…' }), { auth: 'apikey' });
  });

  it('nothing is none, and garbage is none', () => {
    assert.deepEqual(codexAuthFromAuthJson({}), { auth: 'none' });
    assert.deepEqual(codexAuthFromAuthJson(undefined), { auth: 'none' });
    assert.deepEqual(codexAuthFromAuthJson({ tokens: { id_token: 'not-a-jwt' } }), { auth: 'chatgpt' });
  });
});

describe('planFromAccount (Claude)', () => {
  it('reads the plan word and the multiplier off the org fields', () => {
    assert.equal(planFromAccount({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' }), 'max 20x');
    assert.equal(planFromAccount({ organizationType: 'claude_pro' }), 'pro');
    assert.equal(planFromAccount({}), undefined);
  });
});

describe('claudeAuthVerdict', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const base = { apiKey: false, envToken: false, file: null, identity: true, now };
  const live = { hasAccess: true, hasRefresh: true, expiresAt: now + 3_600_000 };

  it('a blanked file is «logged out» even though ~/.claude.json still names the account (vps-box-1, 28.09)', () => {
    assert.deepEqual(claudeAuthVerdict({ ...base, file: { hasAccess: false, hasRefresh: false } }), { auth: 'none', error: 'logged_out' });
  });
  it('an expired access token with nothing to refresh it is expired (cloud, June token)', () => {
    assert.deepEqual(claudeAuthVerdict({ ...base, file: { hasAccess: true, hasRefresh: false, expiresAt: now - 1 } }), { auth: 'none', error: 'token_expired' });
  });
  it('an expired access token WITH a refresh token is fine — every idle server looks like this', () => {
    assert.deepEqual(claudeAuthVerdict({ ...base, file: { hasAccess: true, hasRefresh: true, expiresAt: now - 1 }, usageHttp: 401 }), { auth: 'oauth' });
  });
  it('a 401 on a token that should still be valid is a rejected login', () => {
    assert.deepEqual(claudeAuthVerdict({ ...base, file: live, usageHttp: 401, usageTokenExpiresAt: live.expiresAt }), { auth: 'oauth', error: 'token_rejected' });
  });
  it('a 401 for a token the file no longer holds (a turn refreshed it meanwhile) is not pinned on the new one', () => {
    assert.deepEqual(claudeAuthVerdict({ ...base, file: live, usageHttp: 401, usageTokenExpiresAt: now - 1 }), { auth: 'oauth' });
  });
  it('a 429 from the usage endpoint says nothing about the login', () => {
    assert.deepEqual(claudeAuthVerdict({ ...base, file: live, usageHttp: 429 }), { auth: 'oauth' });
  });
  it('the env token beats a dead file, and warns 30 days ahead', () => {
    const dead = { hasAccess: false, hasRefresh: false };
    assert.deepEqual(claudeAuthVerdict({ ...base, envToken: true, file: dead }), { auth: 'token' });
    const soon = now + 10 * 86_400_000;
    assert.deepEqual(claudeAuthVerdict({ ...base, envToken: true, envTokenExpiresAt: soon, file: dead }), { auth: 'token', error: 'token_expiring', expiresAt: soon });
    assert.equal(claudeAuthVerdict({ ...base, envToken: true, envTokenExpiresAt: now - 1, file: dead }).error, 'token_expired');
    const far = now + 300 * 86_400_000;
    assert.deepEqual(claudeAuthVerdict({ ...base, envToken: true, envTokenExpiresAt: far, file: dead }), { auth: 'token', expiresAt: far });
  });
  it('an API key wins over everything', () => {
    assert.deepEqual(claudeAuthVerdict({ ...base, apiKey: true, file: { hasAccess: false, hasRefresh: false } }), { auth: 'apikey' });
  });
  it('no file (a Mac, token in the Keychain) falls back to the identity', () => {
    assert.deepEqual(claudeAuthVerdict({ ...base }), { auth: 'oauth' });
    assert.deepEqual(claudeAuthVerdict({ ...base, identity: false }), { auth: 'none' });
  });
});

describe('claudeRuntimeStatus: login CLI', () => {
  const none = async () => undefined;
  const withHome = async (fn: () => Promise<void>) => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const old = { HOME: process.env['HOME'], K: process.env['ANTHROPIC_API_KEY'], T: process.env['CLAUDE_CODE_OAUTH_TOKEN'] };
    process.env['HOME'] = mkdtempSync(path.join(tmpdir(), 'ccr-home-'));
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    try {
      await fn();
    } finally {
      process.env['HOME'] = old.HOME;
      if (old.K !== undefined) process.env['ANTHROPIC_API_KEY'] = old.K;
      if (old.T !== undefined) process.env['CLAUDE_CODE_OAUTH_TOKEN'] = old.T;
    }
  };
  it('not signed in and no CLI → present stays true, error login_cli_missing', async () => {
    const { claudeRuntimeStatus } = await import('../src/runtime-status.js');
    await withHome(async () => {
      const s = await claudeRuntimeStatus({ sdkProbe: none, resolveBin: none });
      assert.equal(s.present, true);
      assert.equal(s.auth, 'none');
      assert.equal(s.error, 'login_cli_missing');
    });
  });
  it('not signed in but a CLI exists → plain «нет входа», no error', async () => {
    const { claudeRuntimeStatus } = await import('../src/runtime-status.js');
    await withHome(async () => {
      const s = await claudeRuntimeStatus({ sdkProbe: none, resolveBin: async () => '/x/claude' });
      assert.equal(s.error, undefined);
    });
  });
  it('signed in without a CLI is untouched', async () => {
    const { claudeRuntimeStatus } = await import('../src/runtime-status.js');
    process.env['ANTHROPIC_API_KEY'] = 'k';
    try {
      const s = await claudeRuntimeStatus({ sdkProbe: none, resolveBin: none });
      assert.equal(s.auth, 'apikey');
      assert.equal(s.error, undefined);
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });
});
