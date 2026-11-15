/**
 * The lock refusal must NAME the run it lost to, so a second client can WATCH
 * that run instead of fighting for it.
 *
 * The single-writer rule is not negotiable, but "Session already has an active
 * run." with nothing else in the frame left the web with only a toast — and the
 * web reaches that path exactly when its `activeRuns` is stale (the run exists
 * on the hub but has not arrived in this browser yet), which is the moment the
 * person can least explain why their click did nothing. The CLI has recovered
 * from this since b0503f9 by reading the runId out of the snapshot; the hub now
 * puts it in the refusal itself, which closes the window for every client.
 *
 *   A  opens a session on a fake agent            -> `opened`, the lock is his
 *   B  opens the SAME session                     -> error{code:'run_active', runId}
 *   B  subscribes to that runId                   -> `opened` + the run's stream
 *
 * Start a LOCAL hub with SSO (same env as team-smoke.ts):
 *
 *   CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_PLATFORM_ADMIN_IDS=legacy-owner \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4319 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-smoke.sqlite3 \
 *   cargo run --manifest-path server-rs/Cargo.toml
 *
 *   CC_REMOTE_SSO_SECRET=<same> tsx server/src/cli/run-active-attach-smoke.ts
 *
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_ADMIN_ID, CC_SMOKE_ADMIN_EMAIL.
 */
import assert from 'node:assert/strict';
import {
  adminActivate,
  adminLogin,
  connectUiAs,
  enrollFakeAgent,
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
const CWD = '/home/a/work/proj';

const timer = setTimeout(() => fail('timed out (90s)'), 90_000);

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  console.log(`[run-active-attach-smoke] hub ${target.http}`);

  // ------------------------------------------------- 1. one person, one machine
  // Both sockets are the SAME person on purpose: this smoke is about the lock,
  // not about sharing. Two browser tabs (or a tab and the phone) are the common
  // way to hit it, and they carry identical access — so a refusal here cannot be
  // confused with an access decision.
  step('1. A signs in, admin activates, a fake agent reports one session');
  const a = await ssoLogin(target.http, secret, randomSmokeUser('lock-a', 'Lock Owner'));
  const admin = await adminLogin(target.http, secret);
  await adminActivate(target.http, admin, [a.email]);
  const session = fakeSession(CWD);
  const agent = await enrollFakeAgent(target, a, { name: 'lock-smoke', sessions: [session] });

  // ------------------------------------------------------------ 2. A opens it
  step('2. A opens the session — the lock is his');
  const first = await connectUiAs(target.ws, a);
  await nextBrowserFrame(first, 'snapshot');
  const resumeAtAgent = nextAgentFrame(agent.ws, 'resume');
  sendUi(first, {
    type: 'open',
    machineId: agent.machineId,
    sessionId: session.sessionId,
    message: 'первый писатель',
  });
  const opened = await nextBrowserFrame(first, 'opened');
  await resumeAtAgent;
  console.log(`  ✓ run ${opened.runId} is live and holds the session`);

  // -------------------------------------------- 3. B's open is refused BY NAME
  step('3. A second client opens the same session -> the refusal carries the runId');
  const second = await connectUiAs(target.ws, a);
  await nextBrowserFrame(second, 'snapshot');
  sendUi(second, {
    type: 'open',
    machineId: agent.machineId,
    sessionId: session.sessionId,
    message: 'второй писатель',
  });
  const refusal = await nextBrowserFrame(second, 'error');
  assert.match(refusal.message, /already has an active run/i, 'the sentence people read');
  // The CODE is the contract; the sentence is for people. Matching on prose is
  // what a rewording on either side would break.
  assert.equal(refusal.code, 'run_active', 'the machine-readable reason');
  assert.equal(refusal.runId, opened.runId, 'and the run the client should watch instead');
  console.log(`  ✓ refused with code=run_active runId=${refusal.runId}`);

  // ------------------------------------------ 4. and subscribing on it works
  // The recovery is only real if the SAME frame's runId is subscribable. If the
  // hub ever named a run this viewer cannot join, the web would trade a toast
  // for a silent dead end — worse than what it replaced.
  step('4. Subscribing to that runId attaches the second client');
  sendUi(second, { type: 'subscribe', runId: refusal.runId as string });
  const attached = await nextBrowserFrame(second, 'opened', (m) => m.runId === refusal.runId);
  assert.equal(attached.sessionId, session.sessionId);
  assert.equal(attached.machineId, agent.machineId);
  console.log('  ✓ attached to the live run');

  // ----------------------------------------- 5. and it really receives the run
  step("5. The run's stream reaches the client that could not open it");
  agent.ws.send(
    JSON.stringify({
      type: 'stream',
      sessionId: session.sessionId,
      runId: opened.runId,
      event: { kind: 'assistant', text: 'LOCK-ATTACH-OK' },
    }),
  );
  const streamed = await nextBrowserFrame(second, 'stream', (m) => (m.event.text ?? '').includes('LOCK-ATTACH-OK'));
  assert.equal(streamed.runId, opened.runId);
  console.log('  ✓ live output arrives — watching, not fighting');

  first.close();
  second.close();
  agent.ws.close();
  clearTimeout(timer);
  console.log('\n[run-active-attach-smoke] PASS');
}

main().catch((error) => fail((error as Error).stack ?? String(error)));
