/**
 * Headless UI client to smoke-test the full loop:
 *   browser(ws /ui) -> central -> agent -> resume -> stream -> back to browser.
 *
 * Connects, waits for a snapshot, opens the most recent DORMANT session with a
 * benign message, prints streamed output, auto-denies any tool request, and
 * exits when the turn completes. PASS requires at least one assistant/partial
 * stream event AND a non-error terminal run state.
 *
 * Usage: tsx server/src/cli/ui-smoke.ts [ws://127.0.0.1:4319] [token] [machineFilter]
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_MACHINE.
 */
import { decodeCentralToBrowser } from '@cc-remote/shared';
import { connectUi, machineFilterArg, pickSession, dormantWithCwd } from './_harness.js';

const { ws, send } = connectUi(process.argv);
const machineFilter = machineFilterArg(process.argv);

let runId: string | undefined;
let opened = false;
let sawStream = false;

ws.on('open', () => console.log('[smoke] connected to /ui'));

ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  switch (msg.type) {
    case 'snapshot': {
      console.log(`[smoke] snapshot: ${msg.machines.length} machine(s)`);
      for (const m of msg.machines) {
        console.log(`  - ${m.machine.name}: ${m.sessions.length} sessions`);
      }
      if (opened) break;
      const pick = pickSession(msg.machines, machineFilter, dormantWithCwd);
      if (!pick) {
        console.log(`[smoke] no dormant session${machineFilter ? ` on "${machineFilter}"` : ''} yet; waiting…`);
        break;
      }
      opened = true;
      console.log(`[smoke] opening session ${pick.session.sessionId} on ${pick.machine.machine.name}`);
      send({
        type: 'open',
        machineId: pick.machine.machine.machineId,
        sessionId: pick.session.sessionId,
        message: 'In one short sentence, what was this session about? Do not use any tools.',
      });
      break;
    }
    case 'opened':
      runId = msg.runId;
      console.log(`[smoke] opened run ${runId}`);
      break;
    case 'stream':
      if (msg.event.kind === 'partial' || msg.event.kind === 'assistant') sawStream = true;
      if (msg.event.kind === 'partial') process.stdout.write(msg.event.text ?? '');
      else if (msg.event.kind === 'result') console.log(`\n[smoke] ■ result: ${msg.event.text}`);
      else console.log(`\n[smoke] [${msg.event.kind}] ${msg.event.text ?? ''}`);
      break;
    case 'tool_request':
      console.log(`\n[smoke] tool_request ${msg.tool} -> auto-deny`);
      if (runId) send({ type: 'tool_decision', runId, requestId: msg.requestId, allow: false, message: 'smoke deny' });
      break;
    case 'run_status':
      console.log(`\n[smoke] run_status: ${msg.state}${msg.error ? ` (${msg.error})` : ''}`);
      if (msg.state === 'idle' || msg.state === 'ended' || msg.state === 'error') {
        if (runId) send({ type: 'close', runId });
        const ok = msg.state !== 'error' && sawStream;
        setTimeout(() => {
          console.log(ok ? '[smoke] PASS' : `[smoke] FAIL (${msg.state === 'error' ? 'run errored' : 'no assistant/partial stream seen'})`);
          ws.close();
          process.exit(ok ? 0 : 1);
        }, 300);
      }
      break;
    case 'error':
      console.log(`\n[smoke] ERROR: ${msg.message}`);
      ws.close();
      process.exit(1);
  }
});

ws.on('error', (err) => {
  console.error('[smoke] ws error:', (err as Error).message);
  process.exit(1);
});

setTimeout(() => { console.error('[smoke] timeout'); process.exit(1); }, 120_000).unref();
