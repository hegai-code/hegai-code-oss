import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import {
  worktreeAdd,
  worktreeList,
  worktreeRemove,
  gitDiff,
  parseUnifiedDiff,
  prUrlFor,
  parseRemoteUrl,
  remoteUrlFromOutput,
  gitPrCreate,
} from '../src/worktree-ops.js';
import { gitCommit } from '../src/git-ops.js';

// `gitCommit` runs the agent's own git, which reads identity from the user's
// config. CI containers have none («Please tell me who you are» → ok: false),
// so the four commit-dependent tests passed on a dev box and failed in CI.
for (const k of ['GIT_AUTHOR', 'GIT_COMMITTER']) {
  process.env[`${k}_NAME`] ??= 't';
  process.env[`${k}_EMAIL`] ??= 't@t';
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

/** A repo with one commit, inside its own temp parent (worktrees land beside it). */
function repo(): string {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ccr-wt-')));
  const dir = path.join(parent, 'proj');
  mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  // CI has no global git identity: every commit in these repos (also the ones
  // the agent makes) must not depend on it.
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(dir, 'old name.txt'), 'rename me\nrename me\nrename me\nrename me\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'init');
  return dir;
}

test('worktree add cuts a branch OUTSIDE the repo and list reports it', async () => {
  const dir = repo();
  const r = await worktreeAdd(dir, 'agent/try-1');
  assert.equal(r.path, path.join(path.dirname(dir), '.hegai-worktrees', 'proj', 'agent-try-1'));
  assert.ok(existsSync(path.join(r.path, 'a.txt')));
  const { worktrees } = await worktreeList(dir);
  assert.equal(worktrees.length, 2);
  assert.equal(worktrees[0]?.main, true);
  const wt = worktrees.find((w) => w.branch === 'agent/try-1');
  assert.equal(wt?.dirty, 0);
  assert.equal(wt?.ahead, 0);
  assert.equal(wt?.behind, 0);
  // listing from inside the linked worktree sees the same set, and a second add
  // from there still lands beside the MAIN repo
  const again = await worktreeAdd(r.path, 'agent/try-2', 'main');
  assert.equal(path.dirname(again.path), path.dirname(r.path));
});

test('worktree add refuses bad branch names and bad bases', async () => {
  const dir = repo();
  for (const bad of ['-f', '--detach', 'a..b', 'x y', 'a@{1}', 'end.lock', '']) {
    await assert.rejects(worktreeAdd(dir, bad), /недопустимое имя|too small|String must contain/i, bad);
  }
  await assert.rejects(worktreeAdd(dir, 'ok-branch', '--help'), /недопустимая база/);
  await assert.rejects(worktreeAdd(dir, 'ok-branch', 'no-such-ref'), /база не найдена/);
  await worktreeAdd(dir, 'dup');
  await assert.rejects(worktreeAdd(dir, 'dup'));
});

test('ahead/dirty are reported; remove refuses dirty, live runs and the main tree', async () => {
  const dir = repo();
  const { path: wt } = await worktreeAdd(dir, 'feat/x');
  writeFileSync(path.join(wt, 'new.txt'), 'x\n');
  let [, w] = (await worktreeList(dir)).worktrees;
  assert.equal(w?.dirty, 1);
  assert.equal((await gitCommit(wt, 'add new', true)).ok, true);
  [, w] = (await worktreeList(dir)).worktrees;
  assert.equal(w?.dirty, 0);
  assert.equal(w?.ahead, 1);

  writeFileSync(path.join(wt, 'wip.txt'), 'wip\n');
  const dirtyRefusal = await worktreeRemove(dir, wt, false);
  assert.equal(dirtyRefusal.ok, false);
  assert.match(dirtyRefusal.output, /незакоммичен/);

  // a live run under the folder wins over force
  const live = await worktreeRemove(dir, wt, true, { liveCwds: async () => [path.join(wt, 'sub')] });
  assert.equal(live.ok, false);
  assert.match(live.output, /сессия/);
  assert.ok(existsSync(wt));
  assert.equal((await worktreeList(dir, { liveCwds: async () => [wt] })).worktrees[1]?.busy, true);

  assert.equal((await worktreeRemove(dir, dir, true)).ok, false);
  assert.equal((await worktreeRemove(dir, path.join(dir, 'a.txt'), true)).ok, false);

  const gone = await worktreeRemove(dir, wt, true);
  assert.equal(gone.ok, true);
  assert.ok(!existsSync(wt));
  assert.equal((await worktreeList(dir)).worktrees.length, 1);
});

test('diff: modified, untracked, renamed, binary — parsed with line numbers', async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  writeFileSync(path.join(dir, 'fresh file.txt'), 'hello\nworld\n');
  writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
  sh(dir, 'mv', 'old name.txt', 'new name.txt');

  const { files, truncated } = await gitDiff(dir, {});
  assert.equal(truncated, false);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));

  const a = by['a.txt'];
  assert.equal(a?.status, 'modified');
  assert.equal(a?.additions, 2);
  assert.equal(a?.deletions, 1);
  const lines = a?.hunks[0]?.lines ?? [];
  assert.deepEqual(lines.find((l) => l.kind === '-'), { kind: '-', old: 2, text: 'two' });
  assert.deepEqual(lines.find((l) => l.text === 'four'), { kind: '+', new: 4, text: 'four' });
  assert.deepEqual(lines[0], { kind: ' ', old: 1, new: 1, text: 'one' });

  const fresh = by['fresh file.txt'];
  assert.equal(fresh?.status, 'added');
  assert.equal(fresh?.additions, 2);

  assert.equal(by['blob.bin']?.binary, true);
  assert.equal(by['blob.bin']?.status, 'added');

  const renamed = by['new name.txt'];
  assert.equal(renamed?.status, 'renamed');
  assert.equal(renamed?.oldPath, 'old name.txt');

  // staged-only view and a path filter
  const staged = await gitDiff(dir, { staged: true });
  assert.deepEqual(staged.files.map((f) => f.path), ['new name.txt']);
  const one = await gitDiff(dir, { path: 'a.txt' });
  assert.deepEqual(one.files.map((f) => f.path), ['a.txt']);
});

