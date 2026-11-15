/**
 * Projects smoke: the "Create project" RPCs end to end through the hub to a
 * REAL agent on this machine, then the hub-side refusal for a control-share
 * member who may start sessions but not run filesystem RPCs.
 *
 * Part 1 (owner, fleet token; needs a local agent):
 *   projects.create {name}      -> git:'init', cwd under the projects root,
 *                                  `.git` on disk (checked when the root is local)
 *   projects.list               -> contains it with origin:'root'
 *   projects.create again       -> rpc_response ok:false "already exists"
 *   projects.create {name:'../x'} -> ok:false (schema refuses the name)
 *   projects.create {gitUrl}    -> git:'clone'  (only with PROJECTS_SMOKE_CLONE_URL)
 *   projects.remove {cwd}       -> ok:true, movedTo under ~/.cc-remote/trash,
 *                                  gone from projects.list
 *
 * Part 2 (member, SSO; SKIPped without CC_REMOTE_SSO_SECRET):
 *   A enrolls a fake machine, shares a root with access:'control' to a team
 *   B belongs to; B's `rpc_request projects.create` over /ui is answered
 *   `rpc_response ok:false error:'Read-only workspace access.'` by the hub
 *   itself — the agent never sees it.
 *
 * Start a LOCAL hub (SSO optional, needed for part 2) and a LOCAL agent with a
 * scratch projects root, both on the dev token:
 *
 *   CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-smoke.sqlite3 \
 *   cargo run --manifest-path server-rs/Cargo.toml
 *
 *   CC_REMOTE_PROJECTS_ROOT=/tmp/projects-smoke-root \
 *   CENTRAL_URL=ws://127.0.0.1:4319 CC_REMOTE_TOKEN=dev-token \
 *   npm run dev --workspace agent
 *
 *   CC_REMOTE_PROJECTS_ROOT=/tmp/projects-smoke-root CC_REMOTE_SSO_SECRET=<same> \
 *     tsx server/src/cli/projects-smoke.ts [ws://127.0.0.1:4319] [dev-token] [machineFilter=os.hostname()]
 *
 * `CC_REMOTE_PROJECTS_ROOT` must be the same value in the agent's shell and
 * here: the agent creates under it, this smoke checks the directory on disk.
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_MACHINE, PROJECTS_SMOKE_CLONE_URL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MachineSnapshot, ProjectCreateResult, ProjectRemoveResult, ProjectsResult } from '@cc-remote/shared';
import {
  adminActivate,
  adminLogin,
  api,
  connectUiAs,
  enrollFakeAgent,
  expectStatus,
  fail,
  machineFilterArg,
  mustOk,
  nextAgentFrame,
  nextBrowserFrame,
  openSocket,
  randomSmokeUser,
  rpc,
  sendUi,
  smokeTarget,
  ssoLogin,
  step,
} from './_harness.js';

const target = smokeTarget(process.argv);
const machineFilter = machineFilterArg(process.argv, os.hostname());
const projectsRoot = path.resolve(process.env['CC_REMOTE_PROJECTS_ROOT']?.trim() || path.join(os.homedir(), 'work'));
const cloneUrl = process.env['PROJECTS_SMOKE_CLONE_URL']?.trim() || undefined;
const TRASH_RE = /[\\/]\.cc-remote[\\/]trash[\\/]/;

const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

/** A zod refusal arrives as a JSON array of issues; show the first message. */
function firstIssue(error: string): string {
  try {
    const parsed: unknown = JSON.parse(error);
    if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
      const message = (parsed[0] as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  } catch {
    /* plain text */
  }
  return error.split('\n')[0] ?? error;
}

async function ownerPart(): Promise<void> {
  step(`Part 1 — owner RPCs against a local agent (machine filter "${machineFilter}", root ${projectsRoot})`);
  const ui = await openSocket(`${target.ws}/ui?token=${encodeURIComponent(target.token)}`);
  const snap = await nextBrowserFrame(ui, 'snapshot', () => true, 15_000);
  const machine: MachineSnapshot | undefined = snap.machines.find(
    (m) => m.online && m.machine.name.toLowerCase().includes(machineFilter.toLowerCase()),
  );
  if (!machine) {
    fail(`no ONLINE machine matching "${machineFilter}" on ${target.ws} — start the agent (see the usage comment) or pass a machine filter`);
  }
  if (machine.canControl !== true) fail(`the fleet-token viewer does not control ${machine.machine.name} — is the hub on dev-token?`);
  const machineId = machine.machine.machineId;
  console.log(`  ✓ machine ${machine.machine.name} (${machineId}) online, canControl`);

  const name = `smoke-${randomUUID().slice(0, 8)}`;
  const created = mustOk<ProjectCreateResult>('projects.create', await rpc(ui, machineId, 'projects.create', { name }));
  assert.equal(created.git, 'init', 'an empty project is git-initialised');
  assert.equal(created.created, true, 'the directory was created, not reused');
  assert.equal(created.label, name);
  assert.equal(path.basename(created.cwd), name);
  console.log(`  ✓ projects.create -> ${created.cwd} git=${created.git} created=${created.created}`);
  if (existsSync(created.cwd)) {
    assert.equal(path.dirname(path.resolve(created.cwd)), projectsRoot, `cwd is directly under the projects root ${projectsRoot}`);
    assert.ok(existsSync(path.join(created.cwd, '.git')), `.git exists in ${created.cwd}`);
    assert.ok(existsSync(path.join(created.cwd, 'README.md')), 'README.md written');
    console.log('  ✓ on disk: under the root, .git and README.md present');
  } else {
    console.log(`  SKIP on-disk check: ${created.cwd} is not on this host (agent elsewhere or a different root) — set CC_REMOTE_PROJECTS_ROOT in both shells`);
  }

  const list = mustOk<ProjectsResult>('projects.list', await rpc(ui, machineId, 'projects.list', {}));
  const listed = list.projects.find((p) => path.resolve(p.cwd) === path.resolve(created.cwd));
  assert.ok(listed, `projects.list contains ${created.cwd}`);
  assert.equal(listed.origin, 'root', 'a session-less repo under the root is origin:root');
  assert.equal(listed.count, 0);
  console.log(`  ✓ projects.list: ${list.projects.length} project(s), ${name} origin=${listed.origin}`);

  const repeat = await rpc(ui, machineId, 'projects.create', { name });
  assert.equal(repeat.ok, false, 'a second create of the same name is an RPC error');
  assert.match(repeat.error ?? '', /already exists/, `error text: ${repeat.error}`);
  console.log(`  ✓ projects.create again -> ok:false "${repeat.error}"`);

  const traversal = await rpc(ui, machineId, 'projects.create', { name: '../x' });
  assert.equal(traversal.ok, false, 'a traversal name is refused');
  assert.ok((traversal.error ?? '').length > 0, 'the refusal carries a message');
  console.log(`  ✓ projects.create {name:'../x'} -> ok:false "${firstIssue(traversal.error ?? '')}"`);
  assert.ok(!existsSync(path.resolve(projectsRoot, '..', 'x')), 'nothing was created outside the root');

  let cloned: ProjectCreateResult | undefined;
  if (cloneUrl) {
    const cloneName = `${name}-clone`;
    cloned = mustOk<ProjectCreateResult>('projects.create (clone)', await rpc(ui, machineId, 'projects.create', { name: cloneName, gitUrl: cloneUrl }));
    assert.equal(cloned.git, 'clone');
    assert.equal(path.basename(cloned.cwd), cloneName);
    console.log(`  ✓ projects.create {gitUrl} -> ${cloned.cwd} git=clone`);
  } else {
    console.log('  SKIP clone: the schema takes https:// URLs only and this smoke will not touch the network unless PROJECTS_SMOKE_CLONE_URL is set');
  }

  const removed = mustOk<ProjectRemoveResult>('projects.remove', await rpc(ui, machineId, 'projects.remove', { cwd: created.cwd }));
  assert.equal(removed.ok, true);
  assert.ok(removed.movedTo && TRASH_RE.test(removed.movedTo), `movedTo is in the agent's trash: ${removed.movedTo}`);
  assert.ok(path.basename(removed.movedTo).startsWith(name), 'the trashed directory keeps its name');
  console.log(`  ✓ projects.remove -> movedTo ${removed.movedTo}`);
  assert.ok(!existsSync(created.cwd), 'the project directory is gone from the root');
  const after = mustOk<ProjectsResult>('projects.list (after remove)', await rpc(ui, machineId, 'projects.list', {}));
  assert.ok(!after.projects.some((p) => path.resolve(p.cwd) === path.resolve(created.cwd)), 'projects.list no longer lists it');
  console.log('  ✓ projects.list: removed project absent');

  // Nothing is ever deleted by the agent — tidy this run's trash ourselves.
  for (const dir of [removed.movedTo, cloned?.cwd]) {
    if (dir && existsSync(dir) && (TRASH_RE.test(dir) || dir.startsWith(projectsRoot + path.sep))) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const outsideRoot = await rpc(ui, machineId, 'projects.remove', { cwd: os.tmpdir() });
  assert.equal(outsideRoot.ok, false, 'removing outside the root is refused');
  console.log(`  ✓ projects.remove outside the root -> ok:false "${outsideRoot.error}"`);
  ui.close();
}

async function memberPart(): Promise<boolean> {
  step('Part 2 — control-share member: projects.create is read-only at the hub');
  if (!target.ssoSecret) {
    console.log('  SKIP: CC_REMOTE_SSO_SECRET not set in this shell — cannot mint the two SSO members');
    return false;
  }
  const secret = target.ssoSecret;
  const a = await ssoLogin(target.http, secret, randomSmokeUser('proj-a', 'Project Owner'));
  const b = await ssoLogin(target.http, secret, randomSmokeUser('proj-b', 'Project Member'));
  const admin = await adminLogin(target.http, secret);
  await adminActivate(target.http, admin, [a.email, b.email]);
  const team = expectStatus('POST /api/workspaces (A)', await api(target.http, a.cookie, 'POST', '/api/workspaces', { name: 'Проекты' }), 201);
  const org = String(team.body['workspaceId']);
  const invite = expectStatus('invite B', await api(target.http, a.cookie, 'POST', `/api/workspaces/${org}/invitations`, { email: b.email, role: 'member' }), 201);
  expectStatus('B accepts', await api(target.http, b.cookie, 'POST', '/api/invitations/accept', { token: invite.body['token'] }), 200);
  const agent = await enrollFakeAgent(target, a, { name: 'proj-box' });
  const root = '/home/a/work';
  expectStatus('A shares /home/a/work (control)', await api(target.http, a.cookie, 'POST', `/api/workspaces/${org}/projects`, { machineId: agent.machineId, root, name: 'work', access: 'control' }), 201);

  const uiB = await connectUiAs(target.ws, b, org);
  const snap = await nextBrowserFrame(uiB, 'snapshot', (s) => s.machines.some((m) => m.machine.machineId === agent.machineId));
  const machine = snap.machines.find((m) => m.machine.machineId === agent.machineId);
  assert.ok(machine && machine.canStart === true && machine.canControl !== true, 'B may start but not control');

  // The agent must NOT receive these: the hub answers itself.
  const leaked: string[] = [];
  agent.ws.on('message', (raw: Buffer) => {
    const text = raw.toString();
    if (text.includes('"rpc_request"') && text.includes('"projects.')) leaked.push(text);
  });
  const denied = await rpc(uiB, agent.machineId, 'projects.create', { name: 'smoke-member', parent: root });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'Read-only workspace access.');
  const deniedRemove = await rpc(uiB, agent.machineId, 'projects.remove', { cwd: `${root}/x` });
  assert.equal(deniedRemove.ok, false);
  assert.equal(deniedRemove.error, 'Read-only workspace access.');
  assert.equal(leaked.length, 0, 'no projects RPC reached the agent');
  console.log(`  ✓ B rpc_request projects.create/remove -> ok:false "${denied.error}" (agent saw nothing)`);

  // The narrow member allowlist still works: models.list IS forwarded (the
  // fake agent never answers it, so only the forwarding is asserted).
  const forwarded = nextAgentFrame(agent.ws, 'rpc_request');
  const allowedId = randomUUID();
  sendUi(uiB, { type: 'rpc_request', requestId: allowedId, machineId: agent.machineId, method: 'models.list', params: {} });
  const seen = await forwarded;
  assert.equal(seen.requestId, allowedId);
  assert.equal(seen.method, 'models.list');
  console.log('  ✓ B rpc_request models.list -> forwarded to the agent (allowlisted)');
  uiB.close();
  agent.ws.close();
  return true;
}

async function main(): Promise<void> {
  console.log(`[projects-smoke] hub ${target.http}`);
  await ownerPart();
  const memberRan = await memberPart();
  clearTimeout(timer);
  console.log(`\nPASS: owner create/list/repeat/traversal/remove OK${memberRan ? ', member read-only refusal OK' : ' (member part skipped)'}`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
