/**
 * Protocol conformance + id-correlation smoke. Connects as a browser and checks
 * the hub handles the control messages it must, and that terminal/mirror opens
 * echo the BROWSER-allocated id back (the request-id correlation fix) instead of
 * a hub-minted one:
 *   1. browser keepalive {type:'ping'}         -> hub ignores it, socket stays open
 *   2. subscribe to a nonexistent run          -> `error` "Run not found"
 *   3. rpc_request to an offline machine       -> `rpc_response` ok=false offline
 *   4. term_open with our termId               -> `term_opened` echoes that termId
 *   5. mirror_open with our mirrorId           -> `mirror_opened` echoes that id
 *
 * Usage: tsx server/src/cli/protocol-smoke.ts [ws://127.0.0.1:4319] [token] [machineFilter]
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_MACHINE.
 */
import { randomUUID } from 'node:crypto';
import { decodeCentralToBrowser, type MachineSnapshot } from '@cc-remote/shared';
import { connectUi, machineFilterArg } from './_harness.js';

const { ws, send } = connectUi(process.argv);
const machineFilter = machineFilterArg(process.argv);

const myTerm = randomUUID();
const myMirror = randomUUID();
const bogusRun = `no-such-run-${randomUUID()}`;

const checks = {
  'ping tolerated (socket stays open)': false,
  'subscribe(bogus) -> error': false,
  'rpc(offline) -> rpc_response error': false,
  'term_open echoes browser id': false,
  'mirror_open echoes browser id': false,
};
let testedTermMirror = false;
let started = false;

ws.on('open', () => console.log('[protocol-smoke] connected'));
ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  switch (msg.type) {
    case 'snapshot':
      if (!started) {
        started = true;
        void run(msg.machines);
      }
      break;
    case 'error':
      if (msg.message.toLowerCase().includes('run not found')) checks['subscribe(bogus) -> error'] = true;
      break;
    case 'rpc_response':
      if (!msg.ok && (msg.error ?? '').toLowerCase().includes('offline')) checks['rpc(offline) -> rpc_response error'] = true;
      break;
    case 'term_opened':
      checks['term_open echoes browser id'] = msg.termId === myTerm;
      break;
    case 'mirror_opened':
      checks['mirror_open echoes browser id'] = msg.mirrorId === myMirror;
      break;
  }
});

async function run(machines: MachineSnapshot[]) {
  // (1) browser keepalive — the hub must swallow it, not close the socket.
  send({ type: 'ping' });
  // (2) subscribe to a run that does not exist.
  send({ type: 'subscribe', runId: bogusRun });
  // (3) rpc to a machine that is not connected.
  send({ type: 'rpc_request', requestId: randomUUID(), machineId: `no-such-machine-${randomUUID()}`, method: 'git.status', params: { cwd: '/' } });

  // (4)+(5) need an online machine with at least one session.
  const m = machines.find(
    (x) => x.online && x.sessions.length && (!machineFilter || x.machine.name.toLowerCase().includes(machineFilter.toLowerCase())),
  );
  const sess = m?.sessions[0];
  if (m && sess) {
    testedTermMirror = true;
    console.log(`[protocol-smoke] term/mirror against ${m.machine.name} (session ${sess.sessionId.slice(0, 8)})`);
    send({ type: 'term_open', machineId: m.machine.machineId, termId: myTerm, cwd: sess.cwd });
    send({ type: 'mirror_open', machineId: m.machine.machineId, mirrorId: myMirror, sessionId: sess.sessionId, cwd: sess.cwd ?? '' });
  } else {
    console.log('[protocol-smoke] no online machine with sessions — skipping term/mirror id checks');
  }

  setTimeout(() => {
    // Socket still open 6s after the ping means the hub tolerated it.
    checks['ping tolerated (socket stays open)'] = ws.readyState === ws.OPEN;
    if (testedTermMirror) {
      send({ type: 'term_close', termId: myTerm });
      send({ type: 'mirror_close', mirrorId: myMirror });
    }
    report();
  }, 6000);
}

function report() {
  console.log('\n=== RESULT ===');
  const required: Array<keyof typeof checks> = [
    'ping tolerated (socket stays open)',
    'subscribe(bogus) -> error',
    'rpc(offline) -> rpc_response error',
  ];
  if (testedTermMirror) required.push('term_open echoes browser id', 'mirror_open echoes browser id');
  let ok = true;
  for (const [name, pass] of Object.entries(checks)) {
    const relevant = required.includes(name as keyof typeof checks);
    const mark = !relevant ? 'skip' : pass ? 'PASS' : 'FAIL';
    if (relevant && !pass) ok = false;
    console.log(`  [${mark}] ${name}`);
  }
  console.log(ok ? '\nPROTOCOL OK' : '\nFAIL');
  ws.close();
  process.exit(ok ? 0 : 1);
}

ws.on('error', (e) => {
  console.log('ws error', (e as Error).message);
  process.exit(1);
});
setTimeout(() => {
  console.error('timeout (no snapshot)');
  process.exit(1);
}, 15_000).unref();