test('diff against a base branch compares base...HEAD and ignores uncommitted work', async () => {
  const dir = repo();
  const { path: wt } = await worktreeAdd(dir, 'feat/review');
  writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\nthree\nmore\n');
  await gitCommit(wt, 'more', true);
  writeFileSync(path.join(wt, 'uncommitted.txt'), 'nope\n');
  const { files } = await gitDiff(wt, { base: 'main' });
  assert.deepEqual(files.map((f) => f.path), ['a.txt']);
  await assert.rejects(gitDiff(wt, { base: '--output=/tmp/x' }), /недопустимая база/);
});

test('diff is capped and says so', async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(100) + '\n'.repeat(1) + ('y'.repeat(100) + '\n').repeat(30_000));
  const { files, truncated } = await gitDiff(dir, {});
  assert.equal(truncated, true);
  assert.ok(files.length >= 1);
});

test('parseUnifiedDiff keeps spaces in names and ignores the no-newline marker', () => {
  const text = [
    'diff --git a/dir/sp ace.txt b/dir/sp ace.txt',
    'index 1..2 100644',
    '--- a/dir/sp ace.txt\t',
    '+++ b/dir/sp ace.txt\t',
    '@@ -1 +1 @@',
    '-a',
    '\\ No newline at end of file',
    '+b',
    '',
  ].join('\n');
  const [f] = parseUnifiedDiff(text);
  assert.equal(f?.path, 'dir/sp ace.txt');
  assert.equal(f?.additions, 1);
  assert.equal(f?.hunks[0]?.lines.length, 2);
});

test('commit all stages untracked files too', async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'u.txt'), 'u\n');
  const plain = await gitCommit(dir, 'no all');
  assert.equal(plain.ok, false);
  const all = await gitCommit(dir, 'all', true);
  assert.equal(all.ok, true);
  assert.equal(sh(dir, 'status', '--porcelain').trim(), '');
});

