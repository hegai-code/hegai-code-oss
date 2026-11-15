import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import {
  MAX_TITLE_LENGTH,
  dropSessionTitle,
  resetSessionTitleCache,
  sessionTitle,
  setSessionTitle,
} from '../src/session-titles.js';
import { deleteCodexSession } from '../src/codex.js';

/**
 * Renaming a Codex session: there is no title in the rollout to write, so the
 * agent keeps one. These tests pin the two things that made the old behaviour a
 * user-visible bug — a rename that silently did nothing, and a delete that left
 * the session behind.
 */

async function tempStore(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ccr-titles-'));
  process.env['CC_REMOTE_STATE_DIR'] = dir;
  resetSessionTitleCache();
  test.after(() => {
    delete process.env['CC_REMOTE_STATE_DIR'];
    resetSessionTitleCache();
    return rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('a stored title survives a cold read', async () => {
  await tempStore();
  setSessionTitle('01a08f7f-0b5c-78d1-be55-7cc8d658504d', 'Гайд по Дубаю');
  resetSessionTitleCache(); // as if the agent restarted
  assert.equal(sessionTitle('01a08f7f-0b5c-78d1-be55-7cc8d658504d'), 'Гайд по Дубаю');
});

test('an unknown session has no title, and dropping it is a no-op', async () => {
  await tempStore();
  assert.equal(sessionTitle('nope'), undefined);
  assert.doesNotThrow(() => dropSessionTitle('nope'));
});

test('titles are trimmed, capped, and never empty', async () => {
  await tempStore();
  assert.equal(setSessionTitle('a', '  spaced  '), 'spaced');
  const long = 'x'.repeat(MAX_TITLE_LENGTH + 50);
  assert.equal(setSessionTitle('b', long).length, MAX_TITLE_LENGTH);
  assert.throws(() => setSessionTitle('c', '   '), /empty/);
  assert.equal(sessionTitle('c'), undefined);
});

test('dropping a title forgets it on disk, not just in memory', async () => {
  await tempStore();
  setSessionTitle('gone', 'Deleted session');
  dropSessionTitle('gone');
  resetSessionTitleCache();
  assert.equal(sessionTitle('gone'), undefined);
});

test('a corrupt store degrades to "no custom titles", never throws', async () => {
  const dir = await tempStore();
  await writeFile(path.join(dir, 'session-titles.json'), '{ this is not json', 'utf8');
  resetSessionTitleCache();
  assert.equal(sessionTitle('anything'), undefined);
  // and it heals on the next write
  assert.equal(setSessionTitle('fresh', 'Works'), 'Works');
  resetSessionTitleCache();
  assert.equal(sessionTitle('fresh'), 'Works');
});

test('deleting a Codex session moves every rollout carrying that id to trash', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ccr-codex-'));
  test.after(() => rm(home, { recursive: true, force: true }));
  const day = path.join(home, 'sessions', '2026', '09', '14');
  await mkdir(day, { recursive: true });

  const id = '01a08f7f-0b5c-78d1-be55-7cc8d658504d';
  // Codex can leave more than one rollout per thread; both must go, or the
  // next inventory scan resurrects the session.
  const files = [
    path.join(day, `rollout-2026-09-14T10-00-00-${id}.jsonl`),
    path.join(day, `rollout-2026-09-14T12-00-00-${id}.jsonl`),
  ];
  for (const f of files) await writeFile(f, '{"type":"session_meta"}\n', 'utf8');
  const keep = path.join(day, 'rollout-2026-09-14T09-00-00-019ec5f6-d313-7773-ab6f-cc7cfa92746e.jsonl');
  await writeFile(keep, '{"type":"session_meta"}\n', 'utf8');

  const trash = path.join(home, 'trash');
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = home;
  try {
    const result = await deleteCodexSession(id, trash);
    assert.equal(result.removed, 2);
    assert.deepEqual(await readdir(day), [path.basename(keep)]);
    const trashed = await readdir(trash);
    assert.equal(trashed.length, 2);
    assert.equal(await readFile(path.join(trash, trashed[0]!), 'utf8'), '{"type":"session_meta"}\n');

    // Second delete of the same id: nothing left to move, and the caller hears
    // about it instead of getting a cheerful { ok: true }.
    await assert.rejects(() => deleteCodexSession(id, trash), /no Codex rollout found/);
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
  }
});
