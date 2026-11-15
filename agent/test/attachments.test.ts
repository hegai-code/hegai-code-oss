import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { AttachmentStore, safeName } from '../src/attachments.js';

/**
 * The filename is the attacker-controlled part of an attachment: it comes from a
 * browser, and in a shared workspace the person sending it is not necessarily
 * the person whose machine writes it. Everything here is about that.
 */

test('a filename can never escape the scratch directory', () => {
  assert.equal(safeName('../../.ssh/authorized_keys'), 'authorized_keys');
  assert.equal(safeName('/etc/passwd'), 'passwd');
  assert.equal(safeName('..\\..\\windows\\system32\\drivers\\etc\\hosts'), 'hosts');
  // A Windows drive prefix is a path segment, so the split removes it outright.
  assert.equal(safeName('C:\\secrets.txt'), 'secrets.txt');
  // Drive-RELATIVE has no separator to split on, so the colon is neutralised.
  assert.equal(safeName('C:secrets.txt'), 'C_secrets.txt');
  // A name that is nothing BUT traversal leaves nothing behind, so it still has
  // to come out as a usable filename rather than an empty string.
  assert.equal(safeName('../..'), 'attachment');
  assert.equal(safeName('...'), 'attachment');
  assert.equal(safeName(''), 'attachment');
});

test('a leading dot never survives — an attachment is not a dotfile', () => {
  assert.equal(safeName('.bashrc'), 'bashrc');
  assert.equal(safeName('.env'), 'env');
});

test('ordinary names, including Cyrillic ones, are left readable', () => {
  assert.equal(safeName('Q3-budget (final).xlsx'), 'Q3-budget (final).xlsx');
  assert.equal(safeName('отчёт_2026.pdf'), 'отчёт_2026.pdf');
  assert.equal(safeName('report.tar.gz'), 'report.tar.gz');
});

test('a very long name is bounded', () => {
  assert.ok(safeName(`${'x'.repeat(400)}.pdf`).length <= 120);
});

test('files land on disk and the turn is told where they are', () => {
  const store = new AttachmentStore();
  const note = store.materialize([
    { name: 'notes.txt', data: Buffer.from('hello').toString('base64') },
    { name: '../../escape.txt', data: Buffer.from('nope').toString('base64') },
  ]);

  const paths = [...note.matchAll(/^- (.+)$/gm)].map((m) => m[1]!);
  assert.equal(paths.length, 2, 'both files are named in the note');
  assert.equal(readFileSync(paths[0]!, 'utf8'), 'hello');
  assert.equal(readFileSync(paths[1]!, 'utf8'), 'nope');
  // The traversal attempt landed beside the other file, not two levels up.
  assert.equal(path.dirname(paths[0]!), path.dirname(paths[1]!));
  assert.equal(path.basename(paths[1]!), 'escape.txt');
  assert.ok(path.dirname(paths[0]!).startsWith(os.tmpdir()));

  store.cleanup();
  assert.ok(!existsSync(paths[0]!), 'cleanup takes the scratch dir with it');
});

test('two attachments with the same name do not overwrite each other', () => {
  const store = new AttachmentStore();
  const note = store.materialize([
    { name: 'a.txt', data: Buffer.from('first').toString('base64') },
    { name: 'a.txt', data: Buffer.from('second').toString('base64') },
  ]);
  const paths = [...note.matchAll(/^- (.+)$/gm)].map((m) => m[1]!);
  assert.equal(readdirSync(path.dirname(paths[0]!)).length, 2);
  assert.equal(path.basename(paths[0]!), 'a.txt');
  assert.equal(path.basename(paths[1]!), 'a-1.txt', 'only the collision is renamed');
  assert.equal(readFileSync(paths[0]!, 'utf8'), 'first');
  assert.equal(readFileSync(paths[1]!, 'utf8'), 'second');
  store.cleanup();
});

test('no attachments means no note at all, so plain turns are untouched', () => {
  const store = new AttachmentStore();
  assert.equal(store.materialize(undefined), '');
  assert.equal(store.materialize([]), '');
  // And nothing was created just by asking.
  assert.doesNotThrow(() => store.cleanup());
});
