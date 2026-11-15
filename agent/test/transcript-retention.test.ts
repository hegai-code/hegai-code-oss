import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTranscriptRetention, RETENTION_DAYS, retainedSettings } from '../src/transcript-retention.js';

/**
 * The agent writes `cleanupPeriodDays` so Claude Code stops deleting
 * transcripts after 30 days. What must hold: only that key changes, a file it
 * cannot parse is left alone, and `0` (which means "delete everything") is
 * overridden.
 */

test('a missing or empty file gets just the retention key', () => {
  for (const raw of [undefined, '', '  \n']) {
    const next = retainedSettings(raw);
    assert.ok(next?.changed);
    assert.deepEqual(JSON.parse(next.text), { cleanupPeriodDays: RETENTION_DAYS });
  }
});

test('other keys are kept as they are, in order', () => {
  const raw = JSON.stringify({ permissions: { deny: ['Read(/x)'] }, model: 'opus', env: { A: '1' } });
  const next = retainedSettings(raw);
  assert.ok(next?.changed);
  const out = JSON.parse(next.text);
  assert.deepEqual(Object.keys(out), ['permissions', 'model', 'env', 'cleanupPeriodDays']);
  assert.deepEqual(out.permissions, { deny: ['Read(/x)'] });
  assert.equal(out.cleanupPeriodDays, RETENTION_DAYS);
});

test('zero and small values are overridden, a larger one is kept byte for byte', () => {
  for (const v of [0, 30, 365, null, '99999']) {
    const next = retainedSettings(JSON.stringify({ cleanupPeriodDays: v }));
    assert.equal(JSON.parse(next!.text).cleanupPeriodDays, RETENTION_DAYS, `value ${String(v)}`);
  }
  const big = '{ "cleanupPeriodDays": 99999 }';
  assert.deepEqual(retainedSettings(big), { text: big, changed: false });
});

test('a file that is not a JSON object is never rewritten', () => {
  for (const raw of ['{ broken', '[1,2]', '"text"', '42', 'null']) {
    assert.equal(retainedSettings(raw), null, raw);
  }
});

test('on disk: mode kept, symlink written through, second run is a no-op', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retention-'));
  const real = path.join(dir, 'real.json');
  const link = path.join(dir, 'settings.json');
  writeFileSync(real, '{"model":"opus"}', { mode: 0o640 });
  symlinkSync(real, link);
  assert.equal(ensureTranscriptRetention(link), 'written');
  assert.equal(statSync(real).mode & 0o777, 0o640);
  assert.ok(statSync(link).isFile());
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), { model: 'opus', cleanupPeriodDays: RETENTION_DAYS });
  assert.equal(ensureTranscriptRetention(link), 'unchanged');

  const fresh = path.join(dir, 'nested', 'settings.json');
  assert.equal(ensureTranscriptRetention(fresh), 'created');
  assert.equal(statSync(fresh).mode & 0o777, 0o600);

  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.equal(ensureTranscriptRetention(bad), 'skipped');
  assert.equal(readFileSync(bad, 'utf8'), '{ not json');

  const dangling = path.join(dir, 'dangling.json');
  symlinkSync(path.join(dir, 'not-mounted', 'settings.json'), dangling);
  assert.equal(ensureTranscriptRetention(dangling), 'skipped');
  assert.ok(lstatSync(dangling).isSymbolicLink(), 'the link itself is kept');
});
