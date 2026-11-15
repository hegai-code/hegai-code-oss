import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRunPick, effortTrack, goModelOrDefault, isGoModel, modelsForSide, prettyModel } from '../src/components/run-settings.js';

const models = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', resolved: 'gpt-6-astra', efforts: ['high'] },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', resolved: 'gpt-5.6-sol', efforts: ['high'] },
];

test('authoritative runtime model wins over a stale requested pick', () => {
  const view = deriveRunPick({
    models,
    fromRuntime: true,
    model: 'gpt-6-astra',
    effort: 'high',
    activeModel: 'gpt-5.6-sol',
  });
  assert.equal(view.activeLabel, 'GPT-5.6 Sol');
});

test('requested model is shown while runtime readback has not arrived', () => {
  const view = deriveRunPick({
    models,
    fromRuntime: true,
    model: 'gpt-6-astra',
    effort: 'high',
  });
  assert.equal(view.activeLabel, 'GPT-6 Astra');
});

// ---- the effort track -------------------------------------------------------
// The regression these exist for: an unknown level rendered as a thumb parked
// on the FIRST STOP, which is `low`. The control stated a level the session was
// not running at, and only its opacity said otherwise.

const STOPS = ['low', 'medium', 'high', 'xhigh'] as const;

test('an unknown level asserts no position on the track', () => {
  const t = effortTrack({ stops: STOPS, effort: '', drag: null });
  assert.equal(t.unknown, true, 'must not claim to know the level');
  assert.equal(t.unset, true);
  assert.equal(t.effective, '');
});

test('a reported level places the thumb on that stop, not on low', () => {
  const t = effortTrack({ stops: STOPS, effort: '', activeEffort: 'medium', drag: null });
  assert.equal(t.unknown, false);
  assert.equal(t.shown, 1);
  assert.equal(STOPS[t.shown], 'medium');
});

test('a pinned level outranks what the run reports', () => {
  const t = effortTrack({ stops: STOPS, effort: 'xhigh', activeEffort: 'low', drag: null });
  assert.equal(t.effective, 'xhigh');
  assert.equal(t.shown, 3);
});

for (const level of ['max', 'none', 'ultra']) {
  test(`${level} is in force but off the ladder — named, never parked on low`, () => {
    const t = effortTrack({ stops: STOPS, effort: '', activeEffort: level, drag: null });
    assert.equal(t.offScale, true);
    assert.equal(t.unknown, true, 'no thumb: it belongs at no stop on this ladder');
    assert.equal(t.effective, level);
  });
}

test('a drag shows its own thumb even on a previously unknown track', () => {
  const t = effortTrack({ stops: STOPS, effort: '', drag: 2 });
  assert.equal(t.unknown, false, 'the finger is on it; hiding it mid-gesture is worse');
  assert.equal(t.pending, true);
  assert.equal(t.shown, 2);
});

test('ultracode is not an unknown level', () => {
  const t = effortTrack({ stops: STOPS, effort: 'ultracode', drag: null });
  assert.equal(t.unset, false);
  assert.equal(t.offScale, false);
});

// ---- the label that produced «Opus 4.8» ------------------------------------
// Not a bug: the picker names the model the RUNTIME reports, and a CLI still
// advertising a previous generation is answered honestly rather than silently.

