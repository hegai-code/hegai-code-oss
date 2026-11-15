/**
 * Verifies the reverse single-writer guard: while cc-remote is running a control
 * run, if the session becomes "live in an editor" the agent must YIELD (stop its
 * run) so it never co-writes the .jsonl. We simulate the editor by dropping a
 * live ~/.claude/sessions/<pid>.json (pid = this process, which is alive).
 *
 * Usage: tsx server/src/cli/yield-smoke.ts ws://127.0.0.1:4319 dev-token [machineFilter=os.hostname()]
 * NOTE: run against a LOCAL agent (same machine) so the fake sessions file is visible to it.
 */
import os from 'node:os';
import { rmSync } from 'node:fs';
import { decodeCentralToBrowser, type MachineSnapshot } from '@cc-remote/shared';
import { connectUi, machineFilterArg, pickSession, dormantWithCwd, writeFakeLiveSession } from './_harness.js';

const { ws, send } = connectUi(process.argv);
// Must target the LOCAL machine: the fake sessions file is written on THIS host.
const machineFilter = machineFilterArg(process.argv, os.hostname());

let fakeFile: string | undefined;
let started = false;
let runId: string | undefined;
let yielded = false;
const cleanup = () => {
  try {
    if (fakeFile) rmSync(fakeFile);
  } catch {
    /* ignore */
  }
};

ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  if (msg.type === 'snapshot') {
    if (!started) void run(msg.machines);
  } else if (msg.type === 'opened') {
    runId = msg.runId;
    console.log(`[opened] run ${msg.runId} on session ${msg.sessionId.slice(0, 8)}`);
    // Simulate the editor opening this session ~1s after our run starts.
    setTimeout(() => {
      fakeFile = writeFakeLiveSession(process.pid, msg.sessionId);
      console.log(`[sim] wrote fake live record ${fakeFile} (pid ${process.pid}) for the session`);
    }, 1000);
  } else if (msg.type === 'run_status') {
    console.log(`[run_status] ${msg.state}${msg.error ? `: ${msg.error}` : ''}`);
    if (msg.state === 'yielded') yielded = true;
  }
});

async function run(machines: MachineSnapshot[]) {
  started = true;
  const hit = pickSession(machines, machineFilter, dormantWithCwd);
  if (!hit) {
    console.log('FAIL: no machine/dormant cwd session matching the filter');
    process.exit(1);
  }
  const { machine: m, session: sess } = hit;
  console.log(`[open] control run on ${m.machine.name} session ${sess.sessionId.slice(0, 8)}`);
  send({ type: 'open', machineId: m.machine.machineId, sessionId: sess.sessionId });

  setTimeout(() => {
    console.log('\n=== RESULT ===');
    console.log(yielded ? 'YIELD OK — run was handed back to the editor' : 'FAIL — run did not yield');
    cleanup();
    if (runId) send({ type: 'close', runId });
    setTimeout(() => process.exit(yielded ? 0 : 1), 200);
  }, 6000);
}

ws.on('error', (e) => {
  console.log('ws error', e.message);
  cleanup();
  process.exit(1);
});
