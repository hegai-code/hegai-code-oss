/**
 * term-run: run ONE shell command on a fleet machine through its own agent.
 *
 * The in-band route from deploy/FLEET.md («Installing it on a machine you
 * cannot SSH to»), as a script instead of a checklist: the Mac mini is not
 * reachable over SSH from here (Tailscale SSH wants an interactive approval)
 * and buildbox-pc has no inbound path by design, but both keep an agent dialled
 * into the hub, and the agent opens a terminal for a `/ui` client that may
 * control the machine. No Claude session, no tokens, no approvals — a shell,
 * with the output coming back verbatim so the result can be read rather than
 * assumed.
 *
 * This ACTS AS a person: the hub session is minted with the hub's own SSO
 * secret for the id in `CC_SMOKE_ADMIN_ID` (the platform admin / bootstrap
 * owner on production). Use it at that person's request and for their
 * machines — the audit log records the terminal open under their name.
 *
 *   CC_SMOKE_URL=wss://code.acme.test \
 *   CC_REMOTE_SSO_SECRET=<hub's> CC_SMOKE_ADMIN_ID=<id> CC_SMOKE_ADMIN_EMAIL=<email> \
 *   tsx server/src/cli/term-run.ts --machine mac-mini --wait 20 -- 'curl -fsSL … && launchctl kickstart …'
 *
 * `--machine` matches the machine NAME or id from the snapshot. `--wait N`
 * keeps collecting output for N seconds after the command was typed (default
 * 15). Exit code is 0 when the shell echoed the end sentinel, 2 otherwise.
 */
import { randomUUID } from 'node:crypto';
import { adminLogin, api, connectUiAs, fail, nextBrowserFrame, sendUi, sleep, smokeTarget, type SsoSession } from './_harness.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const machineWanted = flag('--machine') ?? fail('--machine <name|id> is required');
const waitSecs = Number(flag('--wait') ?? '15');
const dash = argv.indexOf('--');
const command = dash >= 0 ? argv.slice(dash + 1).join(' ') : undefined;
if (!command) fail("the command goes after '--'");

const target = smokeTarget([process.argv[0]!, process.argv[1]!]);
const timer = setTimeout(() => void quit(1, 'FAIL: timed out (180s)'), 180_000);

/**
 * The session this run holds AS the owner. Every run used to leave one behind,
 * alive for the hub's full session lifetime (7 days) — and `deploy/term.sh
 * --put` makes one per 2 KB slice. So every exit after sign-in goes through
 * here and logs it out.
 */
let session: SsoSession | undefined;
async function quit(code: number, why?: string): Promise<never> {
  if (why) console.error(why);
  if (session) {
    await api(target.http, session.cookie, 'POST', '/api/logout').catch(() => undefined);
    session = undefined;
  }
  process.exit(code);
}

async function main(): Promise<void> {
  if (!target.ssoSecret && !process.env['CC_SMOKE_SESSION']) fail('CC_REMOTE_SSO_SECRET is not set (must match the hub)');
  // A minute is plenty: the JWT is spent on the very next request, and it
  // travels in the callback's query string, which the hub's nginx logs.
  const me = await adminLogin(target.http, target.ssoSecret, { exp: Math.floor(Date.now() / 1000) + 60 });
  session = me;
  console.log(`[term-run] signed in as ${me.userId} on ${target.http}`);

  const ws = await connectUiAs(target.ws, me);
  sendUi(ws, { type: 'hello', client: 'web' });
  const snap = await nextBrowserFrame(ws, 'snapshot', () => true, 20_000);
  const machine = snap.machines.find(
    (m) => m.machine.machineId === machineWanted || m.machine.name === machineWanted,
  );
  if (!machine) {
    return quit(1, `FAIL: no machine «${machineWanted}» in the snapshot; have: ${snap.machines.map((m) => `${m.machine.name} (${m.online ? 'online' : 'offline'})`).join(', ')}`);
  }
  if (!machine.online) return quit(1, `FAIL: ${machine.machine.name} is offline right now`);
  console.log(`[term-run] ${machine.machine.name} (${machine.machine.os}) is online — opening a terminal`);

  const termId = randomUUID();
  let out = '';
  let exited: number | undefined;
  ws.on('message', (raw: Buffer) => {
    let msg: { type?: string; termId?: string; data?: string; code?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.termId !== termId) return;
    if (msg.type === 'term_data' && typeof msg.data === 'string') out += msg.data;
    if (msg.type === 'term_exit') exited = msg.code ?? 0;
  });
  const opened = nextBrowserFrame(ws, 'term_opened', (m) => m.termId === termId, 20_000);
  sendUi(ws, { type: 'term_open', termId, machineId: machine.machine.machineId });
  await opened;
  // Input delivered into the shell's banner is swallowed — see FLEET.md.
  await sleep(1_800);

  const sentinel = `__TERM_RUN_DONE_${termId.slice(0, 8)}__`;
  // One line for every shell: PowerShell and bash both print a plain string.
  const line = machine.machine.os === 'windows'
    ? `${command}; echo ${sentinel}\r`
    : `${command}; echo ${sentinel}\n`;
  sendUi(ws, { type: 'term_input', termId, data: line });

  const deadline = Date.now() + waitSecs * 1_000;
  while (Date.now() < deadline) {
    // The echo of the typed line contains the sentinel too; the REAL one is
    // the second occurrence, on its own line after the command ran.
    const hits = out.split(sentinel).length - 1;
    if (hits >= 2 || exited !== undefined) break;
    await sleep(500);
  }
  sendUi(ws, { type: 'term_close', termId });
  await sleep(200);
  ws.close();
  clearTimeout(timer);

  // Strip the terminal's control sequences for the log; the raw text is what
  // the person would have seen, minus colours and cursor moves.
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  console.log('----- terminal -----');
  console.log(clean.trim());
  console.log('--------------------');
  const done = clean.split(sentinel).length - 1 >= 2;
  console.log(done ? `[term-run] command finished (sentinel seen)` : `[term-run] no sentinel within ${waitSecs}s — read the output above`);
  return quit(done ? 0 : 2);
}

main().catch((e) => quit(1, `FAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
