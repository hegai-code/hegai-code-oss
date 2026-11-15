/**
 * Community-access smoke: a fresh HegAI member goes waitlist -> active ->
 * suspended -> active, an address nobody has signed in with is opened BEFORE
 * its first login, and every gate along the way answers the way the web
 * expects it to.
 *
 *   0. Pre-authorization: the admin grants an address the hub has never seen
 *      -> `pending`, it appears in `pending[]`, a second grant is
 *      `already_pending`; that person then signs in for the first time and is
 *      active on the FIRST read — never waitlisted for a moment. A third
 *      address is granted and revoked.
 *   1. SSO login (JWT minted locally with the hub's secret) -> /api/me says
 *      `waitlist` / `community`.
 *   2. Waitlisted: POST /api/enrollments and POST /api/workspaces -> 403
 *      `access_not_active`; over /ui the snapshot is empty and `new_session`
 *      is refused with the waiting-list text.
 *   3. Admin opens access by email -> /api/me says `active`, carries `seat`
 *      and `sandbox`.
 *   4. If the hub has the provisioning routes: claim the sandbox job as the
 *      provisioner, enroll a fake sandbox agent with the job's code, report
 *      the result -> sandbox `ready`, the machine shows `kind:'sandbox'`.
 *      Otherwise that block is SKIPped with a line saying why.
 *   5. Admin suspends -> /api/me `suspended`; on the OPEN /ui socket a
 *      `new_session` is refused with «Доступ приостановлен.».
 *   6. Admin reactivates -> `active` again, an enrollment code can be minted.
 *
 * Start a LOCAL hub with SSO and a fresh database:
 *
 *   CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_PLATFORM_ADMIN_IDS=legacy-owner \
 *   CC_REMOTE_PROVISIONER_TOKEN=smoke-provisioner-0123456789-0123456789 \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4319 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-smoke.sqlite3 \
 *   cargo run --manifest-path server-rs/Cargo.toml
 *
 * (`legacy-owner` is the hub's default `CC_REMOTE_BOOTSTRAP_USER_ID`; with the
 * `dev-token` fleet token the bootstrap user is also who an un-cookied API
 * call resolves to, but this smoke signs the admin in through SSO so it works
 * against a hub with a real token too. Secrets must be >=32 chars or the hub
 * silently disables SSO; the provisioner token must also differ from
 * CC_REMOTE_TOKEN or `/api/provisioning/*` stays 404.)
 *
 * Then, with the SAME secret (and provisioner token, if any) in this shell:
 *
 *   CC_REMOTE_SSO_SECRET=<same> CC_REMOTE_PROVISIONER_TOKEN=<same> \
 *     tsx server/src/cli/access-smoke.ts [ws://127.0.0.1:4319] [dev-token]
 *
 * Do NOT run against a hub with CC_REMOTE_ACCESS_DEFAULT=active: every first
 * login is active there, and step 0 would prove nothing.
 *
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_ADMIN_ID (default
 * legacy-owner), CC_SMOKE_ADMIN_EMAIL (default owner@localhost).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  adminActivate,
  adminGrant,
  adminLogin,
  adminRevoke,
  api,
  connectAgentWs,
  connectUiAs,
  expectStatus,
  fail,
  nextAgentFrame,
  nextBrowserFrame,
  randomSmokeUser,
  sendUi,
  sleep,
  smokeTarget,
  ssoLogin,
  type SsoSession,
  step,
} from './_harness.js';

const target = smokeTarget(process.argv);
const provisionerToken = process.env['CC_REMOTE_PROVISIONER_TOKEN']?.trim() || undefined;
/** The provisioner host this smoke pretends to be (`[A-Za-z0-9._-]`, ≤64). */
const HOST = 'smoke-host';

/** One call on the provisioner's routes, with its bearer (if we have one). */
function provision(method: string, route: string, body?: unknown) {
  return api(target.http, undefined, method, route, body, provisionerToken ? { authorization: `Bearer ${provisionerToken}` } : {});
}

