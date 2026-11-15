import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeChip, notLoggedInRuntime, runtimeGate } from '../src/components/runtimeChips.js';
import { clearsDoneJob } from '../src/components/RuntimeRows.js';
import { gateText } from '../src/components/RuntimeGate.js';

const ok = { present: true, auth: 'oauth', checkedAt: 1 };
const codexOk = { present: true, auth: 'chatgpt', provider: 'own' as const, checkedAt: 1 };

describe('login_cli_missing', () => {
  it('chip says a claude is needed to sign in and offers install', () => {
    const c = claudeChip({ present: true, auth: 'none', error: 'login_cli_missing', checkedAt: 1 });
    assert.equal(c.label, 'Claude · нет входа · нужен claude для входа');
    assert.equal(c.action, 'install');
    assert.equal(runtimeGate({ claude: { present: true, auth: 'none', error: 'login_cli_missing', checkedAt: 1 } }, 'claude'), undefined); // inferred: never blocks sending
  });
});

describe('claude not found → «Установить»', () => {
  it('chip offers install with the npm hint', () => {
    const c = claudeChip({ present: false, auth: 'none', error: 'not_found', checkedAt: 1 });
    assert.equal(c.action, 'install');
    assert.equal(c.label, 'Claude не найден');
    assert.match(c.hint ?? '', /npm i -g @anthropic-ai\/claude-code, затем claude/);
  });
});

describe('runtimeGate (composer)', () => {
  it('unknown status (old agent) never blocks', () => {
    assert.equal(runtimeGate(undefined, 'claude'), undefined);
    assert.equal(runtimeGate({ codex: codexOk }, 'claude'), undefined);
  });
  it('signed-in coder does not block', () => {
    assert.equal(runtimeGate({ claude: ok, codex: codexOk }, 'claude'), undefined);
  });
  it('no login → login; not found → install', () => {
    assert.equal(runtimeGate({ claude: { present: true, auth: 'none', error: 'logged_out', checkedAt: 1 } }, 'claude'), 'login');
    assert.equal(runtimeGate({ claude: { present: false, auth: 'none', error: 'not_found', checkedAt: 1 } }, 'claude'), 'install');
    assert.equal(runtimeGate({ codex: { present: false, auth: 'none', provider: 'own', error: 'not_found', checkedAt: 1 } }, 'codex'), 'install');
    assert.equal(runtimeGate({ codex: { ...codexOk, auth: 'none', error: 'not_logged_in' } }, 'codex'), 'login');
  });
  it('gateway / helper machines read auth none but work: not blocked', () => {
    assert.equal(runtimeGate({ claude: { present: true, auth: 'none', checkedAt: 1 } }, 'claude'), undefined);
    assert.equal(runtimeGate({ codex: { ...codexOk, auth: 'none', provider: 'gateway' } }, 'codex'), undefined);
    assert.equal(runtimeGate({ codex: { ...codexOk, auth: 'none' } }, 'codex'), undefined);
  });
  it('a state without a button (SDK binary missing) is not gated', () => {
    assert.equal(runtimeGate({ claude: { present: false, auth: 'unknown', error: 'sdk_binary_missing', checkedAt: 1 } }, 'claude'), undefined);
  });
  it('says what to do', () => {
    assert.equal(gateText('claude', 'srv1', 'login'), 'Claude на srv1 не вошёл — войдите, и можно писать');
    assert.match(gateText('claude', 'srv1', 'install'), /не найден — установите/);
  });
});

describe('clearsDoneJob (RuntimeRows)', () => {
  it('clears when the chip is ok', () => assert.equal(clearsDoneJob('ok', 5, 5), true));
  it('clears when the agent has pushed a newer reading, even if still «нет входа»', () => {
    assert.equal(clearsDoneJob('attn', 20, 10), true);
  });
  it('keeps «Готово» while the reading is the one the job started against', () => {
    assert.equal(clearsDoneJob('attn', 10, 10), false);
    assert.equal(clearsDoneJob('attn', 10, undefined), false);
  });
});

describe('notLoggedInRuntime', () => {
  it('recognises the raw CLI line', () => {
    assert.equal(notLoggedInRuntime('Not logged in · Please run /login'), 'claude');
    assert.equal(notLoggedInRuntime('Invalid API key · Please run /login'), 'claude');
  });
  it('leaves `gh auth status` output and the like alone', () => {
    assert.equal(notLoggedInRuntime('You are not logged in to any GitHub hosts. To log in, run: gh auth login'), undefined);
    assert.equal(notLoggedInRuntime('Not logged in · Please run /login first, then retry'), undefined);
  });
  it('ignores ordinary prose', () => {
    assert.equal(notLoggedInRuntime('Сделал. Если нужно, войдите: Please run /login не требуется.'.repeat(5)), undefined);
    assert.equal(notLoggedInRuntime('Готово'), undefined);
  });
});
