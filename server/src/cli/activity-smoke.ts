/**
 * Verifies the v3 C1/C3 surface: snapshot carries `activeRuns`, opening a run
 * triggers `activity` broadcasts, and the run moves through attention states.
 *
 * Usage: tsx activity-smoke.ts ws://127.0.0.1:4319 dev-token [machineFilter]
 */
import { decodeCentralToBrowser, type MachineSnapshot } from '@cc-remote/shared';
import { connectUi, machineFilterArg, pickSession, dormantWithCwd } from './_harness.js';

const { ws, send } = connectUi(process.argv);
const machineFilter = machineFilterArg(process.argv);

let started = false;
let runId: string | undefined;
let sawActiveRunsInSnapshot = false;
const states = new Set<string>();
let activityCount = 0;

ws.on('open', () => console.log('[activity-smoke] connected'));
ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  if (msg.type === 'snapshot') {
    if (Array.isArray(msg.activeRuns)) sawActiveRunsInSnapshot = true;
    console.log(`[snapshot] machines=${msg.machines.length} activeRuns=${msg.activeRuns?.length ?? 'absent'}`);
    if (!started) void run(msg.machines);
  } else if (msg.type === 'opened') {
    runId = msg.runId;
    console.log(`[opened] runId=${msg.runId}`);
  } else if (msg.type === 'activity') {
    activityCount++;
    const mine = msg.runs.find((r) => r.runId === runId);
    if (mine) states.add(mine.state);
    console.log(
      `[activity] #${activityCount} runs=${msg.runs.length} ` +
        msg.runs.map((r) => `${r.state}${r.preview ? `("${r.preview.slice(0, 30)}…")` : ''}`).join(', '),
    );
  } else if (msg.type === 'run_status') {
    console.log(`[run_status] ${msg.state}`);
  }
});

async function run(machines: MachineSnapshot[]) {
  started = true;
  const hit = pickSession(machines, machineFilter, dormantWithCwd);
  if (!hit) {
    console.log('FAIL: no machine with a dormant cwd session');
    process.exit(1);
  }
  const { machine: m, session: sess } = hit;
  console.log(`[open] machine=${m.machine.name} session=${sess.sessionId.slice(0, 8)}`);
  send({ type: 'open', machineId: m.machine.machineId, sessionId: sess.sessionId, message: 'say hi in one word' });

  setTimeout(() => {
    console.log('\n=== RESULT ===');
    console.log('snapshot carried activeRuns[]:', sawActiveRunsInSnapshot);
    console.log('activity broadcasts received:', activityCount);
    console.log('states observed for our run:', [...states].join(', ') || '(none)');
    const ok = sawActiveRunsInSnapshot && activityCount > 0 && states.size > 0;
    console.log(ok ? '\nACTIVITY PATH OK' : '\nFAIL');
    if (runId) send({ type: 'close', runId });
    setTimeout(() => process.exit(ok ? 0 : 1), 300);
  }, 12000);
}

ws.on('error', (e) => {
  console.log('ws error', e.message);
  process.exit(1);
});