/** `POST /api/provisioning/jobs/claim` as `host` — 200 + job, or 204 when idle. */
function claim(host: string = HOST) {
  return provision('POST', '/api/provisioning/jobs/claim', { host, capacity: { slots: 1, smoke: true } });
}

/** A claimed job of `kind` for `userId`, or a failure naming the mismatch. */
function expectClaim(res: Awaited<ReturnType<typeof claim>>, kind: string, userId: string): Record<string, unknown> {
  if (res.status === 204) fail(`expected a ${kind} job to claim for ${userId}, the queue answered 204 (nothing for ${HOST})`);
  expectStatus(`POST /api/provisioning/jobs/claim (${kind})`, res, 200);
  const job = res.body;
  assert.ok(typeof job['jobId'] === 'string' && job['jobId'], `claimed job has a jobId: ${res.text}`);
  assert.equal(job['kind'], kind, `claimed job kind: ${res.text}`);
  const user = job['user'] as Record<string, unknown> | undefined;
  assert.equal(user?.['userId'], userId, `claimed job belongs to ${userId} — older queued jobs on a persistent DB? (use a fresh CC_REMOTE_DB_PATH): ${res.text}`);
  return job;
}

/** What the provisioner does with a sandbox enrollment code: exchange it for
 *  a device token and bring the sandbox agent up under that token. */
async function enrollSandboxAgent(code: string, machineId: string, name: string, ownerUserId: string): Promise<WebSocket> {
  const exchange = expectStatus(
    'POST /api/enrollments/exchange (sandbox code)',
    await api(target.http, undefined, 'POST', '/api/enrollments/exchange', {
      code,
      machine: { machineId, name, os: 'linux', agentVersion: 'smoke' },
    }),
    200,
  );
  assert.equal(exchange.body['kind'], 'sandbox', `a sandbox code enrolls a sandbox device: ${exchange.text}`);
  assert.equal(exchange.body['ownerUserId'], ownerUserId, 'the sandbox belongs to the member');
  const deviceToken = String(exchange.body['deviceToken'] ?? '');
  assert.ok(deviceToken, 'exchange returned a deviceToken');
  const ws = await connectAgentWs(target.ws, deviceToken);
  const ack = nextAgentFrame(ws, 'register_ack');
  ws.send(JSON.stringify({
    type: 'register',
    protocol: 1,
    machine: { machineId, name, os: 'linux', agentVersion: 'smoke' },
    agentInstanceId: randomUUID(),
  }));
  await ack;
  console.log(`  ✓ fake sandbox agent ${name} (${machineId}) registered with its device token`);
  return ws;
}

const timer = setTimeout(() => fail('timed out (90s)'), 90_000);

async function me(session: SsoSession): Promise<Record<string, unknown>> {
  const res = await api(target.http, session.cookie, 'GET', '/api/me');
  if (res.status !== 200) fail(`/api/me answered ${res.status}: ${res.text}`);
  return res.body;
}

function accessOf(viewer: Record<string, unknown>): Record<string, unknown> {
  const access = viewer['access'];
  if (!access || typeof access !== 'object') fail(`/api/me carries no access block: ${JSON.stringify(viewer)}`);
  return access as Record<string, unknown>;
}

