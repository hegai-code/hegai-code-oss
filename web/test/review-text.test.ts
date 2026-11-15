import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewMessage } from '../src/components/review/reviewText.js';
import { defaultBranchName } from '../src/components/StartWorktree.js';

test('a review is one message: header with the branch, one bullet per note', () => {
  const text = buildReviewMessage('agent/fix-1030', [
    { id: '1', path: 'src/a.ts', line: 12, code: '  const x = `y`;', text: 'rename x' },
    { id: '2', path: 'src/b.ts', line: 3, removed: true, code: 'old()', text: 'why removed?\nrestore it' },
  ]);
  assert.equal(
    text,
    [
      'Ревью изменений (agent/fix-1030):',
      "- src/a.ts:12 — `const x = 'y';` — rename x",
      '- src/b.ts:3 (удалённая строка) — `old()` — why removed?\n  restore it',
    ].join('\n'),
  );
});

test('default branch name: latin slug of the task plus the date', () => {
  const d = new Date(2026, 9, 30);
  assert.equal(defaultBranchName('Починить логин на мобильном!', d), 'agent/pochinit-login-na-1030');
  assert.equal(defaultBranchName('', d), 'agent/task-1030');
});
