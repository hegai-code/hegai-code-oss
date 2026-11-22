import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codexChip, pickRuntime, runtimeHint } from '../src/components/runtimeChips.js';
import { hintText } from '../src/components/RuntimeGate.js';
import { WelcomeSelfHost } from '../src/components/Welcome.js';

const codexOk = { present: true, auth: 'chatgpt', provider: 'own' as const, checkedAt: 1 };
const claudeNone = { present: true, auth: 'none', error: 'login_cli_missing', checkedAt: 1 };
const claudeOk = { present: true, auth: 'oauth', checkedAt: 1 };

describe('default runtime follows the machine', () => {
  it('Claude unusable, Codex usable -> Codex', () => {
    assert.equal(pickRuntime({ claude: claudeNone, codex: codexOk }, 'claude'), 'codex');
  });
  it('Claude usable stays Claude', () => {
    assert.equal(pickRuntime({ claude: claudeOk, codex: codexOk }, 'claude'), 'claude');
  });
  it('an old agent with no runtimes counts as usable', () => {
    assert.equal(pickRuntime(undefined, 'claude'), 'claude');
    assert.equal(runtimeHint(undefined, 'claude'), undefined);
  });
});

describe('runtimeHint', () => {
  it('an inferred missing login gets a soft hint with the existing button', () => {
    assert.equal(runtimeHint({ claude: claudeNone }, 'claude'), 'install');
    assert.equal(runtimeHint({ claude: { present: true, auth: 'none', checkedAt: 1 } }, 'claude'), 'login');
  });
  it('a working or switched-off runtime has no hint', () => {
    assert.equal(runtimeHint({ claude: claudeOk }, 'claude'), undefined);
    assert.equal(runtimeHint({ claude: { present: false, auth: 'none', error: 'disabled', checkedAt: 1 } }, 'claude'), undefined);
  });
  it('the text names the runtime and the machine', () => {
    assert.match(hintText('claude', 'box', 'login'), /Claude на box не вошёл в аккаунт/);
    assert.match(hintText('claude', 'box', 'install'), /не установлен/);
  });
});

describe('no our-domain in user text', () => {
  it('gateway chip does not hard-code the a.test domain', () => {
    assert.equal(codexChip({ present: true, auth: 'none', provider: 'gateway', providerName: 'hegai', checkedAt: 1 }).label, 'Codex · шлюз');
    assert.equal(codexChip({ present: true, auth: 'none', provider: 'gateway', providerName: 'corp', checkedAt: 1 }).label, 'Codex · шлюз corp');
  });
  it('self-host welcome has no cloud/sandbox talk', () => {
    const json = JSON.stringify(WelcomeSelfHost());
    assert.doesNotMatch(json, /облак|песочниц|нашем хосте/);
    assert.match(json, /Подключите свой компьютер или сервер/);
  });
});
