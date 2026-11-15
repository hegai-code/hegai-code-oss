import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESS_NOISE_RE, stripHarnessNoise } from '../src/transcript-text.js';

test('the harness envelope is cut out, the prose around it stays', () => {
  // tgbot/test/render.test.ts
  assert.equal(stripHarnessNoise('Готово.<system-reminder>секрет</system-reminder>'), 'Готово.');
  assert.equal(stripHarnessNoise('<task-notification>шум</task-notification>'), '');
  // web/test/subagents.test.ts: multi-line body
  assert.equal(
    stripHarnessNoise(
      '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>',
    ),
    '',
  );
});

test('every wrapper tag is recognised, each closed by its own tag', () => {
  for (const tag of [
    'task-notification',
    'system-reminder',
    'local-command-stdout',
    'local-command-caveat',
    'command-name',
    'command-message',
    'command-args',
  ]) {
    assert.equal(stripHarnessNoise(`до <${tag}>x\ny</${tag}> после`), 'до  после', tag);
  }
  // A mismatched closer is not an envelope.
  assert.equal(stripHarnessNoise('<system-reminder>x</command-name>'), '<system-reminder>x</command-name>');
  // Unknown tags are the person's text.
  assert.equal(stripHarnessNoise('<b>жирный</b>'), '<b>жирный</b>');
});

test('text without a "<" is returned as is, with one it is trimmed', () => {
  assert.equal(stripHarnessNoise('  привет \n'), '  привет \n');
  assert.equal(stripHarnessNoise('  a < b \n'), 'a < b');
});

test('the regex source is pinned (web and bot relied on these exact bytes)', () => {
  assert.equal(
    HARNESS_NOISE_RE.source,
    '<(task-notification|system-reminder|local-command-stdout|local-command-caveat|command-name|command-message|command-args)>[\\s\\S]*?<\\/\\1>',
  );
  assert.equal(HARNESS_NOISE_RE.flags, 'g');
});
