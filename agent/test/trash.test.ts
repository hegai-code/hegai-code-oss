import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync, readdirSync } from 'node:fs';
import { moveToTrash, sweepTrash } from '../src/trash.js';

/**
 * The trash is the entire recovery story for this product: nothing here is ever
 * unlinked, it is moved. Both tests below are for ways that promise was void.
 */

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ccr-trash-'));
}

test('retention counts from when it was TRASHED, not when it was last edited', async () => {
  const work = scratch();
  const bin = path.join(scratch(), 'trash');
  const file = path.join(work, 'old-notes.md');
  writeFileSync(file, 'a year of notes');
  // Last edited long ago — the common case for anything worth keeping.
  const ancient = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  utimesSync(file, ancient, ancient);

  const movedTo = await moveToTrash(file, bin);
  // `rename` preserves mtime, so sweeping by mtime deleted this on the very
  // next pass — the 14-day window existed only for recently-edited files.
  const removed = await sweepTrash(bin, 14);
  assert.equal(removed, 0, 'a just-deleted file must survive the sweep');
  assert.ok(existsSync(movedTo));
  assert.equal(readFileSync(movedTo, 'utf8'), 'a year of notes');
});

test('an entry past the window is swept', async () => {
  const work = scratch();
  const bin = path.join(scratch(), 'trash');
  writeFileSync(path.join(work, 'junk.txt'), 'x');
  const movedTo = await moveToTrash(path.join(work, 'junk.txt'), bin);
  // Zero-day retention: everything already in the trash is past the window.
  const removed = await sweepTrash(bin, 0);
  assert.equal(removed, 1);
  assert.ok(!existsSync(movedTo));
});

test('two files with one name, deleted together, both stay recoverable', async () => {
  const a = scratch();
  const b = scratch();
  const bin = path.join(scratch(), 'trash');
  writeFileSync(path.join(a, 'report.pdf'), 'from A');
  writeFileSync(path.join(b, 'report.pdf'), 'from B');

  // Same basename, same millisecond: the destination used to be identical and
  // POSIX rename overwrote the first one's only copy.
  const [first, second] = await Promise.all([
    moveToTrash(path.join(a, 'report.pdf'), bin),
    moveToTrash(path.join(b, 'report.pdf'), bin),
  ]);
  assert.notEqual(first, second);
  assert.equal(readdirSync(bin).length, 2);
  const bodies = [readFileSync(first, 'utf8'), readFileSync(second, 'utf8')].sort();
  assert.deepEqual(bodies, ['from A', 'from B']);
});
