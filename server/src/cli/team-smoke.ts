/**
 * Team smoke: a self-serve community team on one machine, and the control
 * share with `visibility:'everyone'` that lets a member work in the owner's
 * project directory.
 *
 *   A, B  — two fresh HegAI members (SSO minted locally), activated by admin.
 *   A     creates a team, invites B (member), B accepts.
 *   A     enrolls a machine with a device code; a fake agent connects with
 *         the device token and reports two sessions: one inside
 *         /home/a/work/proj, one in /home/a/other.
 *   A     shares /home/a/work/proj with access:'control', visibility:'everyone'.
 *   B     over /ui?workspaceId=<team>: the machine is there with canStart
 *         and without canControl; only the in-root session is listed (the
 *         owner's own — that is what `everyone` opens); `new_session` inside
 *         the root reaches the agent pinned to Codex; outside it is refused
 *         with "That directory isn't shared with you.".
 *
 * Start a LOCAL hub with SSO (same env as wave-smoke.ts):
 *
 *   CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_PLATFORM_ADMIN_IDS=legacy-owner \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4319 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-smoke.sqlite3 \
 *   cargo run --manifest-path server-rs/Cargo.toml
 *
 *   CC_REMOTE_SSO_SECRET=<same> tsx server/src/cli/team-smoke.ts [ws://127.0.0.1:4319] [dev-token]
 *
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_ADMIN_ID, CC_SMOKE_ADMIN_EMAIL.
 */
import assert from 'node:assert/strict';
import {
  adminActivate,
  adminLogin,
  api,
  connectUiAs,
  enrollFakeAgent,
  expectStatus,
  fail,
  fakeSession,
  nextAgentFrame,
  nextBrowserFrame,
  randomSmokeUser,
  sendUi,
  smokeTarget,
  ssoLogin,
  step,
} from './_harness.js';

const target = smokeTarget(process.argv);
const ROOT = '/home/a/work/proj';
const OUTSIDE = '/home/a/other';
const ELSEWHERE = '/home/a/elsewhere';