/** Wait until the open /ui socket has re-derived the viewer into `state`. */
async function waitForViewerState(ui: WebSocket, state: string): Promise<void> {
  await nextBrowserFrame(ui, 'snapshot', (s) => s.viewer?.access?.state === state, 8_000).catch(() => {
    // RefreshWorkspaceState fans a snapshot out on every access change; if it
    // was missed (already delivered before we listened) the hub-side state is
    // still what we are about to assert on, so fall through after a pause.
    return sleep(500);
  });
}

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  console.log(`[access-smoke] hub ${target.http}`);

  // --------------------------------------------- 0. pre-authorization
  // The one path that does not exist anywhere else: opening the product for
  // an address before an account exists. `randomSmokeUser` invents an id and
  // an @smoke.invalid address the hub has provably never seen, and the JWT is
  // minted with the hub's own secret — so this is a genuine first login.
  step('0. An address nobody has signed in with is opened before the first login');
  const admin0 = await adminLogin(target.http, secret);
  const preClaims = randomSmokeUser('preauth', 'Preauth Smoke');
  const granted = await adminGrant(target.http, admin0, preClaims.email);
  assert.equal(granted['status'], 'pending', `unknown address is remembered: ${JSON.stringify(granted)}`);
  const listed = expectStatus('admin access listing', await api(target.http, admin0.cookie, 'GET', '/api/admin/access?state=waitlist'), 200);
  const pendingRows = (listed.body['pending'] as Array<Record<string, unknown>> | undefined) ?? [];
  assert.ok(pendingRows.some((p) => p['email'] === preClaims.email && typeof p['createdAt'] === 'number'), `pending[] carries ${preClaims.email}: ${listed.text}`);
  const twice = await adminGrant(target.http, admin0, preClaims.email);
  assert.equal(twice['reason'], 'already_pending', `a second grant is already_pending: ${JSON.stringify(twice)}`);

  const preMember = await ssoLogin(target.http, secret, preClaims);
  // The FIRST read after the first login. Anything but `active` here means the
  // waiting screen flashed, which is the whole thing this path exists to avoid.
  const preAccess = accessOf(await me(preMember));
  assert.equal(preAccess['state'], 'active', 'active on the first read, never waitlisted');
  assert.equal(preAccess['plan'], 'community', 'plan');
  assert.ok(preAccess['seat'] && preAccess['sandbox'], 'the activation hooks ran at login');
  const afterLogin = expectStatus('admin access listing after the claim', await api(target.http, admin0.cookie, 'GET', '/api/admin/access?state=active'), 200);
  const stillPending = (afterLogin.body['pending'] as Array<Record<string, unknown>> | undefined) ?? [];
  assert.ok(!stillPending.some((p) => p['email'] === preClaims.email), 'the promise left pending[]');
  assert.ok(((afterLogin.body['users'] as Array<Record<string, unknown>>) ?? []).some((u) => u['email'] === preClaims.email && u['userId'] === preMember.userId), 'and became a real row');
  console.log(`  ✓ ${preClaims.email}: pending -> first login -> active (${String(preAccess['sandbox'] && (preAccess['sandbox'] as Record<string, unknown>)['status'])})`);

  // The hooks ran at LOGIN, not at an admin call: the proof is a job on the
  // queue for a person no admin touched after they existed. Claiming it also
  // clears the queue for step 4 — this smoke is the only provisioner around,
  // and a job left queued here would be handed out there instead.
  const preJob = await claim();
  if (preJob.status === 204) {
    console.log('  · no sandbox_create queued — this hub has no provisioning routes');
  } else {
    const job = expectClaim(preJob, 'sandbox_create', preMember.userId);
    expectStatus('result {ok:false} (preauth sandbox, not built by this smoke)', await provision('POST', `/api/provisioning/jobs/${String(job['jobId'])}/result`, { ok: false, error: 'access-smoke: claimed to clear the queue', retryable: false }), 200);
    console.log(`  ✓ sandbox_create for ${preClaims.email} was queued by the FIRST LOGIN and claimed`);
  }

  // A promise can be taken back while nobody has used it; a claimed one cannot.
  const throwaway = randomSmokeUser('revoke');
  assert.equal((await adminGrant(target.http, admin0, throwaway.email))['status'], 'pending', 'granted');
  assert.ok(await adminRevoke(target.http, admin0, throwaway.email), 'revoked');
  assert.ok(!(await adminRevoke(target.http, admin0, throwaway.email)), 'a second revoke removes nothing');
  assert.ok(!(await adminRevoke(target.http, admin0, preClaims.email)), 'a claimed promise is not revocable');
  console.log('  ✓ grant -> revoke -> revoke again = false');

  // ------------------------------------------------------------ 1. login
  step('1. SSO login as a brand-new member');
  const claims = randomSmokeUser('access', 'Access Smoke');
  const member = await ssoLogin(target.http, secret, claims);
  console.log(`  ✓ signed in as ${member.email} (${member.userId})`);
  let viewer = await me(member);
  assert.equal(viewer['userId'], member.userId, 'viewer.userId');
  let access = accessOf(viewer);
  assert.equal(access['state'], 'waitlist', 'a first login lands on the waitlist');
  assert.equal(access['plan'], 'community', 'a member is on the community plan');
  console.log(`  ✓ /api/me: state=${String(access['state'])} plan=${String(access['plan'])}`);

  // --------------------------------------------------- 2. waitlist gates
  step('2. Waitlisted: mutations are refused with access_not_active');
  const enrollDenied = expectStatus('POST /api/enrollments (waitlisted)', await api(target.http, member.cookie, 'POST', '/api/enrollments'), 403);
  assert.equal(enrollDenied.body['error'], 'access_not_active');
  assert.equal(enrollDenied.body['state'], 'waitlist');
  const teamDenied = expectStatus('POST /api/workspaces (waitlisted)', await api(target.http, member.cookie, 'POST', '/api/workspaces', { name: 'Смоук' }), 403);
  assert.equal(teamDenied.body['error'], 'access_not_active');

  const waitingUi = await connectUiAs(target.ws, member);
  const waitingSnap = await nextBrowserFrame(waitingUi, 'snapshot');
  assert.equal(waitingSnap.viewer?.access?.state, 'waitlist', 'snapshot.viewer.access.state');
  assert.equal(waitingSnap.machines.length, 0, 'a waitlisted viewer sees no machines');
  const waitingRefusal = nextBrowserFrame(waitingUi, 'error');
  sendUi(waitingUi, { type: 'new_session', machineId: 'no-such-machine', cwd: '/tmp', message: 'hi' });
  const refused = await waitingRefusal;
  assert.match(refused.message, /списке ожидания/, 'the waiting-list refusal text');
  console.log(`  ✓ /ui: empty snapshot, new_session -> "${refused.message}"`);
  waitingUi.close();

  // ------------------------------------------------------- 3. activation
  step('3. Admin opens access for one address');
  const admin = await adminLogin(target.http, secret);
  console.log(`  ✓ admin ${admin.userId} signed in`);
  await adminActivate(target.http, admin, [member.email]);
  viewer = await me(member);
  access = accessOf(viewer);
  assert.equal(access['state'], 'active', 'activated');
  const seat = access['seat'] as Record<string, unknown> | undefined;
  const sandbox = access['sandbox'] as Record<string, unknown> | undefined;
  assert.ok(seat && typeof seat['status'] === 'string', 'access.seat.status present');
  assert.ok(sandbox && typeof sandbox['status'] === 'string', 'access.sandbox.status present');
  assert.ok(['none', 'pending', 'ready', 'failed', 'inactive'].includes(String(seat['status'])), `seat.status enum: ${String(seat['status'])}`);
  assert.ok(['none', 'queued', 'running', 'ready', 'failed', 'suspended'].includes(String(sandbox['status'])), `sandbox.status enum: ${String(sandbox['status'])}`);
  console.log(`  ✓ /api/me: state=active seat.status=${String(seat['status'])} sandbox.status=${String(sandbox['status'])}`);
  if (sandbox['status'] === 'none') {
    console.log('  · sandbox.status is "none": the activation hooks have not enqueued a sandbox_create job on this hub');
  }
  // Opening it twice is idempotent: the second call reports already_active.
  const again = await adminGrant(target.http, admin, member.email);
  assert.equal(again['status'], 'skipped', `second grant is skipped: ${JSON.stringify(again)}`);
  assert.equal(again['reason'], 'already_active', `second grant reason: ${JSON.stringify(again)}`);
  console.log('  ✓ second grant -> skipped already_active');

  // --------------------------------------------------- 4. provisioning
  step('4. Sandbox provisioning (claim -> enroll -> heartbeat -> result)');
  let sandboxMachineId: string | undefined;
  let sandboxAgent: WebSocket | undefined;
  /** True when the claim carried the dev placeholder key, i.e. no real LLM
   *  gateway — then the seat flips synchronously and can be asserted on. */
  let devGateway = false;
  const probe = await claim();
  if (probe.status === 404 || probe.status === 405 || /text\/html/.test(probe.headers.get('content-type') ?? '')) {
    console.log(`  SKIP: POST /api/provisioning/jobs/claim answers ${probe.status} — provisioning is off on this hub (routes not landed, or CC_REMOTE_PROVISIONER_TOKEN unset/short/equal to the fleet token)`);
  } else if (!provisionerToken) {
    console.log(`  SKIP: the route exists (HTTP ${probe.status}) but CC_REMOTE_PROVISIONER_TOKEN is not set in this shell`);
  } else if (probe.status === 401 || probe.status === 403) {
    fail(`provisioner token rejected by /api/provisioning/jobs/claim (HTTP ${probe.status}): ${probe.text}`);
  } else if (probe.status === 204) {
    console.log(`  SKIP: claim answered 204 (nothing queued for ${HOST}) — activation did not enqueue sandbox_create for ${member.email}, or the seat is not ready (sandbox.status=${String(sandbox['status'])} seat.status=${String(seat['status'])})`);
  } else {
    const job = expectClaim(probe, 'sandbox_create', member.userId);
    const code = (job['enrollment'] as Record<string, unknown> | undefined)?.['code'];
    assert.ok(typeof code === 'string' && code, `claim carries enrollment.code: ${probe.text}`);
    const sandboxSpec = job['sandbox'] as Record<string, unknown>;
    const machineName = String(sandboxSpec['machineName'] ?? '');
    assert.match(machineName, /^sb-[a-z0-9-]{2,24}$/, `sandbox.machineName is the unix user: ${machineName}`);
    assert.equal(sandboxSpec['unixUser'], machineName);
    assert.equal((job['hub'] as Record<string, unknown>)['centralUrl'], target.ws.replace(/\/$/, ''), 'hub.centralUrl is this hub in ws form');
    const gateway = job['gateway'] as Record<string, unknown> | undefined;
    assert.ok(gateway && typeof gateway['apiKey'] === 'string' && typeof gateway['baseUrl'] === 'string', `claim carries the gateway seat (dev placeholder without LLM_GATEWAY_URL): ${probe.text}`);
    assert.equal(sandbox['status'], 'queued', 'sandbox.status was queued by the activation hook');
    devGateway = gateway['apiKey'] === 'sk-bf-dev';
    console.log(`  ✓ claimed job ${String(job['jobId'])} (sandbox_create) for ${member.email}: ${machineName}, gateway ${String(gateway['baseUrl'])}${devGateway ? ' (dev placeholder key)' : ''}`);
    // A second claim from another host gets nothing: the job is held.
    const held = await claim('smoke-host-2');
    assert.equal(held.status, 204, `the running job is not offered twice: ${held.status} ${held.text}`);
    expectStatus(`POST /api/provisioning/jobs/${String(job['jobId'])}/heartbeat`, await provision('POST', `/api/provisioning/jobs/${String(job['jobId'])}/heartbeat`), 204);

    sandboxMachineId = `sandbox-${randomUUID().slice(0, 8)}`;
    sandboxAgent = await enrollSandboxAgent(code, sandboxMachineId, machineName, member.userId);

    const done = expectStatus(
      `POST /api/provisioning/jobs/${String(job['jobId'])}/result {ok:true}`,
      await provision('POST', `/api/provisioning/jobs/${String(job['jobId'])}/result`, { ok: true, machineId: sandboxMachineId }),
      200,
    );
    assert.equal(done.body['accepted'], true, `result accepted: ${done.text}`);
    assert.equal(done.body['status'], 'done', `job status after the result: ${done.text}`);
    viewer = await me(member);
    access = accessOf(viewer);
    const sb = access['sandbox'] as Record<string, unknown>;
    assert.equal(sb['status'], 'ready', `sandbox.status after the result: ${JSON.stringify(sb)}`);
    assert.equal(sb['machineId'], sandboxMachineId, 'sandbox.machineId is the enrolled machine');
    assert.equal(sb['machineName'], machineName, 'sandbox.machineName is the sb-<slug> device');
    console.log(`  ✓ /api/me: sandbox.status=ready machineId=${sandboxMachineId} machineName=${machineName}`);
    // A late duplicate result is acknowledged, not applied.
    const late = expectStatus('late duplicate result', await provision('POST', `/api/provisioning/jobs/${String(job['jobId'])}/result`, { ok: true, machineId: sandboxMachineId }), 200);
    assert.equal(late.body['accepted'], false, `a finished job takes no second result: ${late.text}`);
  }

  // -------------------------------------------------- 5. active over /ui
  step('5. Active over /ui');
  const ui = await connectUiAs(target.ws, member);
  const snap = await nextBrowserFrame(ui, 'snapshot');
  assert.equal(snap.viewer?.access?.state, 'active', 'snapshot.viewer.access.state');
  console.log(`  ✓ snapshot: viewer active, ${snap.machines.length} machine(s)`);
  if (sandboxMachineId) {
    const machine = snap.machines.find((m) => m.machine.machineId === sandboxMachineId);
    assert.ok(machine, 'the sandbox machine is in the member\'s snapshot');
    assert.equal(machine.kind, 'sandbox', 'machine.kind');
    assert.equal(machine.canControl, true, 'the owner controls their sandbox');
    console.log(`  ✓ machine ${machine.machine.name}: kind=sandbox canControl=true online=${machine.online}`);
  }

  // ----------------------------------------------------- 6. suspension
  step('6. Admin suspends');
  const suspended = expectStatus('admin suspend', await api(target.http, admin.cookie, 'POST', '/api/admin/access/suspend', { userIds: [member.userId], reason: 'smoke' }), 200);
  const suspendedIds = ((suspended.body['suspended'] as Array<Record<string, unknown>> | undefined) ?? []).map((s) => s['userId']);
  assert.ok(suspendedIds.includes(member.userId), `suspend listed the member: ${suspended.text}`);
  viewer = await me(member);
  access = accessOf(viewer);
  assert.equal(access['state'], 'suspended', '/api/me after suspend');
  console.log('  ✓ /api/me: state=suspended');
  await waitForViewerState(ui, 'suspended');
  const suspendedRefusal = nextBrowserFrame(ui, 'error');
  sendUi(ui, { type: 'new_session', machineId: sandboxMachineId ?? 'no-such-machine', cwd: '/tmp', message: 'hi' });
  const refusal = await suspendedRefusal;
  assert.match(refusal.message, /приостановлен/, 'the suspended refusal text');
  console.log(`  ✓ /ui new_session (suspended) -> "${refusal.message}"`);
  const enrollSuspended = expectStatus('POST /api/enrollments (suspended)', await api(target.http, member.cookie, 'POST', '/api/enrollments'), 403);
  assert.equal(enrollSuspended.body['state'], 'suspended');
  if (sandboxMachineId) {
    // The suspend hook queued a sandbox_suspend pinned to the host that holds
    // the sandbox; another host sees nothing.
    const elsewhere = await claim('smoke-host-2');
    assert.equal(elsewhere.status, 204, `a pinned job is not offered to another host: ${elsewhere.status} ${elsewhere.text}`);
    const job = expectClaim(await claim(), 'sandbox_suspend', member.userId);
    assert.equal(job['enrollment'], undefined, 'a suspend carries no enrollment code');
    const done = expectStatus('result {ok:true} (sandbox_suspend)', await provision('POST', `/api/provisioning/jobs/${String(job['jobId'])}/result`, { ok: true }), 200);
    assert.equal(done.body['status'], 'done');
    viewer = await me(member);
    access = accessOf(viewer);
    const sb = access['sandbox'] as Record<string, unknown>;
    assert.equal(sb['status'], 'suspended', `sandbox.status after sandbox_suspend: ${JSON.stringify(sb)}`);
    if (devGateway) assert.equal((access['seat'] as Record<string, unknown>)['status'], 'inactive', 'the seat is inactive while suspended (dev hub, synchronous)');
    console.log(`  ✓ sandbox_suspend claimed on ${HOST} and applied: sandbox.status=suspended seat.status=${String((access['seat'] as Record<string, unknown>)['status'])}`);
  }

  // --------------------------------------------------- 7. reactivation
  step('7. Admin reactivates');
  const reactivated = expectStatus('admin reactivate', await api(target.http, admin.cookie, 'POST', '/api/admin/access/reactivate', { userIds: [member.userId] }), 200);
  const reactivatedIds = ((reactivated.body['reactivated'] as Array<Record<string, unknown>> | undefined) ?? []).map((s) => s['userId']);
  assert.ok(reactivatedIds.includes(member.userId), `reactivate listed the member: ${reactivated.text}`);
  viewer = await me(member);
  access = accessOf(viewer);
  assert.equal(access['state'], 'active', '/api/me after reactivate');
  const enrollAgain = expectStatus('POST /api/enrollments (active again)', await api(target.http, member.cookie, 'POST', '/api/enrollments'), 201);
  assert.ok(typeof enrollAgain.body['code'] === 'string', 'an enrollment code is minted again');
  await waitForViewerState(ui, 'active');
  console.log('  ✓ /api/me: state=active, enrollment code minted');
  if (sandboxMachineId) {
    // Reactivation queues a sandbox_resume with a FRESH enrollment code; the
    // provisioner re-enrolls the same machine id (the old credential is
    // revoked in the same transaction) and reports ok -> ready again.
    const job = expectClaim(await claim(), 'sandbox_resume', member.userId);
    const code = (job['enrollment'] as Record<string, unknown> | undefined)?.['code'];
    assert.ok(typeof code === 'string' && code, `a resume carries a fresh enrollment code: ${JSON.stringify(job)}`);
    assert.equal((job['sandbox'] as Record<string, unknown>)['machineId'], sandboxMachineId, 'the resume names the existing machine');
    sandboxAgent?.close();
    sandboxAgent = await enrollSandboxAgent(code, sandboxMachineId, String((job['sandbox'] as Record<string, unknown>)['machineName']), member.userId);
    const done = expectStatus('result {ok:true} (sandbox_resume)', await provision('POST', `/api/provisioning/jobs/${String(job['jobId'])}/result`, { ok: true, machineId: sandboxMachineId }), 200);
    assert.equal(done.body['status'], 'done');
    viewer = await me(member);
    access = accessOf(viewer);
    const sb = access['sandbox'] as Record<string, unknown>;
    assert.equal(sb['status'], 'ready', `sandbox.status after sandbox_resume: ${JSON.stringify(sb)}`);
    if (devGateway) assert.equal((access['seat'] as Record<string, unknown>)['status'], 'ready', 'the seat is ready again (dev hub, synchronous)');
    assert.equal((await claim()).status, 204, 'the queue is empty once the lifecycle is done');
    console.log(`  ✓ sandbox_resume claimed, re-enrolled ${sandboxMachineId}, applied: sandbox.status=ready`);
  }

  // The admin cannot be suspended (privileged) — the page must not mislead.
  const selfLock = expectStatus('admin suspend (self)', await api(target.http, admin.cookie, 'POST', '/api/admin/access/suspend', { userIds: [admin.userId] }), 200);
  const privileged = ((selfLock.body['skipped'] as Array<Record<string, unknown>> | undefined) ?? []).find((s) => s['userId'] === admin.userId);
  assert.equal(privileged?.['reason'], 'privileged', `an admin is skipped as privileged: ${selfLock.text}`);
  console.log('  ✓ suspending an admin -> skipped privileged');

  // ------------------------------------------- 8. invitation = activation
  // The member is active again. They make a team and invite an address
  // nobody has signed in with; that person signs in (waitlist), accepts —
  // and is active from the acceptance, with no admin in the loop. The
  // inviter's share is counted from the audit trail: a second invitee under a
  // share of one stays in the team but on the waitlist.
  step('8. Accepting an invitation from an active owner opens access');
  const team = expectStatus('POST /api/workspaces (member makes a team)', await api(target.http, member.cookie, 'POST', '/api/workspaces', { name: 'Смоук-приглашение' }), 201);
  const teamId = String(team.body['workspaceId'] ?? '');
  assert.ok(teamId, `team created: ${team.text}`);
  const inviteeClaims = randomSmokeUser('invitee', 'Invitee Smoke');
  const invitation = expectStatus('POST invitations', await api(target.http, member.cookie, 'POST', `/api/workspaces/${teamId}/invitations`, { email: inviteeClaims.email, role: 'member' }), 201);
  const inviteToken = String(invitation.body['token'] ?? '');
  assert.ok(inviteToken, `invitation token: ${invitation.text}`);
  const invitee = await ssoLogin(target.http, secret, inviteeClaims);
  assert.equal(accessOf(await me(invitee))['state'], 'waitlist', 'the invitee lands on the waitlist first');
  const accepted = expectStatus('POST /api/invitations/accept (invitee)', await api(target.http, invitee.cookie, 'POST', '/api/invitations/accept', { token: inviteToken }), 200);
  assert.equal(accepted.body['activated'], true, `acceptance activated: ${accepted.text}`);
  const inviteeAccess = accessOf(await me(invitee));
  assert.equal(inviteeAccess['state'], 'active', 'active right after accepting — no admin touched it');
  assert.equal(inviteeAccess['plan'], 'community');
  console.log(`  ✓ ${inviteeClaims.email}: invited by ${member.email} -> accepted -> active`);
  // The hooks ran: a sandbox_create sits on the queue for the invitee. Claim
  // it so nothing is left behind for the next run.
  const inviteeJob = await claim();
  if (inviteeJob.status !== 204) {
    const job = expectClaim(inviteeJob, 'sandbox_create', invitee.userId);
    expectStatus('result {ok:false} (invitee sandbox, not built by this smoke)', await provision('POST', `/api/provisioning/jobs/${String(job['jobId'])}/result`, { ok: false, error: 'access-smoke: claimed to clear the queue', retryable: false }), 200);
    console.log('  ✓ sandbox_create queued by the acceptance and claimed');
  }
  // A spent token opens nothing more.
  const spent = expectStatus('POST /api/invitations/accept (spent token)', await api(target.http, invitee.cookie, 'POST', '/api/invitations/accept', { token: inviteToken }), 400);
  assert.ok(String(spent.body['error'] ?? '').length > 0, 'a spent token is refused');
  console.log('  ✓ a spent invitation is refused, nothing re-activated');

  clearTimeout(timer);
  ui.close();
  sandboxAgent?.close();
  console.log(`\nPASS: ${member.email} waitlist -> active -> suspended -> active${sandboxMachineId ? ', sandbox provisioned' : ' (provisioning block skipped)'}; ${inviteeClaims.email} active by invitation`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
