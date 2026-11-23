import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codexSwitchError, showCodexSwitch } from '../src/components/runtimeChips.js';

const base = { supported: true, online: true, canControl: true, chatOnly: false, codexPresent: true };

describe('showCodexSwitch', () => {
  it('shows only when supported, online, controllable, not chat-only, Codex present', () => {
    assert.equal(showCodexSwitch(base), true);
    assert.equal(showCodexSwitch({ ...base, supported: undefined }), false);
    assert.equal(showCodexSwitch({ ...base, supported: false }), false);
    assert.equal(showCodexSwitch({ ...base, online: false }), false);
    assert.equal(showCodexSwitch({ ...base, canControl: false }), false);
    assert.equal(showCodexSwitch({ ...base, chatOnly: true }), false);
    assert.equal(showCodexSwitch({ ...base, codexPresent: false }), false);
    assert.equal(showCodexSwitch({ ...base, codexPresent: undefined }), false);
  });
});

describe('codexSwitchError', () => {
  it('maps codes to Russian text', () => {
    assert.match(codexSwitchError('busy'), /идут сессии Codex/);
    assert.match(codexSwitchError('no_gateway'), /не настроен шлюз/);
    assert.match(codexSwitchError('weird'), /weird/);
  });
});
