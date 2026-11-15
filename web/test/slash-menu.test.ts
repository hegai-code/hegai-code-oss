import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCommands, slashQuery } from '../src/components/SlashMenu.js';

test('the menu is open only while the field is a bare command', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/ras'), 'ras');
  assert.equal(slashQuery('/raskatai now'), null);
  assert.equal(slashQuery('hi /x'), null);
  assert.equal(slashQuery(''), null);
});

test('prefix matches come first, then names and descriptions containing it', () => {
  const list = [
    { name: 'review' },
    { name: 'code-review' },
    { name: 'raskatai', description: 'Ship and review the live url' },
    { name: 'research' },
  ];
  assert.deepEqual(
    filterCommands(list, 're').map((c) => c.name),
    ['review', 'research', 'code-review', 'raskatai'],
  );
  assert.deepEqual(filterCommands(list, 'REV').map((c) => c.name), ['review', 'code-review', 'raskatai']);
  assert.equal(filterCommands(list, '').length, 4);
});
