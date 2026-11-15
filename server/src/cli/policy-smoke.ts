/**
 * The machine owner's switches (agent/src/policy.ts), end to end: a REAL agent
 * with its own `~/.cc-remote/policy.json`, a real hub, a browser socket.
 *
 *   selected mode:  tsx server/src/cli/policy-smoke.ts <ws> <token> <machine-name>
 *     - the machine reports `policy.sync = selected`, and lists NO session
 *       until a folder is picked;
 *     - `sync.set add <folder>` → only that folder's sessions appear;
 *     - `sync.set remove` → they are gone from the snapshot again.
 *   chat-only mode: add `--chat-only`
 *     - the machine reports `policy.chatOnly`, offers no bypass mode;
 *     - `fs.write`, `proc.kill` and `sync.set` are refused by the agent;
 *     - a terminal opens and closes with the refusal text.
 *
 * Start the agent with CC_REMOTE_STATE_DIR pointing at a fresh directory whose
 * policy.json is `{"sync":{"projects":[]}}` (plus `"chatOnly": true` for the
 * second mode). deploy/SMOKE-TESTS.md, «policy-smoke».
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { decodeCentralToBrowser, type MachineSnapshot, type SyncState } from '@cc-remote/shared';
import { connectUi, fail, machineFilterArg, mustOk, rpc, sleep } from './_harness.js';

const chatOnly = process.argv.includes('--chat-only');
const argv = process.argv.filter((a) => a !== '--chat-only');
const machineName = machineFilterArg(argv, 'policy-smoke');
const { ws, send } = connectUi(argv);

let machines: MachineSnapshot[] = [];
let termData = '';
let termExited = false;

ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  if (msg.type === 'snapshot') machines = msg.machines;
  else if (msg.type === 'machine_sessions') {
    machines = machines.map((m) => (m.machine.machineId === msg.machine.machine.machineId ? msg.machine : m));
  } else if (msg.type === 'term_data') termData += msg.data;
  else if (msg.type === 'term_exit') termExited = true;
});

const mine = () => machines.find((m) => m.machine.name === machineName && m.online);

async function waitFor(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return;
    await sleep(300);
  }
  fail(`timed out waiting for: ${what}`);
}

function within(cwd: string | undefined, dir: string): boolean {
  if (!cwd) return false;
  const rel = path.relative(dir, cwd);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function main(): Promise<void> {
  await waitFor(`machine «${machineName}» online`, () => !!mine());
  const m = mine()!;
  const id = m.machine.machineId;
  const policy = m.machine.policy;
  if (!policy) fail('the machine reported no policy — agent too old, or the field was stripped on the way');
  console.log(`policy reported: ${JSON.stringify(policy)}`);
  if (policy.sync !== 'selected') fail('a fresh selected-mode agent must report sync=selected');
  if (policy.chatOnly !== chatOnly) fail(`chatOnly reported ${policy.chatOnly}, expected ${chatOnly}`);

  // Nothing picked yet → nothing listed. Give the first inventory a moment.
  await sleep(4000);
  const listed = mine()!.sessions.filter((s) => !s.archived);
  if (listed.length) fail(`${listed.length} session(s) listed before any folder was picked: ${listed[0]!.cwd}`);
  console.log('ok  no folder picked → no session left the machine');

  // The first inventory walk can take a while on a loaded box: candidates come
  // from it, so ask until there are some (or a minute passes).
  let state = mustOk<SyncState>('sync.list', await rpc(ws, id, 'sync.list', {}, 20_000));
  for (let i = 0; i < 20 && !state.candidates.length; i++) {
    await sleep(3000);
    state = mustOk<SyncState>('sync.list', await rpc(ws, id, 'sync.list', {}, 20_000));
  }
  console.log(`ok  sync.list: mode=${state.mode}, ${state.candidates.length} candidate folder(s)`);
  if (!state.candidates.length) fail('no candidate folders — run the agent on a box that has sessions');

  if (chatOnly) {
    if (mine()!.machine.permissionModes?.includes('bypassPermissions')) fail('chat-only machine offers bypass for Claude');
    if (mine()!.machine.codexPermissionModes?.includes('bypassPermissions')) fail('chat-only machine offers bypass for Codex');
    console.log('ok  no bypass mode offered for Claude or Codex');
    for (const [method, params] of [
      ['fs.write', { cwd: state.candidates[0]!.cwd, path: 'policy-smoke.txt', content: 'x' }],
      ['proc.kill', { pid: 999999, signal: 'TERM' }],
      ['sync.set', { mode: 'all' }],
    ] as const) {
      const outcome = await rpc(ws, id, method, params, 20_000);
      const refused = outcome.ok ? undefined : outcome.error;
      if (!refused || !/chat-only/.test(refused)) fail(`${method} was not refused by the agent: ${refused ?? 'it succeeded'}`);
      console.log(`ok  ${method} refused: ${refused}`);
    }
    send({ type: 'term_open', termId: randomUUID(), machineId: id, cwd: state.candidates[0]!.cwd });
    await waitFor('the terminal to close with the refusal', () => termExited);
    if (!/switched off on this machine/.test(termData)) fail(`terminal said: ${JSON.stringify(termData.slice(0, 200))}`);
    console.log('ok  terminal refused and closed');
  } else {
    // The smallest folder, so the replica pass is short.
    const pick = [...state.candidates].sort((a, b) => a.sessions - b.sessions)[0]!;
    const after = mustOk<SyncState>('sync.set', await rpc(ws, id, 'sync.set', { add: [pick.cwd] }, 20_000));
    if (!after.projects.includes(pick.cwd)) fail('sync.set did not record the folder');
    await waitFor(`sessions of ${pick.cwd} to appear`, () => mine()!.sessions.some((s) => !s.archived && within(s.cwd, pick.cwd)));
    const outside = mine()!.sessions.filter((s) => !s.archived && !within(s.cwd, pick.cwd));
    if (outside.length) fail(`a session outside the picked folder was listed: ${outside[0]!.cwd}`);
    console.log(`ok  picked ${pick.cwd} → ${mine()!.sessions.length} session(s), all inside it`);

    mustOk<SyncState>('sync.set', await rpc(ws, id, 'sync.set', { remove: [pick.cwd] }, 20_000));
    await waitFor('the picked sessions to be forgotten', () => mine()!.sessions.length === 0);
    console.log('ok  removed → the hub forgot them (not even listed as archived)');
  }
  console.log('policy-smoke: PASS');
  process.exit(0);
}

ws.on('open', () => void main().catch((e: Error) => fail(e.message)));
