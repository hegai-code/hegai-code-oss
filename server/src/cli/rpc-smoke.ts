/**
 * Headless test of the v2 backend: connects as a browser, then exercises
 * RPC (fs.list, git.status, session.messages) and the terminal, verifying
 * routing browser -> central -> agent -> back.
 *
 * Usage: tsx server/src/cli/rpc-smoke.ts [ws://127.0.0.1:4319] [token]
 */
import { randomUUID } from 'node:crypto';
import {
  decodeCentralToBrowser,
  type FsListResult,
  type GitStatusResult,
  type MachineSnapshot,
  type SessionMessagesResult,
} from '@cc-remote/shared';
import { connectUi, machineFilterArg, mustOk, pickSession, dormantWithCwd, rpc, sleep } from './_harness.js';

const { ws, send } = connectUi(process.argv);

let termId: string | undefined;
let termData = '';

ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  if (msg.type === 'snapshot') {
    if (!started) void run(msg.machines);
  } else if (msg.type === 'term_opened') {
    termId = msg.termId;
  } else if (msg.type === 'term_data') {
    termData += msg.data;
  }
});

let started = false;
async function run(machines: MachineSnapshot[]) {
  started = true;
  const machineFilter = machineFilterArg(process.argv);
  // Prefer a dormant cwd session; fall back to any session with a cwd.
  const hit = pickSession(machines, machineFilter, dormantWithCwd) ?? pickSession(machines, machineFilter, (s) => !!s.cwd);
  if (!hit) {
    console.log('no matching machine with a cwd session');
    process.exit(1);
  }
  const { machine: m, session: sess } = hit;
  const machineId = m.machine.machineId;
  const cwd = sess.cwd;
  console.log(`machine=${m.machine.name} cwd=${cwd}`);

  try {
    const list = mustOk<FsListResult>('fs.list', await rpc(ws, machineId, 'fs.list', { cwd, path: '' }));
    console.log(`✓ fs.list: ${list.entries.length} entries (${list.entries.slice(0, 5).map((e) => e.name).join(', ')})`);

    const git = mustOk<GitStatusResult>('git.status', await rpc(ws, machineId, 'git.status', { cwd }));
    console.log(`✓ git.status: repo=${git.isRepo} branch=${git.branch} changed=${git.files.length}`);

    const hist = mustOk<SessionMessagesResult>('session.messages', await rpc(ws, machineId, 'session.messages', { sessionId: sess.sessionId, cwd }));
    const firstText = hist.messages.flatMap((x) => x.blocks).find((b) => b.kind === 'text');
    console.log(`✓ session.messages: ${hist.messages.length} messages; first text: ${firstText && 'text' in firstText ? JSON.stringify(firstText.text.slice(0, 60)) : 'n/a'}`);

    send({ type: 'term_open', machineId, termId: randomUUID(), cwd });
    await sleep(1500);
    if (termId) {
      send({ type: 'term_input', termId, data: 'echo RPCSMOKE_OK\r\n' });
      await sleep(1500);
      const ok = termData.includes('RPCSMOKE_OK');
      console.log(`✓ terminal: opened ${termId.slice(0, 8)}, echo round-trip=${ok}`);
      send({ type: 'term_close', termId });
    } else {
      console.log('✗ terminal: never opened');
    }
    console.log('\nALL OK');
    process.exit(0);
  } catch (e) {
    console.error('✗ RPC failed:', (e as Error).message);
    process.exit(1);
  }
}

ws.on('error', (e) => {
  console.error('ws error', (e as Error).message);
  process.exit(1);
});
setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 30_000).unref();
