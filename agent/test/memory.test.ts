import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  memoryDirFor,
  normalizeRemote,
  projectSlug,
  readLocalMemoriesIn,
  safeMemoryPath,
  sha256Hex,
  writeMemoryIfAbsentIn,
  overwriteMemoryIn,
  quarantineMemoryIn,
  scopeOfFileName,
  syncStateKey,
  appendIndexEntry,
  indexPointerLine,
  frontmatter,
  INDEX_FILE,
} from '../src/memory.js';

const scratch = () => mkdtemp(path.join(os.tmpdir(), 'ccr-memory-'));

test('projectSlug reproduces Claude Code’s on-disk naming', () => {
  // Verified against real directories under ~/.claude/projects: both the path
  // separator AND the dot collapse to '-', which is why a dotfile directory
  // yields a doubled dash.
  assert.equal(projectSlug('/Users/devuser-0001/claudehegai'), '-Users-devuser-0001-claudehegai');
  assert.equal(
    projectSlug('/Users/devuser-0001/.claude/skills/product-manager'),
    '-Users-devuser-0001--claude-skills-product-manager',
  );
  // Case is preserved — lowercasing would point at a directory that isn't there.
  assert.equal(projectSlug('/Users/devuser-0001/VSCode/whisphegai'), '-Users-devuser-0001-VSCode-whisphegai');
  assert.ok(memoryDirFor('/tmp/x').endsWith(path.join('-tmp-x', 'memory')));
});

test('normalizeRemote gives SSH and HTTPS checkouts the same identity', () => {
  const want = 'github.com/me/repo';
  assert.equal(normalizeRemote('git@github.com:me/repo.git'), want);
  assert.equal(normalizeRemote('https://github.com/me/repo.git'), want);
  assert.equal(normalizeRemote('https://github.com/me/repo'), want);
  assert.equal(normalizeRemote('ssh://git@github.com/me/repo.git'), want);
  assert.equal(normalizeRemote('https://user:token@github.com/me/repo'), want);
  // Host case is noise; path case is not — repo names are case-sensitive.
  assert.equal(normalizeRemote('https://GitHub.com/me/repo'), want);
  assert.notEqual(normalizeRemote('git@github.com:me/Repo.git'), want);
  assert.equal(normalizeRemote(''), '');
});

test('safeMemoryPath refuses to leave the memory directory', () => {
  const dir = '/home/u/.claude/projects/-p/memory';
  assert.ok(safeMemoryPath(dir, 'note.md'));
  assert.ok(safeMemoryPath(dir, 'nested/note.md'));
  // The hub supplies these names over the network. Escaping here would let a
  // memory sync rewrite the operator's own instruction files.
  assert.equal(safeMemoryPath(dir, '../../../CLAUDE.md'), null);
  assert.equal(safeMemoryPath(dir, '/etc/passwd'), null);
  assert.equal(safeMemoryPath(dir, 'a/../../../b.md'), null);
  assert.equal(safeMemoryPath(dir, ''), null);
  assert.equal(safeMemoryPath(dir, 'note\0.md'), null);
  // A sibling directory sharing the prefix must not pass as "inside".
  assert.equal(safeMemoryPath('/home/u/mem', '../mem-other/x.md'), null);
});

test('a downloaded memory never overwrites what the machine already has', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, 'note.md'), 'written by the harness', 'utf8');

  // This is the core safety property: Claude Code writes these same files, so
  // the hub must only ever fill a gap. Overwriting would make the hub a second
  // writer racing the local one.
  assert.equal(await writeMemoryIfAbsentIn(dir, 'note.md', 'from the hub'), false);
  assert.equal(await readFile(path.join(dir, 'note.md'), 'utf8'), 'written by the harness');

  // A path the machine lacks is filled in, creating parents as needed.
  assert.equal(await writeMemoryIfAbsentIn(dir, 'fresh.md', 'from the hub'), true);
  assert.equal(await readFile(path.join(dir, 'fresh.md'), 'utf8'), 'from the hub');
  // ...and is then itself protected.
  assert.equal(await writeMemoryIfAbsentIn(dir, 'fresh.md', 'again'), false);

  // Traversal is refused at the write, not just at the resolve.
  assert.equal(await writeMemoryIfAbsentIn(dir, '../escaped.md', 'nope'), false);
});

test('readLocalMemoriesIn lists .md notes with stable order and hashes', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, 'b.md'), 'bee', 'utf8');
  await writeFile(path.join(dir, 'a.md'), 'ay', 'utf8');
  await writeFile(path.join(dir, 'ignored.txt'), 'not a memory', 'utf8');

  const got = await readLocalMemoriesIn(dir);
  assert.deepEqual(
    got.map((m) => m.path),
    ['a.md', 'b.md'],
    'sorted, and non-markdown is skipped',
  );
  assert.equal(got[0]?.sha256, sha256Hex('ay'));

  // A project this machine has never opened is empty, not an error.
  assert.deepEqual(await readLocalMemoriesIn(path.join(dir, 'nope')), []);
});

test('a file name declares its scope, so notes that are not about a repo have a home', () => {
  // There is no global memory directory — Claude Code only loads
  // projects/<slug>/memory — so fleet and machine notes live IN project
  // directories and carry their real scope in the name.
  assert.equal(scopeOfFileName('fleet--where-the-hub-lives.md'), 'fleet');
  assert.equal(scopeOfFileName('machine--launchd-quirk.md'), 'machine');
  assert.equal(scopeOfFileName('ordinary-note.md'), 'project');
  // A prefix in the middle is not a prefix.
  assert.equal(scopeOfFileName('about-fleet--stuff.md'), 'project');
});

