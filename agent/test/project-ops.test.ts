import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import {
  adoptProject,
  createProject,
  forgetProject,
  initAuthor,
  listAdoptedProjects,
  listRootProjects,
  maxProjects,
  projectsRoot,
  removeProject,
  scanRoots,
} from '../src/project-ops.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ccr-projects-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the root and the cap come from the env, with sane defaults', () => {
  assert.equal(projectsRoot({}), path.join(os.homedir(), 'work'));
  assert.equal(projectsRoot({ CC_REMOTE_PROJECTS_ROOT: '/srv/work/' }), '/srv/work');
  assert.equal(maxProjects({}), 30);
  assert.equal(maxProjects({ CC_REMOTE_MAX_PROJECTS: '5' }), 5);
  assert.equal(maxProjects({ CC_REMOTE_MAX_PROJECTS: 'lots' }), 30);
  assert.equal(maxProjects({ CC_REMOTE_MAX_PROJECTS: '0' }), 30);
});

test('a repository in a DECLARED root is a project too, listed once', async () => {
  // The bug this pins: a box whose work lives outside the projects root showed
  // no projects at all, however many repositories it held.
  const base = await tempDir();
  const work = path.join(base, 'work');
  const srv = path.join(base, 'srv');
  await createProject({ name: 'alpha' }, { root: work });
  await createProject({ name: 'beta' }, { root: srv });

  const prevRoot = process.env['CC_REMOTE_PROJECTS_ROOT'];
  const prevDeclared = process.env['CC_REMOTE_FILES_ROOTS'];
  process.env['CC_REMOTE_PROJECTS_ROOT'] = work;
  // Declared twice, and one of them IS the projects root: neither may double.
  process.env['CC_REMOTE_FILES_ROOTS'] = [srv, work, srv].join(path.delimiter);
  try {
    const listed = await listRootProjects();
    assert.deepEqual(
      listed.map((p) => p.label).sort(),
      ['alpha', 'beta'],
      'both roots contribute, and nothing is listed twice',
    );
  } finally {
    if (prevRoot === undefined) delete process.env['CC_REMOTE_PROJECTS_ROOT'];
    else process.env['CC_REMOTE_PROJECTS_ROOT'] = prevRoot;
    if (prevDeclared === undefined) delete process.env['CC_REMOTE_FILES_ROOTS'];
    else process.env['CC_REMOTE_FILES_ROOTS'] = prevDeclared;
  }
});

