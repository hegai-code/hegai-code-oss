// Unit tests for the pure functions of provisioner.mjs.
// Run: node --test deploy/sandbox/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCodexToml,
  codexTomlFor,
  ensureProjectTrust,
  upsertEnvLine,
  stripEnvLine,
  readEnvValue,
  upsertManagedBlock,
  validateUnixUser,
  envFileOf,
  loadConfig,
  gecosFor,
  gitNameFor,
  toWsUrl,
  backupName,
  tomlString,
  TOML_BLOCK_START,
  TOML_BLOCK_END,
  StepError,
} from '../provisioner.mjs';

const GW = { model: 'gpt-5.6-sol', baseUrl: 'https://llm.acme.test/v1', apiKey: 'sk-bf-test-key' };

const managedBlock = (key = GW.apiKey) => [
  TOML_BLOCK_START,
  '[model_providers.hegai]',
  'name = "HegAI Gateway"',
  `base_url = "${GW.baseUrl}"`,
  `experimental_bearer_token = "${key}"`,
  'wire_api = "responses"',
  TOML_BLOCK_END,
].join('\n');

test('mergeCodexToml: empty file gets header, blank line, managed block', () => {
  const out = mergeCodexToml('', GW);
  assert.equal(out, `model = "gpt-5.6-sol"\nmodel_provider = "hegai"\n\n${managedBlock()}\n`);
});

test('mergeCodexToml: a hand-written [model_providers.hegai] table is stripped, the next table survives', () => {
  const existing = [
    'model = "o3"',
    'approval_policy = "never"',
    '[model_providers.hegai]',
    'name = "old"',
    'base_url = "https://old.example/v1"',
    '[projects."/x"]',
    'trust_level = "trusted"',
  ].join('\n') + '\n';
  const out = mergeCodexToml(existing, GW);
  assert.equal(out.match(/\[model_providers\.hegai\]/g).length, 1, 'exactly one hegai table');
  assert.doesNotMatch(out, /old\.example/);
  assert.match(out, /\[projects\."\/x"\]\ntrust_level = "trusted"/);
  assert.match(out, /^model = "gpt-5\.6-sol"\nmodel_provider = "hegai"\napproval_policy = "never"\n/);
});

test('mergeCodexToml: the hegai table is placed last even when it was in the middle', () => {
  const existing = [
    TOML_BLOCK_START,
    '[model_providers.hegai]',
    'name = "HegAI Gateway"',
    TOML_BLOCK_END,
    '[projects."/home/sb-a/work"]',
    'trust_level = "trusted"',
    '[tui]',
    'theme = "dark"',
  ].join('\n') + '\n';
  const out = mergeCodexToml(existing, GW);
  const lines = out.trimEnd().split('\n');
  assert.equal(lines[lines.length - 1], TOML_BLOCK_END);
  assert.ok(out.indexOf('[tui]') < out.indexOf(TOML_BLOCK_START));
  assert.ok(out.indexOf('[projects."/home/sb-a/work"]') < out.indexOf(TOML_BLOCK_START));
});

test('mergeCodexToml: a [projects."…"] table Codex added later survives a re-key', () => {
  const first = mergeCodexToml('', GW);
  const withProject = first + '\n[projects."/home/sb-a/work/app"]\ntrust_level = "trusted"\n';
  const out = mergeCodexToml(withProject, { ...GW, apiKey: 'sk-bf-rotated' });
  assert.match(out, /\[projects\."\/home\/sb-a\/work\/app"\]\ntrust_level = "trusted"/);
  assert.match(out, /experimental_bearer_token = "sk-bf-rotated"/);
  assert.doesNotMatch(out, /sk-bf-test-key/);
});

test('mergeCodexToml: root-level model keys are replaced, the same keys inside a table are kept', () => {
  const existing = 'model = "o3"\nmodel_provider = "openai"\n[profiles.fast]\nmodel = "gpt-4.1"\nmodel_provider = "openai"\n';
  const out = mergeCodexToml(existing, GW);
  assert.equal(out.match(/^model = /gm).length, 2);
  assert.match(out, /\[profiles\.fast\]\nmodel = "gpt-4\.1"\nmodel_provider = "openai"/);
  assert.match(out, /^model = "gpt-5\.6-sol"\nmodel_provider = "hegai"\n/);
});

test('mergeCodexToml: idempotent — a second run yields identical text', () => {
  const existing = 'approval_policy = "never"\n[projects."/x"]\ntrust_level = "trusted"\n';
  const once = mergeCodexToml(existing, GW);
  const twice = mergeCodexToml(once, GW);
  assert.equal(twice, once);
  assert.equal(mergeCodexToml(twice, GW), once);
});

test('ensureProjectTrust: adds the trust table once and keeps the gateway block last', () => {
  const dir = '/home/sb-owner/work';
  const merged = mergeCodexToml('', GW);
  const once = ensureProjectTrust(merged, dir);
  assert.match(once, /\[projects\."\/home\/sb-owner\/work"\]\ntrust_level = "trusted"/);
  assert.equal(ensureProjectTrust(once, dir), once, 'second call is a no-op');
  assert.ok(once.indexOf('[projects."/home/sb-owner/work"]') < once.indexOf(TOML_BLOCK_START));
  // and the whole pipeline is a fixed point
  const pipeline = (t) => mergeCodexToml(ensureProjectTrust(t, dir), GW);
  assert.equal(pipeline(pipeline('')), pipeline(''));
});

