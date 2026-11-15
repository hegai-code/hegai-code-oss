import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutomatedSession, isScratchCwd, isWorktreeCwd } from '../src/lib.js';

/**
 * The automated filter decides what the WHOLE app shows: every list, the
 * project shelf and the counts run through it. Both halves are narrow on
 * purpose, and each line below is a case that got it wrong once.
 */

test('the scripted half is the entrypoint alone — an owner does not rescue sdk-cli', () => {
  assert.equal(isAutomatedSession({ entrypoint: 'sdk-cli' }), true);
  // Was `false` while an `owner` vetoed the rule. A cron loop started THROUGH
  // cc-remote carries an owner like anything else, so the belt hid the scripted
  // sessions nobody owned and showed the scripted sessions somebody did —
  // exactly backwards. `sdk-cli` IS the headless flag; nobody drives one.
  assert.equal(isAutomatedSession({ entrypoint: 'sdk-cli', owner: { userId: 'u-1' } }), true);
  // Old app resumes recorded themselves as sdk-ts; the wide mask hid real work.
  assert.equal(isAutomatedSession({ entrypoint: 'sdk-ts' }), false);
  assert.equal(isAutomatedSession({ entrypoint: 'sdk-ts', owner: { userId: 'u-1' } }), false);
  assert.equal(isAutomatedSession({ entrypoint: 'cli' }), false);
  assert.equal(isAutomatedSession({}), false);
});

test('a session that isolated itself into a git worktree is scaffolding, not a project', () => {
  // The case this was written for: a run cut `.claude/worktrees/shell-chrome`
  // mid-flight, and from then on reported that path as its cwd — so the session
  // left «remotehegai» and appeared as a project called «shell-chrome».
  // entrypoint and owner both look like real work, because a person DID start
  // it; only the cwd says the agent moved it.
  assert.equal(
    isAutomatedSession({
      entrypoint: 'cc-remote',
      owner: { userId: 'u-1' },
      cwd: '/srv/main-source/.claude/worktrees/shell-chrome',
    }),
    true,
  );
  // Matched at any depth, including below the worktree root.
  assert.equal(isWorktreeCwd('/srv/main-source/.claude/worktrees/shell-chrome/web'), true);
  assert.equal(isWorktreeCwd('D:\\Hegai_VScode\\repo\\.claude\\worktrees\\layout'), true);
  // The repo itself, and a project that merely owns the words, are left alone.
  assert.equal(isWorktreeCwd('/srv/main-source'), false);
  assert.equal(isWorktreeCwd('/srv/main-source/.claude/skills/bugs'), false);
  assert.equal(isWorktreeCwd('/home/owner/worktrees/app'), false);
  assert.equal(isWorktreeCwd(undefined), false);
});

test('a session in an OS scratch directory is automated wherever it came from', () => {
  // The smoke harnesses (server/src/cli/*) start throwaways THROUGH cc-remote,
  // so entrypoint and owner both look like real work — only the cwd tells.
  assert.equal(
    isAutomatedSession({
      entrypoint: 'cc-remote',
      owner: { userId: 'u-1' },
      cwd: 'C:\\Users\\buildbox\\AppData\\Local\\Temp\\cc-ui-check-LPlvcx',
    }),
    true,
  );
  assert.equal(isAutomatedSession({ entrypoint: 'cc-remote', cwd: '/tmp/cc-ui-check-3Y05jF' }), true);
});

test('every platform mkdtemp hands out is recognised', () => {
  for (const cwd of [
    'C:\\Users\\buildbox\\AppData\\Local\\Temp\\cc-run-settings-JfPJ5e',
    'C:\\Windows\\Temp\\build',
    '/tmp/cc-ui-check-3Y05jF',
    '/var/tmp/scratch',
    '/var/folders/9m/xk1t/T/cc-ui-check-aB3d',
    '/private/var/folders/9m/xk1t/T/cc-ui-check-aB3d',
    '/private/tmp/probe',
  ]) {
    assert.equal(isScratchCwd(cwd), true, `${cwd} is a throwaway`);
  }
});

test('a real project that merely says "tmp" or "temp" is left alone', () => {
  for (const cwd of [
    '/home/devbox/work/circle',
    '/home/owner/work/tmp/app', // "tmp" deep in the path is somebody's real folder
    'D:\\Hegai_VScode\\claudehegai',
    'C:\\Users\\buildbox\\temperature-app',
    '/srv/acme',
    '/tmpfiles-archive/notes', // shares the prefix, is not /tmp
  ]) {
    assert.equal(isScratchCwd(cwd), false, `${cwd} is real work`);
  }
  assert.equal(isScratchCwd(undefined), false);
  assert.equal(isScratchCwd(''), false);
});