test('an empty project is a repo on main with one commit by Hegai Code', async () => {
  const root = path.join(await tempDir(), 'work');

  const result = await createProject({ name: 'alpha' }, { root });
  assert.deepEqual(result, { cwd: path.join(root, 'alpha'), label: 'alpha', created: true, git: 'init' });

  assert.equal(await readFile(path.join(result.cwd, 'README.md'), 'utf8'), '# alpha\n');
  assert.equal(await git(result.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(await git(result.cwd, 'log', '--format=%an <%ae>%n%s'), 'Hegai Code <code@a.test>\ninit: alpha');
  assert.equal(await git(result.cwd, 'status', '--porcelain'), '', 'nothing left unstaged');

  const listed = await listRootProjects({ root });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.cwd, result.cwd);
  assert.equal(listed[0]?.label, 'alpha');
  assert.equal(listed[0]?.count, 0);
  assert.equal(listed[0]?.origin, 'root');
  assert.ok(typeof listed[0]?.lastModified === 'number' && listed[0].lastModified > 0);
});

test('a name that is taken is refused; an empty directory is reused', async () => {
  const root = path.join(await tempDir(), 'work');
  await createProject({ name: 'alpha' }, { root });

  await assert.rejects(createProject({ name: 'alpha' }, { root }), /already exists and is not empty/);

  await mkdir(path.join(root, 'beta'), { recursive: true });
  const reused = await createProject({ name: 'beta' }, { root });
  assert.equal(reused.created, false);
  assert.equal(reused.git, 'init');
  assert.equal(await git(reused.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

  await writeFile(path.join(root, 'gamma'), 'not a dir');
  await assert.rejects(createProject({ name: 'gamma' }, { root }), /not a directory/);
});

test('the parent must stay inside the root, and a nested project is still listed', async () => {
  const tmp = await tempDir();
  const root = path.join(tmp, 'work');
  await mkdir(root, { recursive: true });

  await assert.rejects(createProject({ name: 'x', parent: '../escape' }, { root }), /inside the projects root/);
  await assert.rejects(createProject({ name: 'x', parent: path.join(tmp, 'elsewhere') }, { root }), /inside the projects root/);
  await assert.rejects(stat(path.join(tmp, 'escape')), 'nothing was created outside');

  const nested = await createProject({ name: 'x', parent: 'team' }, { root });
  assert.equal(nested.cwd, path.join(root, 'team', 'x'));
  const absolute = await createProject({ name: 'y', parent: path.join(root, 'team') }, { root });
  assert.equal(absolute.cwd, path.join(root, 'team', 'y'));

  const listed = (await listRootProjects({ root })).map((p) => p.label).sort();
  assert.deepEqual(listed, ['x', 'y'], 'the grouping folder itself is not a project');
});

test('the cap counts directories directly under the root', async () => {
  const root = path.join(await tempDir(), 'work');
  await createProject({ name: 'one' }, { root, maxProjects: 2 });
  await mkdir(path.join(root, '.cache'));
  await createProject({ name: 'two' }, { root, maxProjects: 2 });
  await assert.rejects(createProject({ name: 'three' }, { root, maxProjects: 2 }), /project limit reached \(2\)/);
  await assert.rejects(stat(path.join(root, 'three')));

  // Reusing an existing empty directory is not a new project.
  await mkdir(path.join(root, 'four'));
  const reused = await createProject({ name: 'four' }, { root, maxProjects: 2 });
  assert.equal(reused.created, false);
});

test('a clone lands under the root, and a failed clone leaves nothing behind', async () => {
  const tmp = await tempDir();
  const upstream = await createProject({ name: 'origin' }, { root: path.join(tmp, 'src') });
  const root = path.join(tmp, 'work');

  // The https-only rule is the dispatcher's zod schema; the op itself takes
  // whatever URL it is handed, which is what lets a test clone a local path.
  const cloned = await createProject({ name: 'copy', gitUrl: upstream.cwd }, { root });
  assert.deepEqual(cloned, { cwd: path.join(root, 'copy'), label: 'copy', created: true, git: 'clone' });
  assert.equal(await readFile(path.join(cloned.cwd, 'README.md'), 'utf8'), '# origin\n');
  assert.equal(await git(cloned.cwd, 'remote', 'get-url', 'origin'), upstream.cwd);

  await assert.rejects(
    createProject({ name: 'broken', gitUrl: path.join(tmp, 'no-such-repo') }, { root }),
    /clone failed/,
  );
  await assert.rejects(stat(path.join(root, 'broken')), 'the partial directory was removed');

  await mkdir(path.join(root, 'empty'));
  await assert.rejects(
    createProject({ name: 'empty', gitUrl: path.join(tmp, 'no-such-repo') }, { root }),
    /clone failed/,
  );
  assert.deepEqual(await readdir(path.join(root, 'empty')), [], 'a reused directory is left empty again');
});

test('remove moves the project into the trash and refuses live or outside paths', async () => {
  const tmp = await tempDir();
  const root = path.join(tmp, 'work');
  const trashDir = path.join(tmp, 'trash');
  const alpha = await createProject({ name: 'alpha' }, { root });
  const busy = await createProject({ name: 'busy' }, { root });

  const gone = await removeProject({ cwd: alpha.cwd }, { root, trashDir, liveCwds: async () => [] });
  assert.equal(gone.ok, true);
  assert.ok(gone.movedTo?.startsWith(path.join(trashDir, 'alpha-')), gone.movedTo);
  await assert.rejects(stat(alpha.cwd));
  assert.equal(await readFile(path.join(gone.movedTo!, 'README.md'), 'utf8'), '# alpha\n');

  await assert.rejects(
    removeProject({ cwd: busy.cwd }, { root, trashDir, liveCwds: async () => [path.join(busy.cwd, 'src')] }),
    /a session is live in/,
  );
  await stat(busy.cwd);

  await assert.rejects(
    removeProject({ cwd: path.join(tmp, 'elsewhere') }, { root, trashDir, liveCwds: async () => [] }),
    /under the projects root/,
  );
  await assert.rejects(
    removeProject({ cwd: root }, { root, trashDir, liveCwds: async () => [] }),
    /projects root itself/,
  );
  await assert.rejects(
    removeProject({ cwd: path.join(root, 'nope') }, { root, trashDir, liveCwds: async () => [] }),
    /not found/,
  );
});

test('a folder with no .git can be adopted, and forgetting it leaves the disk alone', async () => {
  // The gap adoption exists for: the root scan admits a directory only if it
  // holds `.git`, so a plain working folder is invisible however many roots are
  // declared, and the only cure was to start a session in it — from a picker
  // that would not list it.
  const tmp = await tempDir();
  const root = path.join(tmp, 'work');
  const adoptedFile = path.join(tmp, 'adopted.json');
  const plain = path.join(root, 'notes');
  await mkdir(plain, { recursive: true });
  await writeFile(path.join(plain, 'a.md'), 'x', 'utf8');

  assert.deepEqual(await listAdoptedProjects({ adoptedFile }), [], 'a missing file is not an error');
  assert.deepEqual(
    (await listRootProjects({ root })).map((p) => p.label),
    [],
    'the scan does not see a folder without .git',
  );

  const first = await adoptProject({ cwd: plain }, { root, adoptedFile });
  assert.deepEqual(
    { label: first.label, alreadyKnown: first.alreadyKnown },
    { label: 'notes', alreadyKnown: false },
  );
  const second = await adoptProject({ cwd: plain }, { root, adoptedFile });
  assert.equal(second.alreadyKnown, true, 'adoption is idempotent');

  const listed = await listAdoptedProjects({ adoptedFile });
  assert.deepEqual(listed.map((p) => [p.label, p.origin]), [['notes', 'adopted']]);

  const forgot = await forgetProject({ cwd: plain }, { adoptedFile });
  assert.deepEqual(forgot, { ok: true, forgot: true });
  assert.deepEqual(await listAdoptedProjects({ adoptedFile }), []);
  // The whole reason forget is not a flag on `projects.remove`.
  assert.equal(await readFile(path.join(plain, 'a.md'), 'utf8'), 'x');

  assert.deepEqual(
    await forgetProject({ cwd: plain }, { adoptedFile }),
    { ok: true, forgot: false },
    'forgetting twice is not an error, and says it changed nothing',
  );
});

test('adopting what the scan already finds stores nothing', async () => {
  // Otherwise `projects.forget` would report success while the row stayed on
  // screen: the scan keeps producing it, and the button looks broken.
  const tmp = await tempDir();
  const root = path.join(tmp, 'work');
  const adoptedFile = path.join(tmp, 'adopted.json');
  const repo = await createProject({ name: 'alpha' }, { root });

  const res = await adoptProject({ cwd: repo.cwd }, { root, adoptedFile });
  assert.equal(res.alreadyKnown, true);
  assert.deepEqual(await listAdoptedProjects({ adoptedFile }), []);
  await assert.rejects(stat(adoptedFile), 'nothing was written at all');

  await assert.rejects(adoptProject({ cwd: path.join(root, 'nope') }, { root, adoptedFile }), /not found/);
  await assert.rejects(
    adoptProject({ cwd: path.join(repo.cwd, 'README.md') }, { root, adoptedFile }),
    /not a directory/,
  );
});

test('an adopted directory that vanished is skipped, not reported', async () => {
  const tmp = await tempDir();
  const adoptedFile = path.join(tmp, 'adopted.json');
  const root = path.join(tmp, 'work');
  const gone = path.join(root, 'ghost');
  await mkdir(gone, { recursive: true });
  await adoptProject({ cwd: gone }, { root, adoptedFile });
  await rm(gone, { recursive: true, force: true });

  assert.deepEqual(await listAdoptedProjects({ adoptedFile }), [], 'a row nobody can open is worse than no row');
  const raw: unknown = JSON.parse(await readFile(adoptedFile, 'utf8'));
  assert.equal(
    (raw as { projects: unknown[] }).projects.length,
    1,
    'but it stays in the file — a mount that is not up yet must not lose the entry',
  );
});

test('scanRoots is what a client is told to browse', () => {
  const tmp = path.join(os.tmpdir(), 'ccr-scan-roots');
  assert.deepEqual(scanRoots({ root: tmp + '/' }), [tmp], 'an explicit root wins and is resolved');

  const prevRoot = process.env['CC_REMOTE_PROJECTS_ROOT'];
  const prevDeclared = process.env['CC_REMOTE_FILES_ROOTS'];
  process.env['CC_REMOTE_PROJECTS_ROOT'] = '/tmp/ccr-work';
  process.env['CC_REMOTE_FILES_ROOTS'] = ['/srv', '/tmp/ccr-work'].join(path.delimiter);
  try {
    assert.deepEqual(scanRoots(), ['/tmp/ccr-work', '/srv'], 'projects root first, and no duplicates');
  } finally {
    if (prevRoot === undefined) delete process.env['CC_REMOTE_PROJECTS_ROOT'];
    else process.env['CC_REMOTE_PROJECTS_ROOT'] = prevRoot;
    if (prevDeclared === undefined) delete process.env['CC_REMOTE_FILES_ROOTS'];
    else process.env['CC_REMOTE_FILES_ROOTS'] = prevDeclared;
  }
});

test('the initial-commit author: internal default, external default, env override', () => {
  assert.deepEqual(initAuthor({}, false), { name: 'Hegai Code', email: 'code@a.test' });
  assert.deepEqual(initAuthor({}, true), { name: 'Hegai Code', email: 'agent@localhost' });
  assert.deepEqual(
    initAuthor({ CC_REMOTE_GIT_AUTHOR_NAME: ' Acme Bot ', CC_REMOTE_GIT_AUTHOR_EMAIL: 'bot@acme.test' }, true),
    { name: 'Acme Bot', email: 'bot@acme.test' },
  );
});