test('PR URL derivation: github https/ssh, forgejo, gitlab, junk', () => {
  assert.equal(
    prUrlFor('https://github.com/acme/app.git', 'main', 'agent/x'),
    'https://github.com/acme/app/compare/main...agent/x?expand=1',
  );
  assert.equal(
    prUrlFor('git@github.com:acme/app.git', 'main', 'feat', 'T t', 'B'),
    'https://github.com/acme/app/compare/main...feat?expand=1&title=T+t&body=B',
  );
  assert.equal(
    prUrlFor('ssh://git@git.corp.test:2222/hegai/cc-remote.git', 'main', 'agent/y'),
    'https://git.corp.test/hegai/cc-remote/compare/main...agent/y',
  );
  assert.equal(
    prUrlFor('https://user:tok@git.corp.test/hegai/cc-remote', 'main', 'b'),
    'https://git.corp.test/hegai/cc-remote/compare/main...b',
  );
  assert.match(prUrlFor('git@gitlab.com:g/s/r.git', 'main', 'b') ?? '', /gitlab\.com\/g\/s\/r\/-\/merge_requests\/new\?/);
  assert.equal(prUrlFor('/local/path/repo', 'main', 'b'), undefined);
  assert.deepEqual(parseRemoteUrl('git@git.corp.test:hegai/x.git'), { host: 'git.corp.test', repo: 'hegai/x' });
});

test('remote output URL is read from remote: lines', () => {
  const out = [
    'To git.corp.test:hegai/x.git',
    'remote: Create a new pull request for "agent/y":',
    'remote:   https://git.corp.test/hegai/x/compare/main...agent/y',
  ].join('\n');
  assert.equal(remoteUrlFromOutput(out), 'https://git.corp.test/hegai/x/compare/main...agent/y');
  assert.equal(remoteUrlFromOutput('everything up to date'), undefined);
});

test('pr.create falls back to the compare page for a non-GitHub remote', async () => {
  const dir = repo();
  sh(dir, 'remote', 'add', 'origin', 'https://git.corp.test/hegai/demo.git');
  const { path: wt } = await worktreeAdd(dir, 'agent/pr');
  const r = await gitPrCreate(wt, 'Title', 'Body', undefined);
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://git.corp.test/hegai/demo/compare/main...agent/pr');
  assert.equal((await gitPrCreate(wt, 'T', undefined, '-x')).ok, false);
});


test('the sent diff is capped by lines, not only by raw bytes', async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'big.txt'), '\n'.repeat(30_000));
  const r = await gitDiff(dir, {});
  const lines = r.files.reduce((a, f) => a + f.hunks.reduce((b, h) => b + h.lines.length, 0), 0);
  assert.ok(lines <= 20_000, `sent ${lines} lines`);
  assert.equal(r.truncated, true);
});

test('only regular untracked files are diffed (a FIFO never blocks)', async () => {
  const dir = repo();
  execFileSync('mkfifo', [path.join(dir, 'pipe')]);
  writeFileSync(path.join(dir, 'new.txt'), 'hi\n');
  const r = await gitDiff(dir, {});
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['new.txt']);
});

test('commit all refuses to sweep secret-looking files, .env.example is fine', async () => {
  const dir = repo();
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'user.email', 't@t');
  writeFileSync(path.join(dir, '.env'), 'TOKEN=x\n');
  const refused = await gitCommit(dir, 'all', true);
  assert.equal(refused.ok, false);
  assert.match(refused.output, /\.env/);
  execFileSync('rm', [path.join(dir, '.env')]);
  writeFileSync(path.join(dir, '.env.example'), 'TOKEN=\n');
  const ok = await gitCommit(dir, 'all', true);
  assert.equal(ok.ok, true, ok.output);
});

test('git diff never runs a textconv from .gitattributes', async () => {
  const dir = repo();
  const marker = path.join(path.dirname(dir), 'textconv-ran');
  writeFileSync(path.join(dir, '.gitattributes'), '*.txt diff=evil\n');
  sh(dir, 'config', 'diff.evil.textconv', `touch ${marker}; cat`);
  writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
  await gitDiff(dir, {});
  await gitDiff(dir, { staged: true });
  assert.equal(existsSync(marker), false);
});

