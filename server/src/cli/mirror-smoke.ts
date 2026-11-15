/**
 * Verifies the read-only live MIRROR: pick a session that is LIVE in an editor,
 * open a mirror, and confirm we receive the transcript (replace) plus any tail
 * appends — all WITHOUT opening a writer.
 *
 * Usage: tsx server/src/cli/mirror-smoke.ts ws://127.0.0.1:4319 dev-token [machineFilter]
 */
import { randomUUID } from 'node:crypto';
import {
  decodeCentralToBrowser,
  type HistoryMessage,
  type MachineSnapshot,
} from '@cc-remote/shared';
import { connectUi, machineFilterArg, pickSession, liveWithCwd } from './_harness.js';

const { ws, send } = connectUi(process.argv);
const machineFilter = machineFilterArg(process.argv);

let started = false;
let mirrorId: string | undefined;
let replaceCount = 0;
let appendCount = 0;
let totalMsgs = 0;

ws.on('open', () => console.log('[mirror-smoke] connected'));
ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  if (msg.type === 'snapshot') {
    if (!started) void run(msg.machines);
  } else if (msg.type === 'mirror_opened') {
    mirrorId = msg.mirrorId;
    console.log(`[mirror_opened] ${msg.mirrorId} on ${msg.machineId}`);
  } else if (msg.type === 'mirror_data') {
    const n = msg.messages.length;
    totalMsgs = msg.replace ? n : totalMsgs + n;
    if (msg.replace) replaceCount++;
    else appendCount++;
    const first = msg.messages[0] as HistoryMessage | undefined;
    const textBlock = first?.blocks.find((b) => b.kind === 'text');
    const sample = textBlock && 'text' in textBlock ? textBlock.text.slice(0, 50) : undefined;
    console.log(`[mirror_data] replace=${msg.replace} messages=${n}${sample ? ` first="${sample}…"` : ''}`);
  }
});

async function run(machines: MachineSnapshot[]) {
  started = true;
  const hit = pickSession(machines, machineFilter, liveWithCwd);
  if (!hit) {
    console.log('FAIL: no machine with a LIVE (livePid) cwd session');
    process.exit(1);
  }
  const { machine: m, session: sess } = hit;
  console.log(`[open] machine=${m.machine.name} session=${sess.sessionId.slice(0, 8)} live in ${sess.entrypoint} (pid ${sess.livePid})`);
  send({ type: 'mirror_open', mirrorId: randomUUID(), machineId: m.machine.machineId, sessionId: sess.sessionId, cwd: sess.cwd ?? '' });

  const windowMs = Number(process.argv[5] ?? 7000);
  setTimeout(() => {
    console.log('\n=== RESULT ===');
    console.log(`mirror_opened: ${mirrorId ? 'yes' : 'NO'}`);
    console.log(`replace frames: ${replaceCount}, append frames: ${appendCount}, total messages: ${totalMsgs}`);
    const ok = !!mirrorId && replaceCount >= 1 && totalMsgs > 0;
    console.log(ok ? '\nMIRROR OK' : '\nFAIL');
    if (mirrorId) send({ type: 'mirror_close', mirrorId });
    setTimeout(() => process.exit(ok ? 0 : 1), 200);
  }, windowMs);
}

ws.on('error', (e) => {
  console.log('ws error', e.message);
  process.exit(1);
});
