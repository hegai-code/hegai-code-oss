import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Before the import: `stateDir()` is read per call, but keep the test away from
// the real ~/.cc-remote of whoever runs it.
const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-models-'));
process.env['CC_REMOTE_STATE_DIR'] = dir;
// And away from the real ~/.claude/settings.json: `models.list` reads its `model`.
process.env['CLAUDE_CONFIG_DIR'] = dir;
delete process.env['ANTHROPIC_MODEL'];
const { dispatchRpc, loadKeptRuntimeModels, runtimeModelsFile, setRuntimeModels } = await import('../src/rpc-dispatch.js');

test('the runtime model list survives a restart (28.09.2026, «модель» on a fresh chat)', async () => {
  assert.equal(loadKeptRuntimeModels(), undefined, 'nothing kept yet');
  const models = [
    { id: 'default', name: 'Default (recommended)', resolved: 'claude-opus-5-5' },
    { id: 'opus', name: 'Opus', resolved: 'claude-opus-5-5' },
  ];
  setRuntimeModels(models);
  assert.equal(runtimeModelsFile(), path.join(dir, 'runtime-models.json'));
  assert.deepEqual(JSON.parse(readFileSync(runtimeModelsFile(), 'utf8')), models);
  // What a restarted agent reads back.
  assert.deepEqual(loadKeptRuntimeModels(), models);
  const listed = (await dispatchRpc('models.list', {})) as { models: { id: string }[] };
  assert.deepEqual(listed.models.map((m) => m.id), ['default', 'opus']);
});

test('a damaged file is ignored, not trusted', () => {
  writeFileSync(runtimeModelsFile(), '{"not":"a list"}');
  assert.equal(loadKeptRuntimeModels(), undefined);
  writeFileSync(runtimeModelsFile(), 'garbage');
  assert.equal(loadKeptRuntimeModels(), undefined);
});