test('ensureProjectTrust: on a file without the block it appends at the end', () => {
  const out = ensureProjectTrust('model = "o3"\n', '/home/sb-a/work');
  assert.equal(out, 'model = "o3"\n\n[projects."/home/sb-a/work"]\ntrust_level = "trusted"\n');
  assert.equal(ensureProjectTrust('', '/home/sb-a/work'), '[projects."/home/sb-a/work"]\ntrust_level = "trusted"\n');
});

test('tomlString escapes quotes and backslashes', () => {
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
});

test('upsertEnvLine / stripEnvLine / readEnvValue', () => {
  let env = '';
  env = upsertEnvLine(env, 'CENTRAL_URL', 'wss://code.acme.test');
  env = upsertEnvLine(env, 'MACHINE_NAME', 'sb-owner');
  assert.equal(env, 'CENTRAL_URL=wss://code.acme.test\nMACHINE_NAME=sb-owner\n');
  env = upsertEnvLine(env, 'CENTRAL_URL', 'wss://other');
  assert.equal(env, 'CENTRAL_URL=wss://other\nMACHINE_NAME=sb-owner\n', 'replaces in place');
  env = upsertEnvLine(env, 'CC_REMOTE_ENROLLMENT_CODE', 'ABC123');
  assert.equal(readEnvValue(env, 'CC_REMOTE_ENROLLMENT_CODE'), 'ABC123');
  const stripped = stripEnvLine(env, 'CC_REMOTE_ENROLLMENT_CODE');
  assert.equal(stripped, 'CENTRAL_URL=wss://other\nMACHINE_NAME=sb-owner\n');
  assert.equal(readEnvValue(stripped, 'CC_REMOTE_ENROLLMENT_CODE'), undefined);
  assert.equal(stripEnvLine(stripped, 'NOPE'), stripped, 'stripping an absent key is a no-op');
  // duplicates collapse to one, `export` prefix and spaces are recognised
  const dup = 'export FOO=1\nFOO =2\nBAR=3\n';
  assert.equal(upsertEnvLine(dup, 'FOO', '9'), 'FOO=9\nBAR=3\n');
  assert.throws(() => upsertEnvLine('', 'X', 'a\nb'));
});

test('upsertManagedBlock replaces an existing block and appends a missing one', () => {
  const S = '# >>> x >>>';
  const E = '# <<< x <<<';
  const fresh = upsertManagedBlock('umask 022\n', S, E, ['export A=1']);
  assert.equal(fresh, `umask 022\n\n${S}\nexport A=1\n${E}\n`);
  const replaced = upsertManagedBlock(fresh + 'alias ll="ls -l"\n', S, E, ['export A=2']);
  assert.equal(replaced, `umask 022\n\n${S}\nexport A=2\n${E}\nalias ll="ls -l"\n`);
  assert.equal(upsertManagedBlock(replaced, S, E, ['export A=2']), replaced, 'idempotent');
});

