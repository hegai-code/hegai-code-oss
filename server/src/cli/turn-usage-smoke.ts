/** Real hub relay + replay for usage snapshots. Only use a throwaway hub. */
import assert from 'node:assert/strict';
import { adminLogin, smokeTarget, enrollFakeAgent, fakeSession, connectUiAs, nextAgentFrame, nextBrowserFrame } from './_harness.js';
const target = smokeTarget(process.argv);
const admin = await adminLogin(target.http, process.env['CC_REMOTE_SSO_SECRET'] ?? 'smoke-sso-secret-0123456789-0123456789');
const session = fakeSession('/projects/usage-smoke', 'Usage smoke');
const agent = await enrollFakeAgent(target, admin, { sessions: [session] });
const ui = await connectUiAs(target.ws, admin);
let late: typeof ui | undefined;
try {
  const resume = nextAgentFrame(agent.ws, 'resume');
  ui.send(JSON.stringify({ type: 'open', machineId: agent.machineId, sessionId: session.sessionId, message: 'fixture' }));
  const run = await resume;
  const event = { kind: 'status', code: 'turn_usage', text: '', data: { totalTokens: 48240 } };
  const received = nextBrowserFrame(ui, 'stream', m => m.event.code === 'turn_usage');
  agent.ws.send(JSON.stringify({ type: 'stream', runId: run.runId, sessionId: session.sessionId, event }));
  const frame = await received;
  assert.equal(frame.event.data?.['totalTokens'], 48240);
  late = await connectUiAs(target.ws, admin);
  const replay = nextBrowserFrame(late, 'stream', m => m.event.code === 'turn_usage');
  late.send(JSON.stringify({ type: 'subscribe', runId: run.runId }));
  assert.equal((await replay).event.data?.['totalTokens'], 48240);
  ui.send(JSON.stringify({ type: 'close', runId: run.runId }));
  console.log('PASS: real hub relays and replays current-turn total, including data');
} finally {
  ui.close(); late?.close(); agent.ws.close();
}
