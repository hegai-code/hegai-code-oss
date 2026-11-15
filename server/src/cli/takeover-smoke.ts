/**
 * Headless smoke for the takeover route (no live writer):
 *   browser(ws /ui) -> central 'takeover' -> agent takeoverRun -> resume -> stream.
 *
 * Picks the most recent DORMANT session (no live writer, so no process is
 * killed) and drives it through the *takeover* route — proving the 'takeover'
 * message is understood end-to-end (shared/hub/agent agree) and that a resumed
 * turn streams back. The kill-and-confirm branch is covered separately by
 * takeover-force-smoke.ts; here it's a no-op.
 *
 * Usage: tsx server/src/cli/takeover-smoke.ts [ws://127.0.0.1:4319] [token] [machineFilter]
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_MACHINE.
 */
import { decodeCentralToBrowser } from '@cc-remote/shared';
import { connectUi, machineFilterArg, pickSession, dormantWithCwd } from './_harness.js';

const { ws, send } = connectUi(process.argv);
const machineFilter = machineFilterArg(process.argv);

let runId: string | undefined;
let started = false;
let sawReply = false;

ws.on('open', () => console.log('[takeover-smoke] connected to /ui'));

ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  switch (msg.type) {
    case 'snapshot': {
      if (started) break;
      const pick = pickSession(msg.machines, machineFilter, dormantWithCwd);
      if (!pick) {
        console.log(`[takeover-smoke] no dormant session${machineFilter ? ` on "${machineFilter}"` : ''} yet; waiting…`);
        break;
      }
      started = true;
      console.log(`[takeover-smoke] takeover session ${pick.session.sessionId} on ${pick.machine.machine.name}`);
      send({
        type: 'takeover',
        machineId: pick.machine.machine.machineId,
        sessionId: pick.session.sessionId,
        message: 'Reply with exactly: TAKEOVER-OK (and use no tools).',
      });
      break;
    }
    case 'opened':
      runId = msg.runId;
      console.log(`[takeover-smoke] opened run ${runId}`);
      break;
    case 'stream':
      if (msg.event.kind === 'partial') {
        const t = msg.event.text ?? '';
        process.stdout.write(t);
        if (t.includes('TAKEOVER-OK')) sawReply = true;
      } else {
        console.log(`\n[takeover-smoke] [${msg.event.kind}] ${msg.event.text ?? ''}`);
        if ((msg.event.text ?? '').includes('TAKEOVER-OK')) sawReply = true;
      }
      break;
    case 'tool_request':
      if (runId) send({ type: 'tool_decision', runId, requestId: msg.requestId, allow: false, message: 'smoke deny' });
      break;
    case 'run_status':
      console.log(`\n[takeover-smoke] run_status: ${msg.state}${msg.error ? ` (${msg.error})` : ''}`);
      if (msg.state === 'idle' || msg.state === 'ended' || msg.state === 'error') {
        if (runId) send({ type: 'close', runId });
        const ok = sawReply && msg.state !== 'error';
        setTimeout(() => {
          console.log(ok ? '[takeover-smoke] PASS' : '[takeover-smoke] FAIL (no reply or error)');
          ws.close();
          process.exit(ok ? 0 : 1);
        }, 300);
      }
      break;
    case 'error':
      console.log(`\n[takeover-smoke] ERROR: ${msg.message}`);
      ws.close();
      process.exit(1);
  }
});

ws.on('error', (err) => {
  console.error('[takeover-smoke] ws error:', (err as Error).message);
  process.exit(1);
});

setTimeout(() => { console.error('[takeover-smoke] timeout'); process.exit(1); }, 120_000).unref();