test('validateUnixUser', () => {
  for (const ok of ['sb-ab', 'sb-owner', 'sb-owner-1a2b', 'sb-' + 'a'.repeat(24)]) {
    assert.equal(validateUnixUser(ok), ok);
  }
  for (const bad of ['', 'sb-', 'sb-a', 'sb-Owner', 'root', 'devbox', 'sb-' + 'a'.repeat(25), 'sb-../x', 'sb-a b', 42, undefined]) {
    assert.throws(() => validateUnixUser(bad), (err) => err instanceof StepError && err.stage === 'validate' && err.retryable === false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('gecosFor / gitNameFor / toWsUrl / backupName', () => {
  assert.equal(gecosFor({ fullName: 'Анна: Иванова, PhD', email: 'anna@x.io' }), 'Анна Иванова PhD anna@x.io');
  assert.equal(gecosFor({ email: 'anna@x.io' }), 'anna@x.io');
  assert.equal(gitNameFor({ fullName: ' Anna ', email: 'anna@x.io' }), 'Anna');
  assert.equal(gitNameFor({ email: 'anna@x.io' }), 'anna');
  assert.equal(toWsUrl('https://code.acme.test/'), 'wss://code.acme.test');
  assert.equal(toWsUrl('http://127.0.0.1:4319'), 'ws://127.0.0.1:4319');
  assert.equal(toWsUrl('wss://code.acme.test'), 'wss://code.acme.test');
  assert.equal(backupName('sb-a', new Date(2026, 8, 2, 7, 5)), 'sb-a-20260902-0705.tgz');
});

/**
 * A sandbox with no gateway key is the NORMAL case now: activation stopped
 * minting a seat on the shared subscription, so a new member's machine is built
 * without one and they sign into their own Codex inside it. This used to throw,
 * which would have failed every first provisioning run.
 */
test('codexTomlFor: no key, none required — trust table written, no gateway block', () => {
  const out = codexTomlFor('', '/home/sb-anna/projects', undefined, { defaultModel: GW.model });
  assert.match(out, /\[projects\."\/home\/sb-anna\/projects"\]/);
  assert.doesNotMatch(out, /model_providers\.hegai/);
  assert.doesNotMatch(out, /experimental_bearer_token/);
});

test('codexTomlFor: a key still installs the managed block', () => {
  const out = codexTomlFor('', '/home/sb-anna/projects', GW, { defaultModel: GW.model });
  assert.match(out, /\[model_providers\.hegai\]/);
  assert.match(out, new RegExp(GW.apiKey));
});

test('codexTomlFor: a rotation with no key is a malformed job, not a choice', () => {
  assert.throws(
    () => codexTomlFor('', '/home/sb-anna/projects', undefined, { requireKey: true, defaultModel: GW.model }),
    (e) => e instanceof StepError && /no gateway\.apiKey/.test(e.message),
  );
});

test('codexTomlFor: an existing key is left alone when the job carries none', () => {
  const before = codexTomlFor('', '/home/sb-anna/projects', GW, { defaultModel: GW.model });
  const after = codexTomlFor(before, '/home/sb-anna/projects', undefined, { defaultModel: GW.model });
  assert.equal(after, before, 'a member who already has a seat does not lose it');
});


test('account erasure removes only exact regular archives and supports retries', async () => {
  const { mkdtemp, mkdir, writeFile, readdir, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { eraseSandboxFiles } = await import('../provisioner.mjs');
  const root = await mkdtemp(join(tmpdir(), 'sandbox-erase-test-'));
  const cfg = { homeRoot: join(root, 'homes'), backupDir: join(root, 'backups'), uidMin: process.getuid(), uidMax: process.getuid() };
  try {
    await mkdir(cfg.homeRoot); await mkdir(cfg.backupDir);
    await mkdir(join(cfg.homeRoot, 'sb-alice'));
    await writeFile(join(cfg.homeRoot, 'sb-alice', 'private'), 'private');
    for (const name of ['sb-alice-20260926-1400.tgz', 'sb-bob-20260926-1400.tgz', 'sb-alice-other.tgz']) {
      await writeFile(join(cfg.backupDir, name), 'archive');
    }
    await eraseSandboxFiles(cfg, 'sb-alice');
    await eraseSandboxFiles(cfg, 'sb-alice');
    assert.deepEqual((await readdir(cfg.backupDir)).sort(), ['sb-alice-other.tgz', 'sb-bob-20260926-1400.tgz']);
    await symlink(join(cfg.backupDir, 'sb-bob-20260926-1400.tgz'), join(cfg.backupDir, 'sb-alice-20260926-1500.tgz'));
    await assert.rejects(eraseSandboxFiles(cfg, 'sb-alice'), /unexpected type/);
    await assert.rejects(eraseSandboxFiles(cfg, '../alice'), /must match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('envFileOf: unit env lives outside the sandbox home, root-side', () => {
  const cfg = loadConfig({});
  assert.equal(envFileOf(cfg, 'sb-alice'), '/etc/cc-remote/sandboxes/sb-alice.env');
  assert.ok(!envFileOf(cfg, 'sb-alice').startsWith(cfg.homeRoot));
  for (const bad of ['root', 'sb-../x', 'sb-a/b', '../sb-a', 'sb-', 'devbox']) {
    assert.throws(() => envFileOf(cfg, bad), /refusing env path/, bad);
  }
});

test('hosts are env-configurable; the gateway has no built-in host', () => {
  const d = loadConfig({});
  assert.equal(d.hubUrl, 'https://code.acme.test');
  assert.equal(d.previewHost, 'preview-sb{n}.acme.test');
  assert.equal(d.gatewayUrl, '');
  const c = loadConfig({
    CC_REMOTE_HUB_URL: 'https://code.acme.example/',
    SANDBOX_PREVIEW_HOST: 'p{n}.acme.example',
    SANDBOX_GATEWAY_URL: 'https://gw.acme.example/v1/',
  });
  assert.equal(c.hubUrl, 'https://code.acme.example');
  assert.equal(c.previewHost, 'p{n}.acme.example');
  assert.equal(c.gatewayUrl, 'https://gw.acme.example/v1');
});

test('codexTomlFor: a job without baseUrl gets the configured default, not a hard-coded host', () => {
  const gw = { apiKey: 'sk-bf-test-key' };
  const out = codexTomlFor('', '/home/sb-anna/work', gw, { defaultModel: 'm', defaultBaseUrl: 'https://gw.acme.example/v1' });
  assert.match(out, /base_url = "https:\/\/gw\.acme\.example\/v1"/);
  assert.doesNotMatch(out, /llm\.acme\.test/);
});

test('codexTomlFor: a key with no baseUrl and no configured default fails instead of guessing a host', () => {
  assert.throws(() => codexTomlFor('', '/home/sb-anna/work', { apiKey: 'sk-bf-test-key' }, { defaultModel: 'm' }),
    (e) => e.stage === 'toml' && !String(e.message).includes('sk-bf'));
});
