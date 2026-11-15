import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headIndicatesSidechain } from '../src/sessions.js';

// Shapes taken from real ~/.claude/projects/**/*.jsonl transcripts: a Task
// sub-agent thread stamps `isSidechain: true` on its records; a human session
// carries `isSidechain: false` (or nothing at all on old files).

test('a sub-agent transcript head is recognized', () => {
  const head = [
    JSON.stringify({ type: 'user', isSidechain: true, cwd: '/w', message: { content: 'find the bug' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [] } }),
  ].join('\n');
  assert.equal(headIndicatesSidechain(head), true);
});

test('a human session head is not', () => {
  const head = [
    JSON.stringify({ type: 'user', isSidechain: false, cwd: '/w', message: { content: 'привет' } }),
  ].join('\n');
  assert.equal(headIndicatesSidechain(head), false);
});

test('legacy records without the flag are not sidechains', () => {
  const head = JSON.stringify({ type: 'user', cwd: '/w', message: { content: 'hi' } });
  assert.equal(headIndicatesSidechain(head), false);
});

test('a partial first line does not break detection', () => {
  const head = '{"type":"user","isSide' + '\n' +
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [] } });
  assert.equal(headIndicatesSidechain(head), true);
});

test('the verdict comes from the first parseable line only', () => {
  // A human session whose LATER records mention sidechains in text must not flip.
  const head = [
    JSON.stringify({ type: 'user', isSidechain: false, message: { content: 'x' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [] } }),
  ].join('\n');
  assert.equal(headIndicatesSidechain(head), false);
});
