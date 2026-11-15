import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord, stripHarnessNoise } from '../src/history.js';

// Shapes taken from a real ~/.claude/projects/**/*.jsonl — the harness injects
// these blocks into the turn text it sends the model, and they used to reach
// the reader verbatim.
const record = (type: string, content: unknown, uuid = 'u1') =>
  ({ type, uuid, message: { content } }) as unknown;

test('harness blocks are stripped, surrounding prose survives', () => {
  const text = 'сделай ревью\n<system-reminder>\nThis is a reminder.\n</system-reminder>\nи потом задеплой';
  assert.equal(stripHarnessNoise(text), 'сделай ревью\n\nи потом задеплой');
});

test('a turn that is only harness noise produces no message at all', () => {
  const only = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>';
  assert.equal(stripHarnessNoise(only), '');
  assert.equal(parseRecord(record('user', [{ type: 'text', text: only }])), null);
});

test('every wrapper the CLI injects is covered', () => {
  for (const tag of [
    'task-notification',
    'system-reminder',
    'local-command-stdout',
    'local-command-caveat',
    'command-name',
    'command-message',
    'command-args',
  ]) {
    assert.equal(stripHarnessNoise(`<${tag}>noise</${tag}>`), '', tag);
  }
});

test('text that merely contains angle brackets is untouched', () => {
  const prose = 'use <div> and a < b comparison';
  assert.equal(stripHarnessNoise(prose), prose);
});

test('empty thinking and empty tool results do not become empty boxes', () => {
  assert.equal(parseRecord(record('assistant', [{ type: 'thinking', thinking: '   ' }])), null);
  assert.equal(parseRecord(record('user', [{ type: 'tool_result', tool_use_id: 't1', content: '' }])), null);
  // An empty result that FAILED still matters — the error is the signal.
  const errored = parseRecord(record('user', [{ type: 'tool_result', tool_use_id: 't1', content: '', is_error: true }]));
  assert.equal(errored?.blocks.length, 1);
});

test('system records are not conversation', () => {
  assert.equal(parseRecord(record('system', [{ type: 'text', text: 'hook fired' }])), null);
});

test('a real turn still comes through', () => {
  const msg = parseRecord(record('assistant', [{ type: 'text', text: 'готово' }]));
  assert.equal(msg?.blocks.length, 1);
  assert.deepEqual(msg?.blocks[0], { kind: 'text', text: 'готово' });
});

test('the CLI\'s own «[Image: source: …]» notes and isMeta injections are not the person\'s turns', () => {
  const marker = '[Image: source: /tmp/agents-0/-srv-remotehegai/2622855b/images/8.png]';
  // Flagged, as the CLI writes it beside a pasted picture.
  assert.equal(
    parseRecord({ type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: marker }] } }),
    null,
  );
  // A skill body injected as a user record is meta too.
  assert.equal(
    parseRecord({ type: 'user', uuid: 'm2', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /x' } }),
    null,
  );
  // Unflagged marker-only text (older CLIs) is dropped by shape.
  assert.equal(
    parseRecord({ type: 'user', uuid: 'm3', message: { role: 'user', content: [{ type: 'text', text: `${marker}\n${marker}` }] } }),
    null,
  );
  // A real message that merely MENTIONS a path stays.
  const real = parseRecord({ type: 'user', uuid: 'm4', message: { role: 'user', content: [{ type: 'text', text: `смотри ${marker}` }] } });
  assert.ok(real && real.blocks.some((b) => b.kind === 'text'));
});

test('a picture inside a tool result is a marker, not its base64', () => {
  // `Read` of an image returns it inline; stringified, 99 of them were 58 MB
  // of «result» text and froze the session's replica (24.10.2026).
  const data = 'A'.repeat(400 * 1024);
  const parsed = parseRecord(
    record('user', [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [
          { type: 'text', text: 'кадр 3' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
        ],
      },
    ]),
  );
  const block = parsed?.blocks[0];
  assert.equal(block?.kind, 'tool_result');
  if (block?.kind !== 'tool_result') return;
  assert.equal(block.text, 'кадр 3\n[image image/jpeg, 300 KB]');
});
