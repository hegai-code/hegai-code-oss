/**
 * fleet-smoke — the fleet API (server-rs/src/fleet_api.rs, hub/fleet.rs) against
 * a throwaway hub with fake agents: a session on one machine starts and
 * continues sessions on the owner's others, and nobody else can.
 *
 * The hub must know the smoke's keys, and nothing else: the task registry is
 * open to every non-sandbox fleet key (it was Teo-only by environment; Teo is
 * gone, and the key already names the machine and the owner). Print the line
 * and start the hub with it:
 *
 *   tsx server/src/cli/fleet-smoke.ts --print-env     # -> CC_REMOTE_FLEET_API_KEYS=...
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/fleet-smoke.ts ws://127.0.0.1:4319
 *
 * What it presses:
 *   1. no key / a wrong key → 401; the key of an `sb-` machine → 403, even
 *      though the hub lists it;
 *   2. `machines` lists the owner's machines — not a stranger's, not the
 *      owner's own sandbox; a sandbox is refused as a TARGET too (404);
 *   3. spawn by machine NAME → the target agent gets `new_session` with the
 *      cwd and the text; status is `working` at once (never the stale idle);
 *   4. the turn ends → status `idle` with the answer as `lastText`;
 *   5. send to the idle run → `input` reaches the agent; a second send while
 *      it works → 409, nothing reaches the agent; the turn fails → status
 *      says `failed` after the agent settles it idle; a model for an open
 *      run → 400;
 *   6. send by machine:sessionId to a dormant session → `resume` + `input`;
 *   7. send to a session live in an editor (livePid) → 409, no resume sent —
 *      the single-writer refusal is the one browsers meet;
 *   8. spawn on a stranger's machine → 404;
 *   9. the task registry (`/api/fleet/tasks`, `--task`): the holder's key files,
 *      reads, moves and links tasks, and so does a second non-sandbox key of the
 *      owner; a sandbox key and no key are refused (403 / 401) — including
 *      `taskId` on a spawn, which then starts nothing; a missing task is 404
 *      before anything is spawned;
 *      `spawn --task` links the RUN, and `session_started` fills in the session;
 *      a session that works for one task is refused for another (409); a
 *      sandbox or a stranger's machine cannot be linked (404).
 */
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import {
  adminActivate,
  adminLogin,
  api,
  connectUiAs,
  enrollFakeAgent,
  fail,
  fakeSession,
  nextAgentFrame,
  nextBrowserFrame,
  randomSmokeUser,
  sleep,
  smokeTarget,
  ssoLogin,
} from './_harness.js';

const HOLDER = { machineId: 'fleet-smoke-holder', key: 'smoke-fleet-key-holder-0123456789-1' };
const SANDBOX = { machineId: 'sb-fleet-smoke', key: 'smoke-fleet-key-sandbox-0123456789-2' };
/** A second valid, non-sandbox key of the owner's: it works the registry too. */
const OTHER = { machineId: 'fleet-smoke-other', key: 'smoke-fleet-key-other-0123456789-3' };
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

if (process.argv.includes('--print-env')) {
  console.log(
    `CC_REMOTE_FLEET_API_KEYS=${HOLDER.machineId}:${sha(HOLDER.key)},${SANDBOX.machineId}:${sha(SANDBOX.key)},${OTHER.machineId}:${sha(OTHER.key)}`,
  );
  process.exit(0);
}

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

const fleet = (method: string, route: string, body?: unknown, key = HOLDER.key) =>
  api(target.http, undefined, method, route, body, { authorization: `Bearer ${key}` });

function expect(step: string, got: number, want: number, text: string): void {
  if (got !== want) fail(`${step}: want ${want}, got ${got}: ${text}`);
  console.log(`  ✓ ${step} → ${got}`);
}

