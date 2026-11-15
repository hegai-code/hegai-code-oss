import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fsPeek, openedPath } from '../src/fs-peek.js';
import { open as openFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';

/**
 * `fs.peek` reaches one place outside the project — the system temp tree, by a
 * path the request names — so these tests are mostly about everything it must
 * still refuse. Projects and "elsewhere" live OUTSIDE temp (under this test
 * folder), or every refusal below would pass for the wrong reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// Not under temp even when the checkout is (a CI workspace in /tmp): then home.
const tmpRoots = [os.tmpdir(), '/tmp'].map((t) => realpathSync(t));
const underTmp = (p: string) => tmpRoots.some((t) => realpathSync(p).startsWith(t + path.sep));
const outsideRoot = mkdtempSync(path.join(underTmp(here) ? os.homedir() : here, '.peek-'));
after(() => rmSync(outsideRoot, { recursive: true, force: true }));

/** A directory outside any temp tree. */
function elsewhere(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(outsideRoot, prefix)));
}
/** A directory inside the system temp tree. */
function inTmp(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('an image inside the project is served, by absolute or relative path', async () => {
  const root = elsewhere('root-');
  mkdirSync(path.join(root, 'shots'));
  writeFileSync(path.join(root, 'shots', 'a.png'), Buffer.from([1, 2, 3]));
  const rel = await fsPeek(root, 'shots/a.png');
  assert.equal(Buffer.from(rel.data, 'base64').length, 3);
  assert.equal(rel.eof, true);
  assert.equal(rel.path, 'shots/a.png');
  const abs = await fsPeek(root, path.join(root, 'shots', 'a.png'));
  assert.equal(abs.size, 3);
});

test('a named temp file is served — scratchpad or anywhere else in /tmp', async () => {
  const root = elsewhere('root-');
  const tmp = inTmp('ccr-peek-');
  mkdirSync(path.join(tmp, 'claude-0', 'live2'), { recursive: true });
  const file = path.join(tmp, 'claude-0', 'live2', 'frames.png');
  writeFileSync(file, Buffer.from('png-bytes'));
  const r = await fsPeek(root, file);
  assert.equal(Buffer.from(r.data, 'base64').toString(), 'png-bytes');
  assert.equal(r.path, file);
  rmSync(tmp, { recursive: true, force: true });
});

test('anything that is not an image or markdown is refused, even inside the project', async () => {
  const root = elsewhere('root-');
  writeFileSync(path.join(root, '.env'), 'SECRET=1');
  writeFileSync(path.join(root, 'notes.txt'), 'hi');
  await assert.rejects(() => fsPeek(root, '.env'), /only images and markdown/);
  await assert.rejects(() => fsPeek(root, 'notes.txt'), /only images and markdown/);
});

test('a .png symlink to a non-image is refused', async () => {
  const root = elsewhere('root-');
  writeFileSync(path.join(root, 'key'), 'private');
  symlinkSync(path.join(root, 'key'), path.join(root, 'shot.png'));
  await assert.rejects(() => fsPeek(root, 'shot.png'), /only images and markdown/);
});

test('a temp link leading out of temp is refused', async () => {
  const root = elsewhere('root-');
  const out = elsewhere('out-');
  writeFileSync(path.join(out, 'secret.png'), 'x');
  const tmp = inTmp('ccr-peek-');
  symlinkSync(path.join(out, 'secret.png'), path.join(tmp, 'shot.png'));
  await assert.rejects(() => fsPeek(root, path.join(tmp, 'shot.png')), /outside this project/);
  rmSync(tmp, { recursive: true, force: true });
});

test('a link inside the project does not lead into temp', async () => {
  const root = elsewhere('root-');
  const tmp = inTmp('ccr-peek-');
  writeFileSync(path.join(tmp, 'private.png'), 'x');
  symlinkSync(tmp, path.join(root, 'link'));
  await assert.rejects(() => fsPeek(root, 'link/private.png'), /outside this project/);
  await assert.rejects(() => fsPeek(root, path.join(root, 'link', 'private.png')), /outside this project/);
  // Named directly, the same file is served.
  const r = await fsPeek(root, path.join(tmp, 'private.png'));
  assert.equal(r.size, 1);
  rmSync(tmp, { recursive: true, force: true });
});

test('an arbitrary absolute path outside project and temp is refused', async () => {
  const root = elsewhere('root-');
  const out = elsewhere('out-');
  writeFileSync(path.join(out, 'a.md'), '# hi');
  await assert.rejects(() => fsPeek(root, path.join(out, 'a.md')), /outside this project/);
  await assert.rejects(() => fsPeek(root, '../' + path.basename(out) + '/a.md'), /outside this project/);
});

test('a missing file says so', async () => {
  const root = elsewhere('root-');
  await assert.rejects(() => fsPeek(root, 'nope.md'), /file not found/);
});

test('a project under /tmp: a link inside it still may not reach other temp files', async () => {
  const shared = inTmp('ccr-peek-shared-');
  const priv = inTmp('ccr-peek-private-');
  writeFileSync(path.join(priv, 'secret.md'), '# private');
  symlinkSync(priv, path.join(shared, 'leak'));
  await assert.rejects(() => fsPeek(shared, 'leak/secret.md'), /outside this project/);
  await assert.rejects(() => fsPeek(shared, path.join(shared, 'leak', 'secret.md')), /outside this project/);
  rmSync(shared, { recursive: true, force: true });
  rmSync(priv, { recursive: true, force: true });
});

test('the opened descriptor is judged, not the path checked before it', async () => {
  // The race itself cannot be timed in a test; what makes it harmless can:
  // after a parent is swapped for a link, the descriptor still names where the
  // file really was, and a fresh resolution of the old path names somewhere else.
  const tmp = inTmp('ccr-peek-swap-');
  mkdirSync(path.join(tmp, 'job'));
  writeFileSync(path.join(tmp, 'job', 'frame.md'), '# real');
  const out = elsewhere('swap-out-');
  writeFileSync(path.join(out, 'frame.md'), '# outside');
  const fh = await openFile(path.join(tmp, 'job', 'frame.md'), 'r');
  try {
    renameSync(path.join(tmp, 'job'), path.join(tmp, 'job-moved'));
    symlinkSync(out, path.join(tmp, 'job'));
    const opened = await openedPath(fh.fd, path.join(tmp, 'job', 'frame.md'));
    // Linux: the descriptor's own path (moved, still in temp). Elsewhere: the
    // inode check refuses, because `real` now resolves outside.
    if (opened !== null) assert.equal(opened, path.join(tmp, 'job-moved', 'frame.md'));
  } finally {
    await fh.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