test('/tmp itself, scratchpads and the agent state dir are scratch too (30.09.2026)', () => {
  // 179 scoring sessions sat in exactly `/tmp` and became a project «tmp».
  assert.equal(isScratchCwd('/tmp'), true);
  assert.equal(isScratchCwd('/tmp/'), true);
  assert.equal(isScratchCwd('/var/tmp'), true);
  assert.equal(isScratchCwd('/home/u/.claude/tmp/-srv-x/abc/scratchpad/wt'), true);
  assert.equal(isScratchCwd('/var/lib/claude-0/-srv-x/abc/scratchpad'), true);
  // A real project called scratchpad, and a repo with its own .cc-remote, stay.
  assert.equal(isScratchCwd('/home/owner/code/scratchpad'), false);
  assert.equal(isScratchCwd('/srv/main-source/.cc-remote'), false);
  assert.equal(isScratchCwd('/root/.cc-remote/teo'), true);
  // A real project that merely contains the word stays.
  assert.equal(isScratchCwd('/home/owner/work/tmp/app'), false);
  assert.equal(isScratchCwd('/srv/tmpl'), false);
  assert.equal(isScratchCwd('/srv/scratchpad-app'), false);
});

test('a probe prompt is automated whatever its entrypoint', () => {
  assert.equal(isAutomatedSession({ entrypoint: 'cc-remote', cwd: '/srv/x', title: 'Ответь одним словом: ок' }), true);
  assert.equal(isAutomatedSession({ entrypoint: 'cc-remote', title: 'reply with the single word ok' }), true);
  assert.equal(isAutomatedSession({ title: 'Оцени каждую сессию ниже по рубрике. Верни JSON' }), true);
  // A role prompt a person opens a real chat with is NOT a probe.
  assert.equal(isAutomatedSession({ entrypoint: 'cc-remote', title: 'Ты — интернет-маркетолог, помоги' }), false);
  // A one-word title a person gave a real chat is NOT a probe here.
  assert.equal(isAutomatedSession({ entrypoint: 'cli', title: 'test' }), false);
  assert.equal(isAutomatedSession({ entrypoint: 'cli', title: 'Почини боковое меню' }), false);
});

test('a managed worktree (.hegai-worktrees) stays on the shelf, grouped under its repository', async () => {
  const { managedWorktree, projectTargets } = await import('../src/lib.js');
  const cwd = '/srv/.hegai-worktrees/proj/agent-fix-1030';
  assert.equal(isWorktreeCwd(cwd), false);
  assert.equal(isAutomatedSession({ entrypoint: 'cc-remote', cwd }), false);
  assert.deepEqual(managedWorktree(cwd), { repo: 'proj', name: 'agent-fix-1030', source: '/srv/proj' });
  assert.equal(managedWorktree('C:\\code\\.hegai-worktrees\\proj\\b\\sub')?.name, 'b');
  assert.equal(managedWorktree('/srv/proj'), null);
  assert.equal(managedWorktree('/srv/proj/.claude/worktrees/x'), null);

  const machine = { machine: { machineId: 'm', name: 'M', os: 'linux' }, sessions: [], canControl: true } as never;
  const list = projectTargets(
    [machine],
    undefined,
    new Map(),
    [
      { machineId: 'm', cwd: '/srv/proj', label: 'proj', lastModified: 100 },
      { machineId: 'm', cwd: '/srv/other', label: 'other', lastModified: 90 },
      { machineId: 'm', cwd, label: 'agent-fix-1030', lastModified: 50 },
    ],
  );
  assert.deepEqual(list.map((p) => p.label), ['proj', 'proj · agent-fix-1030', 'other']);
});

test('worktrees group under the full source repo path, not the folder name', async () => {
  const { groupWorktrees, managedWorktree, runAttachedTo } = await import('../src/lib.js');
  assert.equal(managedWorktree('/a/.hegai-worktrees/app/feat-x/sub')?.source, '/a/app');
  const t = (cwd: string, extra: object = {}) =>
    ({ machineId: 'm', machineName: '', cwd, label: cwd, lastModified: 0, mine: true, live: 0, attention: 0, ...extra }) as never;
  const wtA = managedWorktree('/a/.hegai-worktrees/app/x')!;
  const wtB = managedWorktree('/b/.hegai-worktrees/app/y')!;
  const out = groupWorktrees([
    t('/a/app'),
    t('/b/app'),
    t('/b/.hegai-worktrees/app/y', { worktreeOf: wtB.source }),
    t('/a/.hegai-worktrees/app/x', { worktreeOf: wtA.source }),
  ]) as { cwd: string }[];
  assert.deepEqual(out.map((x) => x.cwd), ['/a/app', '/a/.hegai-worktrees/app/x', '/b/app', '/b/.hegai-worktrees/app/y']);
  assert.equal(runAttachedTo({ machineId: 'm1', sessionId: 's', runId: 'r' }, 'm2', 's'), false);
  assert.equal(runAttachedTo({ machineId: 'm1', sessionId: 's', runId: 'r' }, 'm1', 's'), true);
  assert.equal(runAttachedTo({ machineId: 'm1', sessionId: 's' }, 'm1', 's'), false);
});
