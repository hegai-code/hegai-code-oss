import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { fsList, fsRead, fsWrite, fsDownload, resolveInRoot } from '../src/fs-ops.js';

/**
 * The file RPCs are the first thing in this product that lets a browser write
 * and read arbitrary bytes inside a project. Everything here is about the two
 * ways that goes wrong: a path that leaves the project, and a read that lies
 * about what it returned.
 */

function scratch(): string {
  // realpath: on macOS os.tmpdir() is itself a symlink (/var -> /private/var),
  // and a containment check that did not resolve it would fail on every test.
  return mkdtempSync(path.join(os.tmpdir(), 'ccr-fs-'));
}

test('a symlink pointing out of the project is refused, not followed', async () => {
  const root = scratch();
  const outside = scratch();
  writeFileSync(path.join(outside, 'secret.txt'), 'private');
  symlinkSync(outside, path.join(root, 'escape'));

  // The lexical guard alone would accept this: 'escape/secret.txt' never
  // contains '..'. Only resolving the link catches it.
  await assert.rejects(() => fsRead(root, 'escape/secret.txt'), /escapes working directory/);
  await assert.rejects(() => resolveInRoot(root, 'escape'), /escapes working directory/);
});

test('a symlink INSIDE the project still works', async () => {
  const root = scratch();
  mkdirSync(path.join(root, 'real'));
  writeFileSync(path.join(root, 'real', 'a.txt'), 'hello');
  symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));

  const r = await fsRead(root, 'alias/a.txt');
  assert.equal(r.content, 'hello');
});

test('a path that does not exist yet still resolves — uploads need that', async () => {
  const root = scratch();
  const target = await resolveInRoot(root, 'new/deep/file.bin');
  assert.ok(target.startsWith(root + path.sep) || target.includes(path.basename(root)));
  await assert.rejects(() => resolveInRoot(root, '../outside.bin'), /escapes working directory/);
});

test('a listing carries size and mtime, and marks symlinks', async () => {
  const root = scratch();
  writeFileSync(path.join(root, 'a.txt'), 'four');
  mkdirSync(path.join(root, 'sub'));
  symlinkSync(path.join(root, 'sub'), path.join(root, 'link-to-dir'));

  const { entries } = await fsList(root, '');
  const a = entries.find((e) => e.name === 'a.txt');
  assert.equal(a?.kind, 'file');
  assert.equal(a?.size, 4);
  assert.ok(typeof a?.mtime === 'number' && a.mtime > 0);
  // A directory carries no size: st_size of a directory is the inode's and
  // means nothing to a person reading a file list.
  assert.equal(entries.find((e) => e.name === 'sub')?.size, undefined);
  // A symlink to a directory reads as a directory — that is what clicking it
  // does — but is still flagged as a link.
  const link = entries.find((e) => e.name === 'link-to-dir');
  assert.equal(link?.kind, 'dir');
  assert.equal(link?.link, true);
});

test('nothing is hidden: a file manager that omits node_modules is lying', async () => {
  const root = scratch();
  mkdirSync(path.join(root, 'node_modules'));
  mkdirSync(path.join(root, '.git'));
  const names = (await fsList(root, '')).entries.map((e) => e.name);
  assert.ok(names.includes('node_modules'));
  assert.ok(names.includes('.git'));
});

test('a huge directory is capped and says so', async () => {
  const root = scratch();
  for (let i = 0; i < 2100; i += 1) writeFileSync(path.join(root, `f${String(i).padStart(5, '0')}`), '');
  const r = await fsList(root, '');
  assert.equal(r.entries.length, 2000);
  assert.equal(r.truncated, true);
  assert.equal(r.total, 2100);
});

test('a truncated read never cuts a character in half', async () => {
  const root = scratch();
  // 'я' is two bytes in UTF-8, so a 512KB window lands mid-letter for some
  // length — the case that used to produce a replacement character.
  const file = path.join(root, 'big.txt');
  writeFileSync(file, 'я'.repeat(400_000));
  const r = await fsRead(root, 'big.txt');
  assert.equal(r.truncated, true);
  assert.ok(!r.content.includes('�'), 'no replacement character at the seam');
  // Everything kept must round-trip: re-encoding is byte-identical to a prefix
  // of the file, which is only true if the cut respected character boundaries.
  const kept = Buffer.from(r.content, 'utf8');
  assert.deepEqual(kept, readFileSync(file).subarray(0, kept.length));
});

test('a short read is not marked truncated and is returned whole', async () => {
  const root = scratch();
  writeFileSync(path.join(root, 'small.txt'), 'привет');
  const r = await fsRead(root, 'small.txt');
  assert.equal(r.truncated, false);
  assert.equal(r.content, 'привет');
});

test('a write is atomic and leaves no .part behind', async () => {
  const root = scratch();
  await fsWrite(root, 'out.txt', 'содержимое');
  assert.equal(readFileSync(path.join(root, 'out.txt'), 'utf8'), 'содержимое');
  const leftovers = (await fsList(root, '')).entries.filter((e) => e.name.endsWith('.part'));
  assert.deepEqual(leftovers, []);
});

test('a write through a symlink is refused', async () => {
  const root = scratch();
  const outside = scratch();
  writeFileSync(path.join(outside, 'target.txt'), 'original');
  symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'inside.txt'));
  await assert.rejects(() => fsWrite(root, 'inside.txt', 'overwritten'), /symlink|escapes/);
  assert.equal(readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'original');
});

test('download returns exact bytes, window by window, and reports the whole size', async () => {
  const root = scratch();
  // Binary, deliberately: this is the path fs.read cannot serve.
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
  writeFileSync(path.join(root, 'blob.bin'), bytes);

  const first = await fsDownload(root, 'blob.bin', 0, 2000);
  assert.equal(first.bytes, 2000);
  assert.equal(first.size, 5000);
  assert.equal(first.eof, false);

  const rest: Buffer[] = [Buffer.from(first.data, 'base64')];
  let offset = first.bytes;
  for (;;) {
    const w = await fsDownload(root, 'blob.bin', offset, 2000);
    rest.push(Buffer.from(w.data, 'base64'));
    offset += w.bytes;
    if (w.eof) break;
  }
  assert.deepEqual(Buffer.concat(rest), bytes, 'the file round-trips byte for byte');
});

test('a text write obeys the same deny-list as delete and rename', async () => {
  const root = scratch();
  mkdirSync(path.join(root, '.git'), { recursive: true });
  // `fs.write` was the one mutating path that never consulted the deny-list, so
  // .git and the agent's own state were writable wherever they were reachable.
  await assert.rejects(() => fsWrite(root, '.git/config', 'x'), /\.git/);
});

test('a failed write leaves no scratch file behind', async () => {
  const root = scratch();
  // A directory where the file should be makes the rename fail after the
  // scratch file exists — the path that used to leak it permanently.
  mkdirSync(path.join(root, 'taken'), { recursive: true });
  await assert.rejects(() => fsWrite(root, 'taken', 'x'));
  const leftovers = readdirSync(root).filter((n) => n.endsWith('.part'));
  assert.deepEqual(leftovers, []);
});
