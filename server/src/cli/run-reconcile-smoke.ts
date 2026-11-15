/**
 * Wire test for the run reconciliation: a run the agent does not hold must be
 * closed, its single-writer lock freed, and its viewer told.
 *
 * The hole this closes. The hub's run map was only ever corrected by the agent
 * volunteering a terminal `run_status`. Every path where the agent stops driving
 * a run WITHOUT managing to say so left the hub holding a run that was `working`
 * forever, with its lock still taken. `settle_agent_runs` has always done this
 * reconciliation — but only at reconnect, and only for runs parked in
 * `orphaned_runs`. On 21.09.2026 there was no socket drop, so nothing ran: run
 * b1c58d7e sat open for four hours behind a phone showing «working… 29:00 · нет
 * событий 28 мин», and only a hub redeploy cleared it.
 *
 * Three ends are asserted, because two of them are invisible from the third:
 *   1. the AGENT is ordered to close the run — without this the hub could free a
 *      lock while a start still in flight goes on to launch an unguarded writer,
 *      which is the single-writer invariant the whole product rests on;
 *   2. the VIEWER is told, instead of watching a turn that is never coming;
 *   3. the SESSION opens again — the lock is what made it look permanently busy,
 *      and this is the only end the person actually feels.
 *
 * Then the inverse, which matters just as much: a run the agent DOES list
 * survives an inventory, even after sitting silent past the grace. A long quiet
 * turn inside one `Bash` call is ordinary here (a release build is four minutes)
 * and judging runs by their own quietness would kill real work.
 *
 * Deliberately waits out the REAL `RUN_RECONCILE_GRACE_MS`, rather than adding
 * an env knob to shorten it: the constant is the safety margin that keeps a slow
 * start from being killed, so the constant is what has to be proven.
 *
 * Usage:
 *   CC_REMOTE_SSO_SECRET=… tsx server/src/cli/run-reconcile-smoke.ts [ws://127.0.0.1:4319]
 */
import { WebSocket } from 'ws';
import { decodeCentralToAgent } from '@cc-remote/shared';
import {
  adminActivate,
  adminLogin,
  connectUiAs,
  enrollFakeAgent,
  fail,
  fakeSession,
  nextBrowserFrame,
  sendUi,
  sleep,
  smokeTarget,
  ssoLogin,
  randomSmokeUser,
} from './_harness.js';

const target = smokeTarget(process.argv);
const secret = process.env['CC_REMOTE_SSO_SECRET'];
if (!secret) fail('CC_REMOTE_SSO_SECRET must match the hub under test');

/** The hub's RUN_RECONCILE_GRACE_MS, plus a beat for the serial command loop. */
const GRACE_MS = 120_000;

/** Every `close` the hub ordered, by runId. */
function watchCloses(sock: WebSocket): Set<string> {
  const closed = new Set<string>();
  sock.on('message', (raw: Buffer) => {
    let msg;
    try {
      // Through the shared schema on purpose: this also proves the hub's
      // `json!()` shape still satisfies `CentralToAgent`.
      msg = decodeCentralToAgent(raw.toString());
    } catch {
      return; // not every hub frame is one this fake agent models
    }
    if (msg.type === 'close') closed.add(msg.runId);
  });
  return closed;
}