test('readLocalMemoriesIn reports the scope each note declares', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, 'fleet--a.md'), 'everywhere', 'utf8');
  await writeFile(path.join(dir, 'machine--b.md'), 'this host', 'utf8');
  await writeFile(path.join(dir, 'c.md'), 'this repo', 'utf8');

  const got = await readLocalMemoriesIn(dir);
  assert.deepEqual(
    got.map((m) => [m.path, m.scope]),
    [['c.md', 'project'], ['fleet--a.md', 'fleet'], ['machine--b.md', 'machine']],
  );
});

test('overwrite is the one way content comes down, and it lands atomically', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, 'note.md'), 'old', 'utf8');

  assert.equal(await overwriteMemoryIn(dir, 'note.md', 'new'), true);
  assert.equal(await readFile(path.join(dir, 'note.md'), 'utf8'), 'new');

  // No temp file is left behind — a stray .tmp in the memory directory would
  // be read by nobody but would sit there forever.
  const left = await readdir(dir);
  assert.deepEqual(left.filter((n) => n.includes('tmp')), []);

  // Traversal is refused here exactly as it is for the create path.
  assert.equal(await overwriteMemoryIn(dir, '../escaped.md', 'nope'), false);
});

test('a deleted memory is moved out of the way, not destroyed', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, 'wrong.md'), 'a fact that turned out false', 'utf8');

  assert.equal(await quarantineMemoryIn(dir, 'wrong.md', 'github.com/x/y'), true);
  // Gone from the directory the harness loads — which is the whole point of
  // deleting it — but recoverable, because the agent must never destroy a
  // human's note outright.
  assert.deepEqual(await readLocalMemoriesIn(dir), []);

  // Retiring something already gone is the desired end state, not an error to
  // retry forever.
  assert.equal(await quarantineMemoryIn(dir, 'wrong.md', 'github.com/x/y'), false);
});

test('sync-state keys separate the scopes that share a path', () => {
  // The same file name can exist as a project note and a fleet note; keying on
  // the path alone would let one machine's bookkeeping answer for the other.
  assert.notEqual(
    syncStateKey('project', 'github.com/x/y', 'n.md'),
    syncStateKey('fleet', '', 'n.md'),
  );
  assert.notEqual(
    syncStateKey('machine', 'box-a', 'n.md'),
    syncStateKey('machine', 'box-b', 'n.md'),
  );
});

test('the index is never treated as a shareable note', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, INDEX_FILE), '- [A](a.md) — hook\n', 'utf8');
  await writeFile(path.join(dir, 'a.md'), 'a note', 'utf8');

  // Excluded at the reader, which is what keeps it out of every sync path at
  // once: never pushed up, never requested down, never retired by a tombstone.
  // Replicating it last-writer-wins would let a machine holding two notes
  // overwrite the index of a machine holding twenty-five.
  const got = await readLocalMemoriesIn(dir);
  assert.deepEqual(got.map((m) => m.path), ['a.md']);
});

test('an index pointer carries the note’s own title and hook', () => {
  const note = [
    '---',
    'name: mac-mini-flap',
    'description: the reconnect loop is a network block, not launchd',
    '---',
    '',
    '# Mac mini flap is a :443 path block',
    '',
    'body',
  ].join('\n');

  assert.deepEqual(frontmatter(note), {
    name: 'mac-mini-flap',
    description: 'the reconnect loop is a network block, not launchd',
  });
  assert.equal(
    indexPointerLine('mac-mini-flap.md', note),
    '- [Mac mini flap is a :443 path block](mac-mini-flap.md) — the reconnect loop is a network block, not launchd',
  );

  // A note with no frontmatter still gets a usable line rather than none.
  assert.equal(indexPointerLine('plain.md', 'just text'), '- [plain](plain.md)');

  // YAML quoting is optional and both spellings exist in the real corpus.
  // The quotes are syntax, and would otherwise land in the index line that
  // loads into context every session.
  const quoted = '---\nname: n\ndescription: "a quoted hook"\n---\n';
  assert.equal(frontmatter(quoted).description, 'a quoted hook');
  assert.equal(indexPointerLine('q.md', quoted), '- [n](q.md) — a quoted hook');
});

test('an arriving note is appended to the index, once', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, INDEX_FILE), '- [Existing](existing.md) — kept\n', 'utf8');

  const note = '---\nname: n\ndescription: a hook\n---\n\n# New thing\n';
  assert.equal(await appendIndexEntry(dir, 'new-thing.md', note), true);

  const index = await readFile(path.join(dir, INDEX_FILE), 'utf8');
  // The harness's own line survives untouched — the append never rewrites.
  assert.ok(index.includes('- [Existing](existing.md) — kept'));
  assert.ok(index.includes('- [New thing](new-thing.md) — a hook'));

  // Replication runs on a timer, so a second pass must not duplicate the line.
  assert.equal(await appendIndexEntry(dir, 'new-thing.md', note), false);
  assert.equal((await readFile(path.join(dir, INDEX_FILE), 'utf8')).match(/new-thing\.md/g)?.length, 1);

  // The index never indexes itself, and traversal is refused.
  assert.equal(await appendIndexEntry(dir, INDEX_FILE, 'x'), false);
  assert.equal(await appendIndexEntry(dir, '../escaped.md', 'x'), false);
});

test('an index is created when a note arrives in a project that had none', async () => {
  const dir = await scratch();
  assert.equal(await appendIndexEntry(dir, 'first.md', '# First\n'), true);
  assert.equal(await readFile(path.join(dir, INDEX_FILE), 'utf8'), '- [First](first.md)\n');
});
