import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headIsBackground } from '../src/sessions.js';

// Shape of a real `claude --bg` transcript head (CLI 2.1.314): bookkeeping
// records first, then the first conversation record carrying `sessionKind`.
const title = JSON.stringify({ type: 'custom-title', customTitle: 'email-templates', sessionId: 's' });
const turn = (extra: object) =>
  JSON.stringify({ type: 'user', isSidechain: false, entrypoint: 'cli', cwd: '/srv/x', sessionId: 's', ...extra });

test('a native background session (claude --bg) is recognised from its head', () => {
  assert.equal(headIsBackground([title, turn({ sessionKind: 'bg' })].join('\n')), true);
});

test('a terminal session with the same entrypoint is not', () => {
  assert.equal(headIsBackground([title, turn({})].join('\n')), false);
  assert.equal(headIsBackground(title), false);
});