test('commit-all refuses credential-like files', async () => {
  const names = ['.npmrc', '.netrc', '_netrc', '.pypirc', '.git-credentials', '.dockercfg', 'prod.tfvars', 'vault.kdbx', '.docker/config.json'];
  for (const n of names) {
    const dir = repo();
    mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
    writeFileSync(path.join(dir, n), 'x\n');
    const r = await gitCommit(dir, 'm', true);
    assert.equal(r.ok, false, n);
  }
  const dir = repo();
  mkdirSync(path.join(dir, 'config'));
  writeFileSync(path.join(dir, 'config', 'config.json'), '{}\n');
  assert.equal((await gitCommit(dir, 'm', true)).ok, true);
});

test('worktree remove refuses when live runs cannot be determined, even with force', async () => {
  const dir = repo();
  const r = await worktreeAdd(dir, 'agent/live');
  const res = await worktreeRemove(dir, r.path, true, { liveCwds: async () => { throw new Error('boom'); } });
  assert.equal(res.ok, false);
  assert.ok(existsSync(r.path));
});

test('commit all also refuses a modified TRACKED credential file', async () => {
  const dir = repo();
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'user.email', 't@t');
  writeFileSync(path.join(dir, '.npmrc'), 'registry=x\n');
  sh(dir, 'add', '.npmrc');
  sh(dir, 'commit', '-qm', 'npmrc');
  writeFileSync(path.join(dir, '.npmrc'), '//r/:_authToken=abc\n');
  const r = await gitCommit(dir, 'all', true);
  assert.equal(r.ok, false);
  assert.match(r.output, /\.npmrc/);
});

test('commit all: *.env files are secrets, *.env.example is not', async () => {
  const { isSecretLike } = await import('../src/git-ops.js');
  for (const f of ['production.env', 'local.env', 'cfg/.env', '.env.local']) assert.equal(isSecretLike(f), true, f);
  for (const f of ['.env.example', 'app.env.example', 'environment.ts', 'src/env.ts']) assert.equal(isSecretLike(f), false, f);
});

test('commit all stages both sides of a worktree-side rename', async () => {
  const dir = repo();
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'mv', 'a.txt', 'b.txt');
  sh(dir, 'reset', '-q'); // rename now only in the worktree
  sh(dir, 'add', '-N', 'b.txt'); // intent-to-add makes porcelain show " R"
  const r = await gitCommit(dir, 'rename', true);
  assert.equal(r.ok, true, r.output);
  assert.equal(sh(dir, 'status', '--porcelain').trim(), '');
});

test('review diff withholds credential files, tracked or untracked', async () => {
  const dir = repo();
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'user.email', 't@t');
  writeFileSync(path.join(dir, '.npmrc'), 'registry=x\n');
  sh(dir, 'add', '.npmrc');
  sh(dir, 'commit', '-qm', 'npmrc');
  writeFileSync(path.join(dir, '.npmrc'), '//r/:_authToken=SECRET1\n');
  writeFileSync(path.join(dir, '.env'), 'TOKEN=SECRET2\n');
  writeFileSync(path.join(dir, '.pgpass'), 'h:5432:*:u:SECRET3\n');
  const r = await gitDiff(dir, {});
  const body = JSON.stringify(r);
  assert.doesNotMatch(body, /SECRET[123]/);
  for (const name of ['.npmrc', '.env', '.pgpass']) {
    const f = r.files.find((x) => x.path === name);
    assert.ok(f?.withheld, name);
  }
});

test('no run starts in a worktree while it is being removed', async () => {
  const { isBeingRemoved, worktreeRemove } = await import('../src/worktree-ops.js');
  const dir = repo();
  const wt = await worktreeAdd(dir, 'agent/rm-race');
  let seen = false;
  const r = await worktreeRemove(dir, wt.path, true, {
    liveCwds: async () => {
      seen = seen || isBeingRemoved(path.join(wt.path, 'sub'));
      return [];
    },
  });
  assert.equal(r.ok, true, r.output);
  assert.equal(seen, true, 'the folder was locked during the final check');
  assert.equal(isBeingRemoved(wt.path), false, 'and released afterwards');
});