const timer = setTimeout(() => fail('timed out (90s)'), 90_000);

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  console.log(`[team-smoke] hub ${target.http}`);

  // ------------------------------------------------------ 1. two members
  step('1. Two members sign in; admin activates both');
  const a = await ssoLogin(target.http, secret, randomSmokeUser('team-a', 'Team Owner'));
  const b = await ssoLogin(target.http, secret, randomSmokeUser('team-b', 'Team Member'));
  console.log(`  ✓ A=${a.email}  B=${b.email}`);
  const admin = await adminLogin(target.http, secret);
  await adminActivate(target.http, admin, [a.email, b.email]);

  // ---------------------------------------------------------- 2. the team
  step('2. A creates a team and invites B');
  const created = expectStatus('POST /api/workspaces (A)', await api(target.http, a.cookie, 'POST', '/api/workspaces', { name: 'Смоук' }), 201);
  const org = String(created.body['workspaceId'] ?? '');
  assert.ok(org, `workspaceId: ${created.text}`);
  assert.equal(created.body['kind'], 'organization');
  assert.equal(created.body['role'], 'owner');
  assert.equal(created.body['selfServe'], true, 'a self-serve team');
  assert.ok(typeof created.body['slug'] === 'string' && created.body['slug'], `slug: ${created.text}`);
  console.log(`  ✓ team ${org} slug=${String(created.body['slug'])}`);

  const invite = expectStatus('POST /api/workspaces/{id}/invitations (A -> B)', await api(target.http, a.cookie, 'POST', `/api/workspaces/${org}/invitations`, { email: b.email, role: 'member' }), 201);
  const inviteToken = String(invite.body['token'] ?? '');
  assert.ok(inviteToken, `invitation token: ${invite.text}`);
  assert.equal(invite.body['email'], b.email.toLowerCase());
  assert.equal(invite.body['role'], 'member');

  const accepted = expectStatus('POST /api/invitations/accept (B)', await api(target.http, b.cookie, 'POST', '/api/invitations/accept', { token: inviteToken }), 200);
  assert.equal(accepted.body['workspaceId'], org, 'B joined the team A created');
  const members = expectStatus('GET /api/workspaces/{id}/members (A)', await api(target.http, a.cookie, 'GET', `/api/workspaces/${org}/members`), 200);
  const roles = new Map(((members.body['members'] as Array<Record<string, unknown>> | undefined) ?? []).map((m) => [m['userId'], m['role']]));
  assert.equal(roles.get(a.userId), 'owner');
  assert.equal(roles.get(b.userId), 'member');
  console.log('  ✓ members: A owner, B member');

  // ------------------------------------------------------ 3. A's machine
  step("3. A enrolls a machine; a fake agent reports two sessions");
  const inRoot = fakeSession(ROOT, 'inside the shared root');
  const outside = fakeSession(OUTSIDE, 'outside the shared root');
  const agent = await enrollFakeAgent(target, a, { name: 'a-box', sessions: [inRoot, outside] });

  // B is in the team but nothing is shared yet: the machine must not show.
  const uiB = await connectUiAs(target.ws, b, org);
  const before = await nextBrowserFrame(uiB, 'snapshot');
  assert.equal(before.viewer?.workspace.workspaceId, org, "B's socket is scoped to the team");
  assert.equal(before.viewer?.workspace.role, 'member');
  assert.ok(!before.machines.some((m) => m.machine.machineId === agent.machineId), "A's machine is hidden before any share");
  console.log("  ✓ B (member, nothing shared): A's machine absent from the snapshot");

  // A member cannot publish the owner's machine.
  const notOwner = expectStatus('POST projects as B (not the device owner)', await api(target.http, b.cookie, 'POST', `/api/workspaces/${org}/projects`, { machineId: agent.machineId, root: ROOT, name: 'proj', access: 'control' }), 400);
  assert.match(String(notOwner.body['error']), /device owner/);

  // ----------------------------------------------------------- 4. share
  step("4. A shares the root with access:'control', visibility:'everyone'");
  const shared = nextBrowserFrame(uiB, 'snapshot', (s) => s.machines.some((m) => m.machine.machineId === agent.machineId));
  const share = expectStatus('POST /api/workspaces/{id}/projects (A)', await api(target.http, a.cookie, 'POST', `/api/workspaces/${org}/projects`, { machineId: agent.machineId, root: ROOT, name: 'proj', access: 'control', visibility: 'everyone' }), 201);
  assert.equal(share.body['access'], 'control');
  assert.equal(share.body['visibility'], 'everyone');
  assert.equal(share.body['root'], ROOT);
  const shareId = String(share.body['projectShareId'] ?? '');
  assert.ok(shareId);
  for (const [who, session] of [['A', a], ['B', b]] as const) {
    const list = expectStatus(`GET /api/workspaces/{id}/projects (${who})`, await api(target.http, session.cookie, 'GET', `/api/workspaces/${org}/projects`), 200);
    const row = ((list.body['projects'] as Array<Record<string, unknown>> | undefined) ?? []).find((p) => p['projectShareId'] === shareId);
    assert.ok(row, `${who} sees the share in the project list`);
    assert.equal(row['visibility'], 'everyone', `visibility round-trips for ${who}`);
    assert.equal(row['access'], 'control');
  }
  console.log("  ✓ visibility:'everyone' round-trips in GET projects for owner and member");

  // ------------------------------------------------- 5. B's scoped view
  step("5. B's snapshot: startable machine, sessions filtered to the root");
  const snap = await shared;
  const machine = snap.machines.find((m) => m.machine.machineId === agent.machineId);
  assert.ok(machine, "A's machine appears once the control share exists");
  assert.equal(machine.canStart, true, 'canStart for a control-share member');
  assert.ok(machine.canControl !== true, 'no canControl for a member');
  assert.equal(machine.online, true);
  assert.equal(machine.owner?.userId, a.userId, 'owner badge is A');
  assert.equal(machine.kind, undefined, 'a personal device carries no kind');
  const ids = machine.sessions.map((s) => s.sessionId);
  assert.ok(ids.includes(inRoot.sessionId), "the owner's own in-root session is visible (visibility:'everyone')");
  assert.ok(!ids.includes(outside.sessionId), 'the session outside the root is hidden');
  assert.ok(!('usage' in machine) && !('stats' in machine), 'telemetry is stripped for a non-controlling viewer');
  console.log(`  ✓ machine ${machine.machine.name}: canStart=${machine.canStart} canControl=${String(machine.canControl)} sessions=${ids.length} (in-root only)`);

  // ----------------------------------------------------- 6. new_session
  step('6. B starts a session inside the root -> agent gets it on Codex');
  const forwarded = nextAgentFrame(agent.ws, 'new_session');
  const opened = nextBrowserFrame(uiB, 'opened');
  sendUi(uiB, { type: 'new_session', machineId: agent.machineId, cwd: ROOT, message: 'hi' });
  const cmd = await forwarded;
  assert.equal(cmd.cwd, ROOT);
  assert.equal(cmd.message, 'hi');
  assert.equal(cmd.source, 'codex', 'a member on someone else\'s machine is pinned to Codex');
  const run = await opened;
  assert.equal(run.runId, cmd.runId, 'the browser is attached to the run the agent received');
  assert.equal(run.machineId, agent.machineId);
  console.log(`  ✓ agent received new_session run=${cmd.runId.slice(0, 8)} cwd=${cmd.cwd} source=${cmd.source}`);
  sendUi(uiB, { type: 'close', runId: run.runId });

  step('7. B starts a session outside the root -> refused');
  const refusal = nextBrowserFrame(uiB, 'error');
  sendUi(uiB, { type: 'new_session', machineId: agent.machineId, cwd: ELSEWHERE, message: 'hi' });
  const err = await refusal;
  assert.equal(err.message, "That directory isn't shared with you.");
  console.log(`  ✓ new_session ${ELSEWHERE} -> "${err.message}"`);

  // The owner's own view is unfiltered.
  const uiA = await connectUiAs(target.ws, a, org);
  const snapA = await nextBrowserFrame(uiA, 'snapshot', (s) => s.machines.some((m) => m.machine.machineId === agent.machineId));
  const mine = snapA.machines.find((m) => m.machine.machineId === agent.machineId);
  assert.ok(mine);
  assert.equal(mine.canControl, true, 'the owner controls the machine');
  const mineIds = mine.sessions.map((s) => s.sessionId);
  assert.ok(mineIds.includes(inRoot.sessionId) && mineIds.includes(outside.sessionId), 'the owner sees both sessions');
  console.log('  ✓ A (owner) sees both sessions with canControl');

  clearTimeout(timer);
  uiA.close();
  uiB.close();
  agent.ws.close();
  console.log(`\nPASS: team ${org} — invite accepted, control share visible to the member (everyone), in-root start forwarded on Codex, out-of-root refused`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
