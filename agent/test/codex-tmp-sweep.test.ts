import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { sweepCodexTmp } from '../src/codex-usage.js';

test('sweepCodexTmp removes only stale git-* clones', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codexhome-'));
  const tmp = path.join(home, '.tmp');
  await mkdir(path.join(tmp, 'git-old1', 'objects'), { recursive: true });
  await mkdir(path.join(tmp, 'git-fresh'), { recursive: true });
  await mkdir(path.join(tmp, 'plugins-clone-X'), { recursive: true });
  await writeFile(path.join(tmp, 'plugins.sha'), 'x');
  const old = new Date(Date.now() - 60 * 60_000);
  await utimes(path.join(tmp, 'git-old1'), old, old);
  await utimes(path.join(tmp, 'plugins-clone-X'), old, old);
  assert.equal(await sweepCodexTmp(home), 1);
  assert.deepEqual((await readdir(tmp)).sort(), ['git-fresh', 'plugins-clone-X', 'plugins.sha']);
  assert.equal(await sweepCodexTmp(path.join(home, 'missing')), 0);
  await rm(home, { recursive: true, force: true });
});
