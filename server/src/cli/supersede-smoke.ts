/**
 * Wire test for the double-daemon guard.
 *
 * Two agent PROCESSES claiming one machineId is the failure mode behind a
 * corrupted transcript: both watch the same files, both append, and the hub can
 * only route to one of them. The guard has two halves and this exercises both.
 *
 *  1. A newcomer with a DIFFERENT `agentInstanceId` takes the machine, and the
 *     loser is told `agent_superseded` and then hung up on. Being hung up on is
 *     the half that used to be missing: the hub dropped the old Tx but its write
 *     loop stayed armed on the keepalive, so the evicted daemon sat on a healthy
 *     socket, never learnt it had been replaced, and kept working — a ghost.
 *  2. The SAME process reconnecting is not that: it gets the socket dropped, as
 *     always, but NO stand-down order. Getting this wrong is worse than the bug
 *     it guards against, because every link blip would kill the daemon.
 *
 * Usage: tsx server/src/cli/supersede-smoke.ts [ws://127.0.0.1:4319] [dev-token]
 */
import { WebSocket } from 'ws';
import { decodeCentralToAgent } from '@cc-remote/shared';
import { fail, sleep, smokeTarget } from './_harness.js';

const { ws: base, token } = smokeTarget(process.argv);
const MID = 'supersede-smoke-machine';

interface FakeAgent {
  name: string;
  sock: WebSocket;
  /** Set when the hub orders this daemon to stand down. */
  superseded: boolean;
  closed: boolean;
}

function openAgent(name: string, instanceId: string): Promise<FakeAgent> {
  const sock = new WebSocket(`${base}/agent?token=${encodeURIComponent(token)}`);
  const agent: FakeAgent = { name, sock, superseded: false, closed: false };
  sock.on('message', (raw: Buffer) => {
    let msg;
    try {
      // Through the shared schema on purpose: this also proves the hub's
      // `json!()` shape satisfies `CentralToAgent`.
      msg = decodeCentralToAgent(raw.toString());
    } catch {
      return; // not every hub message is one this fake agent models
    }
    if (msg.type === 'agent_superseded') {
      if (msg.machineId !== MID) fail(`${name}: superseded notice named ${msg.machineId}, not ${MID}`);
      agent.superseded = true;
    }
  });
  sock.on('close', () => {
    agent.closed = true;
  });
  return new Promise((resolve, reject) => {
    sock.on('error', reject);
    sock.on('open', () => {
      sock.send(
        JSON.stringify({
          type: 'register',
          protocol: 1,
          machine: {
            machineId: MID,
            name: 'supersede-smoke',
            os: 'linux',
            agentVersion: '0.0.0-smoke',
            hostname: 'smoke',
          },
          agentInstanceId: instanceId,
        }),
      );
      resolve(agent);
    });
  });
}

async function main(): Promise<void> {
  // --- half one: a different process takes the machine
  const first = await openAgent('first', 'instance-a');
  await sleep(300);
  const second = await openAgent('second', 'instance-b');
  await sleep(1000);

  if (!first.superseded) fail('the superseded daemon was never told to stand down');
  if (!first.closed) fail('the hub kept the superseded socket open — that is the ghost');
  if (second.superseded) fail('the winner was told to stand down');
  if (second.closed) fail('the winner lost its socket');
  console.log('ok: a second process takes the machine, the first is told and hung up on');

  // --- half two: the same process reconnecting is a blip, not a duplicate
  const again = await openAgent('second-reconnected', 'instance-b');
  await sleep(1000);

  if (second.superseded) fail('a plain reconnect ordered the daemon to exit — every blip would kill it');
  if (!second.closed) fail('the superseded socket stayed open');
  if (again.superseded) fail('the reconnected daemon was told to stand down');
  console.log('ok: the same process reconnecting is dropped, never ordered out');

  first.sock.close();
  second.sock.close();
  again.sock.close();
  console.log('PASS supersede-smoke');
  process.exit(0);
}

void main().catch((e) => fail(String(e)));
