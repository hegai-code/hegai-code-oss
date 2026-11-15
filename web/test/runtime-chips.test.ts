import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeChip, claudeOff, runtimeChips, teamRuntimeState, withoutClaudeOff } from '../src/components/runtimeChips.js';

const base = { present: true, auth: 'oauth', account: 'owner@x.test', plan: 'max 20x', checkedAt: 0 };

describe('claudeChip', () => {
  it('a blanked login is a warning even though the account is still named', () => {
    const c = claudeChip({ ...base, error: 'logged_out' });
    assert.equal(c.tone, 'attn');
    assert.equal(c.label, 'Claude · вход слетел');
    assert.equal(c.action, 'login');
  });
  it('a rejected token is a warning', () => {
    assert.equal(claudeChip({ ...base, error: 'token_rejected' }).label, 'Claude · токен отклонён');
  });
  it('a long-lived token shows its end date, and warns when close', () => {
    const exp = Date.parse('2027-09-28T00:00:00Z');
    const ok = claudeChip({ present: true, auth: 'token', expiresAt: exp, checkedAt: 0 });
    assert.equal(ok.tone, 'ok');
    assert.match(ok.label, /^Claude · токен до .*2027/);
    assert.equal(claudeChip({ present: true, auth: 'token', expiresAt: exp, error: 'token_expiring', checkedAt: 0 }).tone, 'attn');
  });
  it('a dead long-lived token does not offer «Войти» — the env token would still win', () => {
    const c = claudeChip({ present: true, auth: 'token', error: 'token_expired', checkedAt: 0 });
    assert.equal(c.tone, 'attn');
    assert.equal(c.action, undefined);
  });
  it('a healthy login is unchanged', () => {
    assert.equal(claudeChip(base).label, 'Claude · Max 20x · owner@x.test');
  });
});

describe('Claude switched off on the machine (CC_REMOTE_DISABLE_CLAUDE=1)', () => {
  const off = { present: true, auth: 'none', error: 'disabled', checkedAt: 0 };
  it('is not a problem to fix — no login button, no account', () => {
    const c = claudeChip(off);
    assert.equal(c.tone, 'muted');
    assert.equal(c.action, undefined);
    assert.equal(c.label, 'Claude выключен');
  });
  it('drops out of the machine chips entirely', () => {
    const chips = runtimeChips({ claude: off, codex: { present: true, auth: 'none', provider: 'gateway', providerName: 'hegai', checkedAt: 0 } });
    assert.deepEqual(chips?.map((c) => c.runtime), ['codex']);
    assert.equal(claudeOff({ claude: off }), true);
    assert.equal(claudeOff({ claude: base }), false);
    assert.equal(claudeOff(undefined), false);
  });
});

describe('withoutClaudeOff', () => {
  it('drops a stale Claude reading of a machine that switched Claude off', () => {
    const off = { claude: { present: true, auth: 'none', error: 'disabled', checkedAt: 0 } };
    const usage = { abm: { account: 'owner@gmail.test', updatedAt: 1 }, stage: { account: 'owner@x.test', updatedAt: 1 } };
    const kept = withoutClaudeOff(usage, (mid) => (mid === 'abm' ? off : undefined));
    assert.deepEqual(Object.keys(kept), ['stage']);
  });
});

describe('teamRuntimeState', () => {
  it('says only found / signed in — no account, no plan', () => {
    assert.deepEqual(teamRuntimeState(undefined), { text: 'нет данных', tone: 'muted' });
    assert.deepEqual(teamRuntimeState({ present: false, auth: 'none' }), { text: 'не найден', tone: 'attn' });
    assert.deepEqual(teamRuntimeState({ present: true, auth: 'none' }), { text: 'нет входа', tone: 'attn' });
    assert.deepEqual(teamRuntimeState({ present: true, auth: 'oauth' }), { text: 'вход выполнен', tone: 'ok' });
  });
  it('reads the error code: refused / expired / timed-out is not «signed in»', () => {
    assert.equal(teamRuntimeState({ present: true, auth: 'oauth', error: 'token_rejected' }).text, 'нет входа');
    assert.equal(teamRuntimeState({ present: true, auth: 'chatgpt', error: 'timeout' }).tone, 'attn');
    assert.equal(teamRuntimeState({ present: true, auth: 'unknown' }).text, 'нет входа');
    assert.equal(teamRuntimeState({ present: true, auth: 'token', error: 'token_expiring' }).text, 'вход выполнен');
    assert.deepEqual(teamRuntimeState({ present: true, auth: 'none', error: 'disabled' }), { text: 'выключен', tone: 'muted' });
    assert.deepEqual(teamRuntimeState({ present: true, auth: 'none', provider: 'gateway' }), { text: 'шлюз', tone: 'ok' });
    assert.equal(teamRuntimeState({ present: false, auth: 'none', provider: 'gateway' }).text, 'не найден');
  });
});

it('team runtime: a gateway with an error does not read as healthy', () => {
  assert.equal(teamRuntimeState({ present: true, auth: 'none', provider: 'gateway', error: 'timeout' }).text, 'шлюз: ошибка');
  assert.equal(teamRuntimeState({ present: true, auth: 'none', provider: 'gateway' }).text, 'шлюз');
});
