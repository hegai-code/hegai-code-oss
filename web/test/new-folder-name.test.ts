import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderNameError, shareRootFor } from '../src/components/NewFolderPanel.js';

test('folderNameError mirrors the hub rule for a member folder', () => {
  for (const ok of ['отчёт', 'a b', 'x'.repeat(64), 'v1.2']) assert.equal(folderNameError(ok), '', ok);
  for (const bad of ['a/b', 'a\\b', '..', '.', '.hidden', 'c:', ' x', 'x ', 'x'.repeat(65), 'a\nb']) {
    assert.notEqual(folderNameError(bad), '', JSON.stringify(bad));
  }
  assert.equal(folderNameError(''), '');
});

test('shareRootFor picks the deepest shared root that contains the project, or none', () => {
  assert.equal(shareRootFor('/srv/share/app', ['/srv/share', '/srv/other']), '/srv/share');
  assert.equal(shareRootFor('/srv/share/', ['/srv/share']), '/srv/share');
  assert.equal(shareRootFor('/srv/share/a/b', ['/srv/share', '/srv/share/a']), '/srv/share/a');
  assert.equal(shareRootFor('/srv/shared', ['/srv/share']), undefined);
  assert.equal(shareRootFor('/home/x', ['/srv/share']), undefined);
  assert.equal(shareRootFor('C:\\Work\\App', ['c:/work']), 'c:/work');
});
