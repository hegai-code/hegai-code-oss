import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { AUTO_REF, HubClient, type HubHandlers } from '../src/hub.js';

/**
 * «⚠️ Run not found (already closed?)» after every hub deploy. The bot is back
 * within a second of a hub restart and the agents are not, so a blind
 * re-subscribe on open was refused — and the refusal went to the chat, and the
 * subscription was lost for good.
 */
function harness() {
  const said: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const noop = () => {};
  const handlers: HubHandlers = {
    onReady: noop, onStream: noop, onToolRequest: noop, onRunStatus: noop, onOpened: noop,
    onSessionStarted: noop, onActivity: noop, onEnrich: noop, onUnauthorized: noop,
    onHubError: (m) => said.push(m),
  };
  const hub = new HubClient('ws://x', 's', handlers);
  const h = hub as unknown as { ws: unknown; onMessage: (raw: string) => void };
  h.ws = { readyState: WebSocket.OPEN, send: (raw: string) => sent.push(JSON.parse(raw)) };
  const frame = (m: unknown) => h.onMessage(JSON.stringify(m));
  const run = (runId: string) => ({ runId, machineId: 'm', sessionId: 's', state: 'idle', since: 1 });
  return { hub, said, sent, frame, run };
}

test('after a hub restart a followed run is re-subscribed when the hub lists it, not before', () => {
  const { hub, sent, frame, run } = harness();
  hub.subscribe('r1');
  sent.length = 0;
  // The socket drops and comes back: the snapshot does not know r1 yet.
  (hub as unknown as { attached: Set<string> }).attached.clear();
  frame({ type: 'snapshot', machines: [], activeRuns: [] });
  assert.equal(sent.length, 0, 'nothing is asked of a run the hub does not have');
  // The agent re-registers; the run is back.
  frame({ type: 'activity', runs: [run('r1')] });
  assert.deepEqual(sent, [{ type: 'subscribe', runId: 'r1', ref: AUTO_REF + 'r1' }]);
  frame({ type: 'activity', runs: [run('r1')] });
  assert.equal(sent.length, 1, 'once per socket, not per frame');
});

test('a refused automatic re-subscribe is a log line, not a chat message, and is retried', () => {
  const { hub, said, sent, frame, run } = harness();
  hub.subscribe('r1');
  (hub as unknown as { attached: Set<string> }).attached.clear();
  sent.length = 0;
  frame({ type: 'activity', runs: [run('r1')] });
  frame({ type: 'error', message: 'Run not found (already closed?).', ref: AUTO_REF + 'r1' });
  assert.deepEqual(said, []);
  frame({ type: 'activity', runs: [run('r1')] });
  assert.equal(sent.length, 2, 'tried again on the next listing');
});

test('a refusal of something a person did still reaches the chat', () => {
  const { said, frame } = harness();
  frame({ type: 'error', message: 'Session is live in an editor.' });
  assert.deepEqual(said, ['Session is live in an editor.']);
});

test('a frame the shared schema rejects is dropped, and the next frame still lands', () => {
  const { sent, frame, run, hub } = harness();
  const h = hub as unknown as { onMessage: (raw: string) => void };
  hub.subscribe('r1');
  (hub as unknown as { attached: Set<string> }).attached.clear();
  sent.length = 0;
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(String(m));
  try {
    h.onMessage('not json');
    h.onMessage(JSON.stringify({ type: 'activity', runs: 'nope' })); // known type, wrong shape
    h.onMessage(JSON.stringify({ type: 'from-the-future' })); // unknown type
    h.onMessage(JSON.stringify({ type: 'activity', runs: 'nope' })); // same cause: not logged twice
  } finally {
    console.warn = warn;
  }
  assert.equal(sent.length, 0, 'a rejected frame changes nothing');
  assert.ok(warned.length >= 1 && warned.length <= 3, `each distinct cause is logged once, got ${warned.length}`);
  assert.ok(warned.every((m) => m.startsWith('[hub] dropped an undecodable frame')));
  frame({ type: 'activity', runs: [run('r1')] });
  assert.deepEqual(sent, [{ type: 'subscribe', runId: 'r1', ref: AUTO_REF + 'r1' }], 'the socket keeps working');
});