test('models.list offers only the current Opus, Sonnet and Fable (06.10.2026, twelve rows on iOS)', async () => {
  const { currentModelsOnly } = await import('../src/rpc-dispatch.js');
  // What Claude Code 2.x actually answered on dev-box-1.
  const cli = [
    { id: 'default', name: 'Default (recommended)', resolved: 'claude-sonnet-5-5' },
    { id: 'opus', name: 'Opus 5.5', resolved: 'claude-opus-5-5' },
    { id: 'fable', name: 'Fable 5.1', resolved: 'claude-fable-5-1' },
    { id: 'sonnet', name: 'Sonnet 5.5', resolved: 'claude-sonnet-5-5' },
    { id: 'haiku', name: 'Haiku 4.5', resolved: 'claude-haiku-4-5-20251001' },
    { id: 'claude-sonnet-5', name: 'Sonnet 5', resolved: 'claude-sonnet-5' },
    { id: 'claude-opus-5', name: 'Opus 5', resolved: 'claude-opus-5' },
    { id: 'claude-fable-5', name: 'Fable 5', resolved: 'claude-fable-5' },
    { id: 'claude-opus-4-8', name: 'Opus 4.8', resolved: 'claude-opus-4-8' },
    { id: 'claude-opus-4-6', name: 'Opus 4.6', resolved: 'claude-opus-4-6' },
    { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', resolved: 'claude-sonnet-4-6' },
  ];
  assert.deepEqual(currentModelsOnly(cli).map((m) => m.id), ['default', 'opus', 'fable', 'sonnet']);
  // A kept file from an older agent is cut on the way out too.
  setRuntimeModels(cli);
  const listed = (await dispatchRpc('models.list', {})) as { models: { id: string }[] };
  assert.deepEqual(listed.models.map((m) => m.id), ['default', 'opus', 'fable', 'sonnet']);
  // No aliases: the newest pinned id of each family stands in.
  assert.deepEqual(
    currentModelsOnly(cli.filter((m) => m.id.startsWith('claude-'))).map((m) => m.id),
    ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'],
  );
  // Nothing recognisable: left alone rather than emptied.
  const odd = [{ id: 'mystery', name: 'Mystery' }];
  assert.deepEqual(currentModelsOnly(odd), odd);
});

test('the default row names what settings.json pins, not the CLI\'s own pick (07.10.2026, «Sonnet» on an Opus session)', async () => {
  const { withPinnedDefault, pinnedDefaultModel } = await import('../src/rpc-dispatch.js');
  const lvls = ['low', 'medium', 'high', 'xhigh', 'max'];
  // What dev-box-1's CLI answered while settings.json held `opus[1m]`.
  const cli = [
    { id: 'default', name: 'Default (recommended)', resolved: 'claude-sonnet-5-5', efforts: lvls, supportsEffort: true },
    { id: 'opus', name: 'Opus 5.5', resolved: 'claude-opus-5-5', efforts: lvls, supportsEffort: true },
    { id: 'sonnet', name: 'Sonnet 5.5', resolved: 'claude-sonnet-5-5', efforts: lvls, supportsEffort: true },
    { id: 'haiku', name: 'Haiku 4.5', resolved: 'claude-haiku-4-5-20251001' },
    { id: 'claude-opus-4-8', name: 'Opus 4.8', resolved: 'claude-opus-4-8', efforts: lvls, supportsEffort: true },
  ];
  const def = (pinned: string | undefined, catalog = cli) =>
    withPinnedDefault(cli, pinned, catalog).find((m) => m.id === 'default');

  assert.equal(def('opus[1m]')?.resolved, 'claude-opus-5-5', 'alias with a context tag');
  assert.equal(def('opus')?.resolved, 'claude-opus-5-5');
  assert.equal(def('claude-opus-5-5')?.resolved, 'claude-opus-5-5', 'wire id');
  assert.equal(def('claude-opus-4-8', cli)?.resolved, 'claude-opus-4-8', 'older pinned version');
  // The pinned model's efforts come along; an effortless one drops them.
  assert.equal(def('haiku')?.resolved, 'claude-haiku-4-5-20251001');
  assert.equal(def('haiku')?.efforts, undefined);
  assert.equal(def('haiku')?.supportsEffort, undefined);
  // Nothing pinned, or pinned to the CLI's own default: untouched.
  assert.equal(def(undefined)?.resolved, 'claude-sonnet-5-5');
  assert.equal(def('default')?.resolved, 'claude-sonnet-5-5');
  // A value the list has never heard of still names itself.
  assert.equal(def('claude-opus-9')?.resolved, 'claude-opus-9');
  assert.equal(def('claude-opus-9')?.efforts, undefined, 'not the old default\'s levels');
  // The other rows are never touched.
  assert.deepEqual(withPinnedDefault(cli, 'opus').slice(1), cli.slice(1));

  // Where the value comes from: ANTHROPIC_MODEL, else settings.json `model`.
  const settings = path.join(dir, 'settings.json');
  assert.equal(pinnedDefaultModel(settings), undefined, 'no file');
  writeFileSync(settings, '{ broken');
  assert.equal(pinnedDefaultModel(settings), undefined, 'unreadable');
  writeFileSync(settings, JSON.stringify({ model: 'opus[1m]' }));
  assert.equal(pinnedDefaultModel(settings), 'opus[1m]');
  assert.equal(pinnedDefaultModel(), 'opus[1m]', 'CLAUDE_CONFIG_DIR is honoured');
  writeFileSync(settings, JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_MODEL: 'opus' } }));
  assert.equal(pinnedDefaultModel(settings), 'opus', 'settings env beats settings model');
  writeFileSync(settings, JSON.stringify({ model: 'opus[1m]' }));
  process.env['ANTHROPIC_MODEL'] = 'sonnet';
  try {
    assert.equal(pinnedDefaultModel(settings), 'sonnet', 'env wins, as it does in the CLI');
  } finally {
    delete process.env['ANTHROPIC_MODEL'];
  }

  // End to end through the RPC the web asks.
  setRuntimeModels(cli);
  const listed = (await dispatchRpc('models.list', {})) as { models: { id: string; resolved?: string }[] };
  assert.equal(listed.models.find((m) => m.id === 'default')?.resolved, 'claude-opus-5-5');
});
