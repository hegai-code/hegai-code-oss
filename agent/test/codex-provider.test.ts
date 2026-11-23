import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCodexProvider } from '../src/codex-provider.js';
import { codexProviderFromToml } from '../src/runtime-status.js';

// Built at runtime so secret scanners don't take the fixture for a real key.
const KEY = ['sk', 'bf', 'x'.repeat(20)].join('-');
const gw = { baseUrl: 'https://llm.example.net/v1', key: KEY };

test('gateway on an empty file writes head keys and the marker block', () => {
  const out = applyCodexProvider('', 'gateway', gw);
  assert.match(out, /^model = "gpt-5.6-sol"\nmodel_provider = "hegai"\nmodel_reasoning_effort = "medium"\n/);
  assert.match(out, /# >>> hegai-gateway[^\n]*\n\[model_providers\.hegai\]\n/);
  assert.match(out, /base_url = "https:\/\/llm\.example\.net\/v1"/);
  assert.match(out, new RegExp(`experimental_bearer_token = "${KEY}"`));
  assert.match(out, /wire_api = "responses"\n# <<< hegai-gateway <<<\n$/);
  assert.equal(codexProviderFromToml(out).provider, 'gateway');
});

test('gateway keeps user tables and comments, replaces top-level keys, always writes the gateway model', () => {
  const src = [
    '# my config',
    'model = "gpt-5"',
    'model_provider = "openai"',
    'approval_policy = "never"',
    '',
    '[projects."/srv/x"]',
    'trust_level = "trusted"',
    'model = "nested-stays"',
    '',
  ].join('\n');
  const out = applyCodexProvider(src, 'gateway', gw);
  assert.match(out, /^model = "gpt-5.6-sol"\nmodel_provider = "hegai"/);
  assert.match(out, /# hegai-gateway: previous model = "gpt-5"/);
  assert.equal((out.match(/^model_provider/gm) ?? []).length, 1);
  assert.match(out, /# my config/);
  assert.match(out, /approval_policy = "never"/);
  assert.match(out, /\[projects\."\/srv\/x"\]\ntrust_level = "trusted"\nmodel = "nested-stays"/);
});

test('gateway re-apply is idempotent and replaces the key', () => {
  const once = applyCodexProvider('[tui]\nx = 1\n', 'gateway', gw);
  assert.equal(applyCodexProvider(once, 'gateway', gw), once);
  const key2 = ['sk', 'bf', 'z'.repeat(20)].join('-');
  const twice = applyCodexProvider(once, 'gateway', { ...gw, key: key2 });
  assert.ok(!twice.includes(KEY));
  assert.ok(twice.includes(key2));
  assert.equal((twice.match(/\[model_providers\.hegai\]/g) ?? []).length, 1);
});

test('own removes block, table and installer top-level keys, keeps the rest, leaves no key', () => {
  const src = applyCodexProvider('# hi\n[tui]\nx = 1\n', 'gateway', gw);
  const out = applyCodexProvider(src, 'own');
  assert.equal(out, '# hi\n[tui]\nx = 1\n');
  assert.ok(!out.includes('sk-bf-'));
  assert.equal(codexProviderFromToml(out).provider, 'own');
});

test('own on a hand-written bare [model_providers.hegai] table drops it too', () => {
  const src = `model_provider = "hegai"\nmodel = "m"\n\n[model_providers.hegai]\nexperimental_bearer_token = "${KEY}"\n\n[tui]\nx = 1\n`;
  const out = applyCodexProvider(src, 'own');
  assert.ok(!out.includes('secret'));
  assert.ok(!out.includes('model'));
  assert.match(out, /\[tui\]\nx = 1/);
});

test('own keeps a user model when the provider was not hegai', () => {
  const src = 'model = "gpt-5"\nmodel_provider = "other"\n[tui]\nx = 1\n';
  const out = applyCodexProvider(src, 'own');
  assert.match(out, /model = "gpt-5"/);
  assert.match(out, /model_provider = "other"/);
});

test('gateway uses hub model and effort when given', () => {
  const out = applyCodexProvider('', 'gateway', { ...gw, model: 'gpt-x/1.2', effort: 'high' });
  assert.match(out, /^model = "gpt-x\/1.2"\nmodel_provider = "hegai"\nmodel_reasoning_effort = "high"/);
  assert.match(applyCodexProvider('', 'gateway', { ...gw, effort: 'bogus' }), /model_reasoning_effort = "medium"/);
});

test('own restores the previous model and drops the key', () => {
  const src = applyCodexProvider('model = "gpt-5"\n[tui]\nx = 1\n', 'gateway', gw);
  const out = applyCodexProvider(src, 'own');
  assert.equal(out, 'model = "gpt-5"\n[tui]\nx = 1\n');
  assert.ok(!out.includes('sk-bf-'));
  // re-apply keeps the remembered model, not the gateway one
  const again = applyCodexProvider(src, 'gateway', gw);
  assert.equal(applyCodexProvider(again, 'own'), out);
});

test('own on an empty file stays empty', () => {
  assert.equal(applyCodexProvider('', 'own'), '');
});

test('setCodexProvider: mkdir, backup without key, custom provider refused, busy refused', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { setCodexProvider, setCodexProviderDeps } = await import('../src/codex-provider.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-'));
  const home = path.join(root, 'nested', '.codex');
  process.env['CODEX_HOME'] = home;
  let closed = 0;
  let busy = false;
  setCodexProviderDeps({ codexBusy: () => busy, closeIdleCodexRuns: () => { closed++; } });
  try {
    busy = true;
    assert.deepEqual(await setCodexProvider('gateway', KEY, 'https://g.example/v1'), { ok: false, error: 'busy' });
    busy = false;
    assert.deepEqual(await setCodexProvider('gateway', 'bad', 'https://g.example/v1'), { ok: false, error: 'bad_key' });
    assert.deepEqual(await setCodexProvider('gateway', KEY, ''), { ok: false, error: 'no_gateway' });
    assert.deepEqual(await setCodexProvider('gateway', KEY, 'https://g.example/v1', { model: 'bad model!' }), { ok: false, error: 'bad_model' });
    assert.equal((await setCodexProvider('gateway', KEY, 'https://g.example/v1')).ok, true); // no dir yet
    assert.equal((await setCodexProvider('gateway', KEY, 'https://g.example/v1')).ok, true); // rotation
    assert.equal((await setCodexProvider('own', undefined)).ok, true);
    for (const n of await fs.readdir(home)) {
      assert.ok(!(await fs.readFile(path.join(home, n), 'utf8')).includes('sk-bf-'), n);
    }
    assert.equal(closed, 3);
    await fs.writeFile(path.join(home, 'config.toml'), 'model_provider = "acme"\n');
    assert.deepEqual(await setCodexProvider('own', undefined), { ok: false, error: 'custom_provider' });
  } finally {
    delete process.env['CODEX_HOME'];
    await fs.rm(root, { recursive: true, force: true });
  }
});