async function main(): Promise<void> {
  const owner = await ssoLogin(target.http, secret!, randomSmokeUser('run-reconcile', 'Reconcile Owner'));
  // A fresh store puts every arrival on the waitlist, and a waitlisted viewer
  // gets an empty snapshot — which debugs as "the hub is broken".
  const admin = await adminLogin(target.http, secret!);
  await adminActivate(target.http, admin, [owner.email]);
  // NOT /tmp: the web hides service sessions, and a smoke whose session is
  // invisible debugs as an empty screen against a perfectly correct hub.
  const session = fakeSession('/home/smoke/proj', 'reconcile subject');
  const agent = await enrollFakeAgent(target, owner, { name: 'reconcile-smoke', sessions: [session] });
  const closes = watchCloses(agent.ws);
  const ui = await connectUiAs(target.ws, owner);
  await nextBrowserFrame(ui, 'snapshot');

  // ---------------------------------------------------------------- orphan
  console.log('[1/2] a run the agent never drives');
  const opened = nextBrowserFrame(ui, 'opened');
  sendUi(ui, { type: 'open', machineId: agent.machineId, sessionId: session.sessionId });
  // The fake agent deliberately does NOT answer the `resume` — it is the agent
  // that walked away mid-start without a word, which is the whole incident.
  const orphan = (await opened).runId;
  console.log(`  ✓ hub opened run ${orphan.slice(0, 8)} and is now holding it`);

  // Inside the grace the run must be untouchable: this is a healthy agent still
  // doing its pre-launch checks, and killing it here would kill the session the
  // person just asked for.
  agent.ws.send(JSON.stringify({ type: 'run_inventory', runIds: [] }));
  await sleep(1_000);
  if (closes.has(orphan)) fail('the hub retired a run that was seconds old — the start race is not guarded');
  console.log('  ✓ inside the grace an empty inventory does not touch it');

  console.log(`  … waiting out the real grace (${GRACE_MS / 1000}s)`);
  await sleep(GRACE_MS + 2_000);

  const ended = nextBrowserFrame(ui, 'run_status');
  agent.ws.send(JSON.stringify({ type: 'run_inventory', runIds: [] }));

  // End 1: the far end the UI cannot see.
  const status = await ended;
  if (!closes.has(orphan)) fail('the hub freed the run without ordering the agent to close it — a start in flight could still launch an unguarded writer');
  console.log(`  ✓ agent was ordered to close ${orphan.slice(0, 8)}`);

  // End 2: the person stops waiting.
  if (status.runId !== orphan) fail(`run_status named ${status.runId}, not the orphan`);
  if (status.state !== 'error') fail(`viewer was told state=${status.state}, expected error`);
  if (!status.error?.includes('no longer running')) fail(`the reason does not say what happened: ${status.error}`);
  console.log(`  ✓ viewer told: ${status.error}`);

  // End 3: the only end the person feels — the session is usable again.
  const reopened = nextBrowserFrame(ui, 'opened');
  sendUi(ui, { type: 'open', machineId: agent.machineId, sessionId: session.sessionId });
  const second = await Promise.race([
    reopened.then((m) => m.runId),
    sleep(5_000).then(() => undefined),
  ]);
  if (!second) fail('the session still refuses to open — the single-writer lock was never freed, which is the symptom people actually report');
  if (second === orphan) fail('the hub handed back the dead run');
  console.log(`  ✓ session opens again as run ${second.slice(0, 8)} — the lock was really freed`);

  // ---------------------------------------------------------------- live run
  console.log('[2/2] a run the agent still holds');
  // Age it past the grace, then have the agent claim it. A run silent for longer
  // than the grace is the ordinary case (one long tool call), not a dead one.
  await sleep(GRACE_MS + 2_000);
  const beforeCloses = closes.size;
  agent.ws.send(JSON.stringify({ type: 'run_inventory', runIds: [second] }));
  await sleep(1_500);
  if (closes.size !== beforeCloses) fail('the reconciler closed a run the agent explicitly claimed — this would kill live work on every heartbeat');
  console.log('  ✓ a claimed run is left alone however long it has been quiet');

  // And the old-agent case: no `runIds` at all is "no opinion", never "I drive
  // nothing". Half the fleet runs a bundle older than this change.
  agent.ws.send(JSON.stringify({ type: 'run_inventory' }));
  await sleep(1_500);
  if (closes.size !== beforeCloses) fail('an inventory with no runIds was read as an empty list — every run on an older agent would be closed on its first heartbeat');
  console.log('  ✓ an inventory without runIds changes nothing');

  console.log('\nPASS — a run with no writer is retired; a live one is not.');
  agent.ws.close();
  ui.close();
  process.exit(0);
}

main().catch((err) => fail(String(err)));
