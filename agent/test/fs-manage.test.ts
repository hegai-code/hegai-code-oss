import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { fsMkdir, fsRename, fsTrash } from '../src/fs-manage.js';
import { assertMutable } from '../src/fs-ops.js';

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ccr-manage-'));
}

function isolate(): { root: string; trash: string } {
  const state = scratch();
  process.env['CC_REMOTE_STATE_DIR'] = state;
  return { root: scratch(), trash: path.join(state, 'trash') };
}

test('mkdir is recursive and idempotent — that is what makes a folder drop a loop', async () => {
  const { root } = isolate();
  const first = await fsMkdir(root, 'a/b/c');
  assert.equal(first.created, true);
  assert.ok(existsSync(path.join(root, 'a', 'b', 'c')));
  // A re-drop of the same folder must not be an error.
  const again = await fsMkdir(root, 'a/b/c');
  assert.equal(again.created, false);
});

test('mkdir with recursive:false makes one folder, refuses nested paths and existing entries', async () => {
  const { root } = isolate();
  const made = await fsMkdir(root, 'one', { recursive: false });
  assert.equal(made.created, true);
  assert.ok(existsSync(path.join(root, 'one')));
  await assert.rejects(() => fsMkdir(root, 'x/y', { recursive: false }), /ENOENT/);
  assert.ok(!existsSync(path.join(root, 'x')), 'no parent was created on the way');
  await assert.rejects(() => fsMkdir(root, 'one', { recursive: false }), /Папка с таким именем уже есть/);
  writeFileSync(path.join(root, 'f'), '');
  await assert.rejects(() => fsMkdir(root, 'f', { recursive: false }), /уже есть/);
  symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
  await assert.rejects(() => fsMkdir(root, 'dangling', { recursive: false }), /уже есть/);
});

test('rename refuses to clobber — a manager that overwrites loses work', async () => {
  const { root } = isolate();
  writeFileSync(path.join(root, 'a.txt'), 'first');
  writeFileSync(path.join(root, 'b.txt'), 'second');
  await assert.rejects(() => fsRename(root, 'a.txt', 'b.txt'), /already exists/);
  assert.equal(readFileSync(path.join(root, 'b.txt'), 'utf8'), 'second');
});

test('delete moves to the trash and never unlinks', async () => {
  const { root } = isolate();
  writeFileSync(path.join(root, 'doomed.txt'), 'still here');
  const r = await fsTrash(root, 'doomed.txt');
  assert.equal(r.ok, true);
  assert.ok(/[\\/]trash[\\/]/.test(r.movedTo), `expected a trash path, got ${r.movedTo}`);
  assert.ok(!existsSync(path.join(root, 'doomed.txt')));
  // The bytes are still recoverable — that is the whole point of a trash.
  assert.equal(readFileSync(r.movedTo, 'utf8'), 'still here');
});

test('the project root itself cannot be deleted', async () => {
  const { root } = isolate();
  await assert.rejects(() => fsTrash(root, '.'), /project root itself/);
});

/**
 * The single-writer invariant, reached through a file manager.
 *
 * Renaming or deleting a directory a session is working in is the file-level
 * version of two writers on one transcript: the session keeps writing into an
 * inode that is no longer where it thinks it is.
 */
test('a directory a live session is working in cannot be renamed or deleted', async () => {
  const { root } = isolate();
  const project = path.join(root, 'project');
  mkdirSync(path.join(project, 'src'), { recursive: true });
  const liveCwds = async (): Promise<string[]> => [project];

  await assert.rejects(() => fsTrash(root, 'project', { liveCwds }), /session is live/);
  await assert.rejects(() => fsRename(root, 'project', 'renamed', { liveCwds }), /session is live/);
  // A PARENT of the live cwd is just as fatal — it moves the session too.
  await assert.rejects(() => fsTrash(root, '.', { liveCwds }), /project root itself|session is live/);
});

/**
 * `~/.claude/sessions/<pid>.json` is how the agent knows an editor holds a
 * session. Deleting a stale-LOOKING one makes a live writer invisible, the hub
 * stops refusing `open`, and two writers land on one transcript.
 */
test('agent and credential state is refused outright, whatever the roots allow', () => {
  const home = os.homedir();
  assert.throws(() => assertMutable(path.join(home, '.claude', 'sessions', '1234.json')), /cannot be changed/);
  assert.throws(() => assertMutable(path.join(home, '.ssh', 'authorized_keys')), /cannot be changed/);
  assert.throws(() => assertMutable(path.join(home, '.codex', 'config.toml')), /cannot be changed/);
  // Inside a repository's .git, too: a write there corrupts the repo underneath
  // whatever session is using it.
  assert.throws(() => assertMutable('/tmp/proj/.git/HEAD'), /inside \.git/);
  // But an ordinary project path is fine, and so is a directory that merely
  // starts the same way.
  assert.doesNotThrow(() => assertMutable('/tmp/proj/src/index.ts'));
  assert.doesNotThrow(() => assertMutable('/tmp/proj/.github/workflows/ci.yml'));
});

/* --- находки независимого разбора Codex, каждая с воспроизведением --- */

test('trashing a symlink moves the LINK, not what it points at', async () => {
  const { root } = isolate();
  const outside = scratch();
  writeFileSync(path.join(outside, 'target.txt'), 'important');
  symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'link.txt'));

  const r = await fsTrash(root, 'link.txt');
  assert.equal(r.ok, true);
  // The target must be untouched — canonicalising the path meant the delete
  // hit a different file than the one on screen.
  assert.equal(readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'important');
  assert.ok(!existsSync(path.join(root, 'link.txt')));
});

test('renaming a symlink moves the LINK', async () => {
  const { root } = isolate();
  const outside = scratch();
  writeFileSync(path.join(outside, 'target.txt'), 'important');
  symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'link.txt'));

  await fsRename(root, 'link.txt', 'renamed.txt');
  assert.equal(readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'important');
  assert.ok(existsSync(path.join(outside, 'target.txt')));
});

test('a case-only rename actually renames instead of reporting success', async () => {
  const { root } = isolate();
  writeFileSync(path.join(root, 'Readme.md'), 'x');
  await fsRename(root, 'Readme.md', 'README.md');
  // On a case-insensitive filesystem both spellings `stat` fine, so the check
  // has to be the ACTUAL directory entry.
  const listed = readdirSync(root);
  assert.ok(listed.includes('README.md'), `directory holds ${JSON.stringify(listed)}`);
  assert.ok(!listed.includes('Readme.md'));
});

test('a move INTO a live session’s directory is refused', async () => {
  const { root } = isolate();
  mkdirSync(path.join(root, 'live'), { recursive: true });
  writeFileSync(path.join(root, 'thing.txt'), 'x');
  const liveCwds = async (): Promise<string[]> => [path.join(root, 'live')];
  // Only the SOURCE used to be checked, so this mutated a running session's
  // tree while claiming to protect it.
  await assert.rejects(
    () => fsRename(root, 'thing.txt', 'live/thing.txt', { liveCwds }),
    /session is live/,
  );
});