test('review diff masks secret-shaped values in ordinary files; .env.production.local is withheld', async () => {
  const dir = repo();
  const { isSecretLike } = await import('../src/git-ops.js');
  assert.equal(isSecretLike('.env.production.local'), true);
  const key = 'sk-ant-' + 'api03-' + 'Q'.repeat(40);
  writeFileSync(path.join(dir, 'config.ts'), `export const KEY = "${key}";\n`);
  const r = await gitDiff(dir, {});
  assert.doesNotMatch(JSON.stringify(r), /QQQQQQQQQQQQQQQQQQQQ/);
});

test('a multi-line private key in an ordinary file withholds the file; push/PR URLs are cleaned', async () => {
  const { cleanUrl } = await import('../src/worktree-ops.js');
  const dir = repo();
  const D = '-'.repeat(5);
  writeFileSync(path.join(dir, 'notes.txt'), `${D}BEGIN PRIVATE KEY${D}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${D}END PRIVATE KEY${D}\n`);
  const r = await gitDiff(dir, {});
  assert.equal(r.files.find((f) => f.path === 'notes.txt')?.withheld, true);
  assert.doesNotMatch(JSON.stringify(r), /MIIEvQIBADAN/);
  assert.equal(cleanUrl('https://user:tok@git.example.com/o/r/compare/main...b?token=x#y'), 'https://git.example.com/o/r/compare/main...b');
  assert.equal(cleanUrl('javascript:alert(1)'), undefined);
});

test('a key body changed far from its BEGIN line still withholds the file; origin query never reaches a PR URL', async () => {
  const dir = repo();
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'user.email', 't@t');
  const D = '-'.repeat(5);
  const body = Array.from({ length: 30 }, (_, i) => `QUFB${'A'.repeat(56)}${i}`).join('\n');
  writeFileSync(path.join(dir, 'keep.txt'), `${D}BEGIN PRIVATE KEY${D}\n${body}\n${D}END PRIVATE KEY${D}\n`);
  sh(dir, 'add', 'keep.txt');
  sh(dir, 'commit', '-qm', 'k');
  writeFileSync(path.join(dir, 'keep.txt'), `${D}BEGIN PRIVATE KEY${D}\n${body.replace('A29', 'B29')}\n${D}END PRIVATE KEY${D}\n`);
  const r = await gitDiff(dir, {});
  assert.equal(r.files.find((f) => f.path === 'keep.txt')?.withheld, true);
  assert.doesNotMatch(JSON.stringify(r), /QUFBAAAA/);
  assert.doesNotMatch(prUrlFor('https://git.example.com/o/r.git?access_token=SECRET', 'main', 'b') ?? '', /SECRET/);
});

test('a staged key withholds the file even if the working copy is clean; a worktree starts at the caller HEAD; credentials with @ never reach a PR link', async () => {
  const dir = repo();
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'user.email', 't@t');
  const D = '-'.repeat(5);
  writeFileSync(path.join(dir, 'k.txt'), `${D}BEGIN PRIVATE KEY${D}\nQUFB${'A'.repeat(60)}\n${D}END PRIVATE KEY${D}\n`);
  sh(dir, 'add', 'k.txt');
  writeFileSync(path.join(dir, 'k.txt'), 'harmless\n');
  const staged = await gitDiff(dir, { staged: true });
  assert.equal(staged.files.find((f) => f.path === 'k.txt')?.withheld, true);
  sh(dir, 'reset', '-q', 'k.txt');
  // caller HEAD
  const a = await worktreeAdd(dir, 'agent/a');
  writeFileSync(path.join(a.path, 'only-in-a.txt'), 'x\n');
  sh(a.path, 'add', '-A');
  sh(a.path, 'commit', '-qm', 'a');
  const b = await worktreeAdd(a.path, 'agent/b');
  assert.ok(existsSync(path.join(b.path, 'only-in-a.txt')));
  assert.doesNotMatch(prUrlFor('https://u:p@ss@git.example.com/o/r.git', 'main', 'b') ?? '', /p@ss|u:/);
});