/** Resolves with the first frame of `type`, or null if none comes within `ms`. */
function noFrame(ws: WebSocket, type: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onMsg = (raw: Buffer) => {
      if ((JSON.parse(raw.toString()) as { type: string }).type === type) {
        ws.off('message', onMsg);
        resolve(false);
      }
    };
    ws.on('message', onMsg);
    setTimeout(() => {
      ws.off('message', onMsg);
      resolve(true);
    }, ms);
  });
}

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const owner = await adminLogin(target.http, target.ssoSecret);

  const dormant = fakeSession('/srv/fleet-smoke/dormant', 'спящая');
  const live = { ...fakeSession('/srv/fleet-smoke/live', 'живая'), livePid: 4242 };
  const holder = await enrollFakeAgent(target, owner, { machineId: HOLDER.machineId, name: 'fleet-holder' });
  const tname = `fleet-target-${randomUUID().slice(0, 6)}`;
  const tgt = await enrollFakeAgent(target, owner, { name: tname, sessions: [dormant, live] });
  await enrollFakeAgent(target, owner, { machineId: SANDBOX.machineId, name: 'sb-fleet-smoke' });
  await enrollFakeAgent(target, owner, { machineId: OTHER.machineId, name: 'fleet-other' });

  const strangerClaims = randomSmokeUser('fleet-stranger');
  let stranger = await ssoLogin(target.http, target.ssoSecret, strangerClaims);
  await adminActivate(target.http, owner, [strangerClaims.email]);
  stranger = await ssoLogin(target.http, target.ssoSecret, strangerClaims);
  const theirs = await enrollFakeAgent(target, stranger, { name: `fleet-theirs-${randomUUID().slice(0, 6)}` });

  console.log('\n[fleet-smoke] 1. who may call');
  let r = await api(target.http, undefined, 'GET', '/api/fleet/machines');
  expect('no key', r.status, 401, r.text);
  r = await fleet('GET', '/api/fleet/machines', undefined, 'not-a-key');
  expect('wrong key', r.status, 401, r.text);
  r = await fleet('GET', '/api/fleet/machines', undefined, SANDBOX.key);
  expect('sb- machine key', r.status, 403, r.text);

  console.log('\n[fleet-smoke] 2. machines');
  r = await fleet('GET', '/api/fleet/machines');
  expect('machines', r.status, 200, r.text);
  const names = (r.body['machines'] as { name: string }[]).map((m) => m.name);
  if (!names.includes(tname) || !names.includes('fleet-holder')) fail(`own machines missing: ${names.join(', ')}`);
  if (names.includes(theirs.name)) fail(`a stranger's machine is listed: ${theirs.name}`);
  if (names.includes('sb-fleet-smoke')) fail('the owner\'s sandbox is listed');
  console.log(`  ✓ lists own non-sandbox machines only (${names.length})`);
  r = await fleet('POST', '/api/fleet/spawn', { machine: 'sb-fleet-smoke', cwd: '/tmp', message: 'x' });
  expect('spawn on the owner\'s sandbox', r.status, 404, r.text);

  console.log('\n[fleet-smoke] 3. spawn by name');
  const started = nextAgentFrame(tgt.ws, 'new_session');
  r = await fleet('POST', '/api/fleet/spawn', { machine: tname, cwd: '/srv/fleet-smoke/new', message: 'сделай отчёт' });
  expect('spawn', r.status, 200, r.text);
  const runId = r.body['runId'] as string;
  const ns = await started;
  if (ns.cwd !== '/srv/fleet-smoke/new' || ns.message !== 'сделай отчёт') fail(`new_session drifted: ${JSON.stringify(ns)}`);
  console.log('  ✓ the target agent got new_session with the cwd and the text');
  r = await fleet('GET', `/api/fleet/status?runId=${runId}`);
  if (r.body['state'] !== 'working') fail(`status right after spawn: ${r.text}`);
  console.log('  ✓ status is working at once');

  // A fleet run must not poison the browser's WHOLE inventory/activity feed.
  // The HTTP status endpoint accepts arbitrary JSON; only the UI decoder
  // catches an origin added at the hub but missing from the shared contract.
  const ui = await connectUiAs(target.ws, owner);
  const snapshot = await nextBrowserFrame(ui, 'snapshot');
  assert.equal(snapshot.activeRuns?.find((run) => run.runId === runId)?.origin, 'fleet');
  const activity = nextBrowserFrame(ui, 'activity', (frame) =>
    frame.runs.some((run) => run.runId === runId && run.state === 'idle'));

  console.log('\n[fleet-smoke] 4. the turn ends');
  const sid = randomUUID();
  const say = (o: object) => tgt.ws.send(JSON.stringify(o));
  say({ type: 'session_started', runId, sessionId: sid });
  say({ type: 'run_status', runId, sessionId: sid, state: 'started' });
  say({ type: 'stream', runId, sessionId: sid, event: { kind: 'assistant', text: 'Отчёт готов: /tmp/r.md' } });
  say({ type: 'stream', runId, sessionId: sid, event: { kind: 'result' } });
  assert.equal((await activity).runs.find((run) => run.runId === runId)?.origin, 'fleet');
  ui.close();
  console.log('  ✓ browser snapshot and live activity decode fleet-origin runs');
  await sleep(300);
  r = await fleet('GET', `/api/fleet/status?runId=${runId}`);
  if (r.body['state'] !== 'idle' || r.body['lastText'] !== 'Отчёт готов: /tmp/r.md' || r.body['sessionId'] !== sid) {
    fail(`status after the turn: ${r.text}`);
  }
  console.log('  ✓ idle, lastText is the answer, sessionId known');

  console.log('\n[fleet-smoke] 5. continue the idle run');
  const input = nextAgentFrame(tgt.ws, 'input');
  r = await fleet('POST', '/api/fleet/send', { runId, message: 'а теперь короче' });
  expect('send to idle run', r.status, 200, r.text);
  const inp = await input;
  if (inp.text !== 'а теперь короче') fail(`input drifted: ${JSON.stringify(inp)}`);
  console.log('  ✓ input reached the agent');
  r = await fleet('GET', `/api/fleet/status?runId=${runId}`);
  if (r.body['state'] !== 'working' || 'lastText' in r.body) fail(`status after send still shows the old turn: ${r.text}`);
  console.log('  ✓ status is working, the previous answer is not offered as this one');
  const quiet = noFrame(tgt.ws, 'input', 800);
  r = await fleet('POST', '/api/fleet/send', { runId, message: 'ещё' });
  expect('send while working', r.status, 409, r.text);
  if (!(await quiet)) fail('a refused send still reached the agent');
  console.log('  ✓ nothing reached the agent');
  say({ type: 'stream', runId, sessionId: sid, event: { kind: 'error', text: 'boom' } });
  say({ type: 'run_status', runId, sessionId: sid, state: 'idle' });
  await sleep(300);
  r = await fleet('GET', `/api/fleet/status?runId=${runId}`);
  if (r.body['state'] !== 'idle' || r.body['failed'] !== true) fail(`a failed turn reads as done: ${r.text}`);
  console.log('  ✓ failed turn: idle + failed');
  r = await fleet('POST', '/api/fleet/send', { runId, message: 'x', model: 'opus' });
  expect('model for an open run', r.status, 400, r.text);

  console.log('\n[fleet-smoke] 6. resume a dormant session');
  const resume = nextAgentFrame(tgt.ws, 'resume');
  const input2 = nextAgentFrame(tgt.ws, 'input');
  r = await fleet('POST', '/api/fleet/send', { machine: tname, sessionId: dormant.sessionId, message: 'продолжай' });
  expect('send to dormant session', r.status, 200, r.text);
  if (r.body['resumed'] !== true) fail(`not a resume: ${r.text}`);
  const rs = await resume;
  if (rs.sessionId !== dormant.sessionId) fail(`resumed the wrong session: ${JSON.stringify(rs)}`);
  if ((await input2).text !== 'продолжай') fail('the resume carried no turn');
  console.log('  ✓ resume + input for that session');

  console.log('\n[fleet-smoke] 7. a session live in an editor');
  const noResume = noFrame(tgt.ws, 'resume', 800);
  r = await fleet('POST', '/api/fleet/send', { machine: tname, sessionId: live.sessionId, message: 'влезь' });
  expect('send to live session', r.status, 409, r.text);
  if (!(await noResume)) fail('a resume went out for a session with a live writer');
  console.log(`  ✓ refused: ${String(r.body['error'])}`);

  console.log('\n[fleet-smoke] 8. a stranger\'s machine');
  r = await fleet('POST', '/api/fleet/spawn', { machine: theirs.name, cwd: '/tmp', message: 'x' });
  expect('spawn on a stranger\'s machine', r.status, 404, r.text);
  r = await fleet('POST', '/api/fleet/spawn', { machine: theirs.machineId, cwd: '/tmp', message: 'x' });
  expect('…by id too', r.status, 404, r.text);

  console.log('\n[fleet-smoke] 9. the task registry');
  r = await api(target.http, undefined, 'GET', '/api/fleet/tasks');
  expect('tasks, no key', r.status, 401, r.text);
  r = await fleet('GET', '/api/fleet/tasks', undefined, SANDBOX.key);
  expect('tasks, sandbox key', r.status, 403, r.text);
  r = await fleet('POST', '/api/fleet/tasks', { title: 'песочница' }, SANDBOX.key);
  expect('create, sandbox key', r.status, 403, r.text);
  // Any other non-sandbox key of the owner may use the registry: the key names
  // the machine and the owner, and nothing more is asked.
  r = await fleet('GET', '/api/fleet/tasks', undefined, OTHER.key);
  expect('tasks, a second machine\'s key', r.status, 200, r.text);
  r = await fleet('POST', '/api/fleet/tasks', { title: 'со второй машины' }, OTHER.key);
  expect('create, a second machine\'s key', r.status, 200, r.text);

  r = await fleet('POST', '/api/fleet/tasks', { title: 'Отчёт по смоуку', intent: 'проверить реестр', lane: 'smoke', status: 'in-progress' });
  expect('create', r.status, 200, r.text);
  const task = r.body['task'] as Record<string, unknown>;
  const taskId = task['id'] as string;
  if (task['status'] !== 'in_progress' || task['statusBy'] !== 'teo' || task['lane'] !== 'smoke' || task['anchorTurnId'] !== '') {
    fail(`created task drifted: ${r.text}`);
  }
  console.log('  ✓ «in-progress» is read as in_progress, filed through the API, no anchor yet');
  r = await fleet('POST', '/api/fleet/tasks', { title: 'x', status: 'whatever' });
  expect('unknown status', r.status, 400, r.text);
  r = await fleet('POST', `/api/fleet/tasks/${taskId}`, { status: 'waiting-owner' });
  expect('update', r.status, 200, r.text);
  if ((r.body['task'] as Record<string, unknown>)['status'] !== 'waiting') fail(`status not moved: ${r.text}`);
  r = await fleet('GET', '/api/fleet/tasks');
  if (!(r.body['tasks'] as { id: string }[]).some((t) => t.id === taskId)) fail(`the task is not listed: ${r.text}`);
  r = await fleet('GET', '/api/fleet/tasks/no-such-task');
  expect('unknown task', r.status, 404, r.text);

  // A sandbox key cannot tie a session to a task either, and the refused
  // spawn starts nothing.
  const quietSpawn = noFrame(tgt.ws, 'new_session', 800);
  r = await fleet('POST', '/api/fleet/spawn', { machine: tname, cwd: '/srv/fleet-smoke/t', message: 'x', taskId }, SANDBOX.key);
  expect('spawn --task, sandbox key', r.status, 403, r.text);
  r = await fleet('POST', '/api/fleet/spawn', { machine: tname, cwd: '/srv/fleet-smoke/t', message: 'x', taskId: 'no-such-task' });
  expect('spawn --task, no such task', r.status, 404, r.text);
  if (!(await quietSpawn)) fail('a refused spawn --task still reached the agent');
  console.log('  ✓ nothing was started');

  const taskSpawn = nextAgentFrame(tgt.ws, 'new_session');
  r = await fleet('POST', '/api/fleet/spawn', { machine: tname, cwd: '/srv/fleet-smoke/t', message: 'по задаче', taskId });
  expect('spawn --task', r.status, 200, r.text);
  const taskRun = r.body['runId'] as string;
  if (r.body['taskId'] !== taskId) fail(`spawn did not report the task: ${r.text}`);
  await taskSpawn;
  r = await fleet('GET', `/api/fleet/tasks/${taskId}`);
  let child = (r.body['links'] as Record<string, unknown>[]).find((l) => l['role'] === 'child');
  if (!child || child['runId'] !== taskRun || 'sessionId' in child) fail(`the run is not linked, or already has a session: ${r.text}`);
  console.log('  ✓ the run is linked, its session is not known yet');
  const taskSid = randomUUID();
  tgt.ws.send(JSON.stringify({ type: 'session_started', runId: taskRun, sessionId: taskSid }));
  await sleep(300);
  r = await fleet('GET', `/api/fleet/tasks/${taskId}`);
  child = (r.body['links'] as Record<string, unknown>[]).find((l) => l['role'] === 'child');
  if (child?.['sessionId'] !== taskSid) fail(`session_started did not fill the link: ${r.text}`);
  const kids = (r.body['task'] as { children: { sessionId: string }[] }).children;
  if (kids.length !== 1 || kids[0]?.sessionId !== taskSid) fail(`task.children drifted: ${r.text}`);
  console.log('  ✓ session_started filled the session in');

  const other = await fleet('POST', '/api/fleet/tasks', { title: 'Другая задача' });
  const otherId = (other.body['task'] as { id: string }).id;
  const noInput = noFrame(tgt.ws, 'input', 800);
  r = await fleet('POST', '/api/fleet/send', { machine: tname, sessionId: taskSid, message: 'ещё', taskId: otherId });
  expect('send --task, the session works for another task', r.status, 409, r.text);
  if (!(await noInput)) fail('a refused send --task still reached the agent');
  r = await fleet('POST', `/api/fleet/tasks/${otherId}/links`, { machine: tname, sessionId: taskSid });
  expect('link, the session works for another task', r.status, 409, r.text);
  r = await fleet('POST', `/api/fleet/tasks/${taskId}/links`, { machine: tname, sessionId: taskSid });
  expect('link, its own session again', r.status, 200, r.text);
  r = await fleet('POST', `/api/fleet/tasks/${otherId}/links`, { machine: 'sb-fleet-smoke', sessionId: 's' });
  expect('link, the owner\'s sandbox', r.status, 404, r.text);
  r = await fleet('POST', `/api/fleet/tasks/${otherId}/links`, { machine: theirs.machineId, sessionId: 's' });
  expect('link, a stranger\'s machine', r.status, 404, r.text);
  r = await fleet('POST', `/api/fleet/tasks/${otherId}/links`, { machine: tname, sessionId: dormant.sessionId });
  expect('link, a dormant session by hand', r.status, 200, r.text);
  const dormantLink = r.body['link'] as Record<string, unknown>;
  if (dormantLink['role'] !== 'child' || dormantLink['sessionId'] !== dormant.sessionId) fail(`link drifted: ${r.text}`);
  r = await fleet('GET', '/api/fleet/tasks');
  const sorted = (r.body['tasks'] as { id: string; children: unknown[] }[]).find((t) => t.id === otherId);
  if (sorted?.children.length !== 1) fail(`the list does not show the child: ${r.text}`);
  console.log('  ✓ the registry holds');

  void holder;
  clearTimeout(timer);
  console.log('\n[fleet-smoke] PASS');
  process.exit(0);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