test('a wire id with no row is made readable rather than printed raw', () => {
  assert.equal(prettyModel('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(prettyModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(prettyModel('claude-opus-5[1m]'), 'Opus 5 (1m)');
});

test('a real name is returned untouched', () => {
  assert.equal(prettyModel('GPT-6 Astra'), 'GPT-6 Astra');
});

// ---- the chip names a generation, not a family ------------------------------
// The CLI's rows are ALIASES: `opus` comes with `displayName: "Opus"` because
// the row means «whichever Opus is current». Labelling the run with that answers
// «which family», when the question the control exists for is «which model am I
// running».

const claudeRows = [
  { id: 'opus', name: 'Opus', resolved: 'claude-opus-4-8' },
  { id: 'sonnet', name: 'Sonnet', resolved: 'claude-sonnet-5' },
];

test('an alias row is named by the generation the run actually resolved to', () => {
  const view = deriveRunPick({
    models: claudeRows,
    fromRuntime: true,
    model: 'opus',
    effort: '',
    activeModel: 'claude-opus-4-8',
  });
  assert.equal(view.activeLabel, 'Opus 4.8', 'not the bare «Opus»');
});

test('without a reported model the row keeps its own word', () => {
  const view = deriveRunPick({ models: claudeRows, fromRuntime: true, model: 'opus', effort: '' });
  assert.equal(view.activeLabel, 'Opus');
});

test('a runtime whose ids are not Claude-shaped is left alone', () => {
  // Codex reports `gpt-6-astra`, which carries no version for prettyModel to
  // find — so the row's own display name must survive.
  const view = deriveRunPick({
    models,
    fromRuntime: true,
    model: '',
    effort: 'high',
    activeModel: 'gpt-5.6-sol',
  });
  assert.equal(view.activeLabel, 'GPT-5.6 Sol');
});

test('a fresh session names the model it was STARTED on, not the account default, until the run reports (07.10.2026)', async () => {
  const { sentPick } = await import('../src/sessionChannel.js');
  // The runtime list as dev-box-1's agent kept it: the CLI's `default` row
  // claims Sonnet, the start screen pinned Opus.
  const claude = [
    { id: 'default', name: 'Default (recommended)', resolved: 'claude-sonnet-5-5' },
    { id: 'opus', name: 'Opus 5.5', resolved: 'claude-opus-5-5' },
    { id: 'sonnet', name: 'Sonnet 5.5', resolved: 'claude-sonnet-5-5' },
  ];
  // Between the start and the run's first `run_settings`, the composer reads
  // the sent pick as the run's settings.
  const seeded = sentPick({ model: 'opus', effort: 'high' });
  assert.deepEqual(seeded, { model: 'opus', effort: 'high' });
  const view = deriveRunPick({ models: claude, fromRuntime: true, model: seeded?.model ?? '', effort: '' });
  assert.equal(view.activeLabel, 'Opus 5.5', 'was «Sonnet 5.5» — the default row');
  // Nothing pinned: nothing to claim, the account decides.
  assert.equal(sentPick({}), null);
  assert.equal(sentPick(undefined), null);
});

test('a default pinned to a model with no row is named by its wire id, not «Default (recommended)»', () => {
  const view = deriveRunPick({
    models: [
      { id: 'default', name: 'Default (recommended)', resolved: 'claude-opus-4-8' },
      { id: 'opus', name: 'Opus 5.5', resolved: 'claude-opus-5-5' },
    ],
    fromRuntime: true,
    model: '',
    effort: '',
  });
  assert.equal(view.defaultName, 'Opus 4.8');
  assert.equal(view.activeLabel, 'Opus 4.8');
  const custom = deriveRunPick({
    models: [{ id: 'default', name: 'Default (recommended)', resolved: 'custom-model' }],
    fromRuntime: true,
    model: '',
    effort: '',
  });
  assert.equal(custom.defaultName, 'custom-model');
});

test('Codex and OpenCode lists never mix, and Codex keeps its account row', () => {
  const listed = [
    { id: 'default', resolved: 'gpt-5.6-sol' },
    { id: 'gpt-5.6-sol', resolved: 'gpt-5.6-sol' },
    { id: 'pool-go/glm-5.3', resolved: 'pool-go/glm-5.3' },
    { id: 'pool-go/kimi-k3', resolved: 'pool-go/kimi-k3' },
  ];
  assert.deepEqual(modelsForSide(listed, false).map((m) => m.id), ['default', 'gpt-5.6-sol']);
  assert.deepEqual(modelsForSide(listed, true).map((m) => m.id), ['pool-go/glm-5.3', 'pool-go/kimi-k3']);
  assert.equal(isGoModel('pool-go/kimi-k3'), true);
  assert.equal(isGoModel('gpt-5.6-sol'), false);
  assert.equal(isGoModel(undefined), false);
});

test('an OpenCode start always names a listed Go model', () => {
  const rows = [
    { id: 'gpt-5.6-sol' },
    { id: 'pool-go/kimi-k3' },
    { id: 'pool-go/glm-5.3' },
  ];
  assert.equal(goModelOrDefault(rows, 'pool-go/kimi-k3'), 'pool-go/kimi-k3');
  assert.equal(goModelOrDefault(rows, undefined), 'pool-go/glm-5.3');
  assert.equal(goModelOrDefault(rows, 'gpt-5.6-sol'), 'pool-go/glm-5.3');
  assert.equal(goModelOrDefault(rows, 'pool-go/gone'), 'pool-go/glm-5.3');
  assert.equal(goModelOrDefault([{ id: 'pool-go/kimi-k3' }], undefined), 'pool-go/kimi-k3');
  assert.equal(goModelOrDefault([{ id: 'gpt-5.6-sol' }], undefined), undefined);
});
