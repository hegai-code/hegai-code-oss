#!/usr/bin/env node
// Use ONLY an isolated loopback Rust hub with CC_REMOTE_TOKEN=dev-token.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { AgentToCentral, BrowserToCentral } from '../../shared/dist/index.js';

const base = new URL(process.env.ANDROID_SMOKE_URL ?? 'http://127.0.0.1:18519');
assert.equal(base.hostname, '127.0.0.1', 'An isolated loopback hub is required');
const machineId = `android-delivery-${randomUUID()}`;
const transcript = [];
function connect(path, schema) {
  const url = new URL(path, base); url.protocol = 'ws:';
  if (path === '/agent') url.searchParams.set('token', 'dev-token');
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer dev-token' } });
  const queue = [];
  ws.on('message', raw => { const frame = JSON.parse(raw); queue.push(frame); transcript.push({ path, ...frame }); });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, opened,
    send(frame) { ws.send(JSON.stringify(schema.parse(frame))); },
    async next(type, predicate = () => true) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const index = queue.findIndex(f => f.type === type && predicate(f));
        if (index >= 0) return queue.splice(index, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Timeout: ${path} ${type}`);
    },
  };
}
const agent = connect('/agent', AgentToCentral);
let ui;
try {
  await agent.opened;
  agent.send({ type: 'register', protocol: 1, agentInstanceId: randomUUID(), machine: { machineId, name: 'Android delivery smoke', os: 'linux', agentVersion: 'synthetic' } });
  await agent.next('register_ack');
  ui = connect('/ui', BrowserToCentral); await ui.opened;
  ui.send({ type: 'hello', client: 'app' });
  await ui.next('snapshot', f => f.machines.some(m => m.machine.machineId === machineId));
  const firstRef = randomUUID();
  ui.send({ type: 'new_session', machineId, cwd: '/home/smoke/android-delivery', source: 'codex', message: 'same', images: [{ media_type: 'image/png', data: 'YQ==' }], ref: firstRef });
  const opened = await ui.next('opened', f => f.ref === firstRef);
  assert.equal(opened.sessionId, '');
  const first = await ui.next('user_turn', f => f.ref === firstRef);
  assert.equal(first.sessionId, ''); assert.equal(first.text, 'same'); assert.equal(first.images, 1);
  const create = await agent.next('new_session');
  assert.equal(create.images[0].data, 'YQ==');
  const secondRef = randomUUID();
  ui.send({ type: 'input', runId: opened.runId, text: 'same', images: [{ media_type: 'image/png', data: 'Yg==' }], ref: secondRef });
  const second = await ui.next('user_turn', f => f.ref === secondRef);
  assert.notEqual(first.turnId, second.turnId); assert.equal(second.images, 1);
  const input = await agent.next('input'); assert.equal(input.images[0].data, 'Yg==');
  const droppedRef = randomUUID();
  // Reproduce a buggy older client's over-limit frame: intentionally bypass zod for this one.
  ui.ws.send(JSON.stringify({ type: 'input', runId: opened.runId, text: 'image must remain recoverable', images: [{ media_type: 'image/png', data: 'A'.repeat(8 * 1024 * 1024 + 4) }], ref: droppedRef }));
  await ui.next('error', f => f.ref === droppedRef && f.code === 'attachments_dropped');
  const dropped = await ui.next('user_turn', f => f.ref === droppedRef);
  assert.equal(dropped.images ?? 0, 0);
  const sanitized = await agent.next('input'); assert.ok(!sanitized.images?.length);
  const paneRef = randomUUID();
  ui.send({ type: 'subscribe', runId: opened.runId, ref: paneRef });
  await ui.next('opened', f => f.ref === paneRef);
  const replayFirst = await ui.next('user_turn', f => f.turnId === first.turnId);
  const replaySecond = await ui.next('user_turn', f => f.turnId === second.turnId);
  assert.equal(replayFirst.ref, paneRef); assert.equal(replaySecond.ref, paneRef);
  assert.notEqual(replayFirst.ref, firstRef); assert.notEqual(replaySecond.ref, secondRef);
  const errorRef = randomUUID();
  ui.send({ type: 'input', runId: randomUUID(), text: 'rejected', ref: errorRef });
  await ui.next('error', f => f.ref === errorRef);
  ui.send({ type: 'close', runId: opened.runId, ref: randomUUID() });
  await agent.next('close');
  const newDroppedRef = randomUUID();
  ui.ws.send(JSON.stringify({ type: 'new_session', machineId, cwd: '/home/smoke/android-delivery', source: 'codex', message: 'new text survives dropped image', images: [{ media_type: 'image/png', data: 'A'.repeat(8 * 1024 * 1024 + 4) }], ref: newDroppedRef }));
  await ui.next('error', f => f.ref === newDroppedRef && f.code === 'attachments_dropped');
  const partialOpen = await ui.next('opened', f => f.ref === newDroppedRef);
  const partialTurn = await ui.next('user_turn', f => f.ref === newDroppedRef);
  assert.equal(partialOpen.sessionId, ''); assert.equal(partialTurn.images ?? 0, 0);
  const partialCreate = await agent.next('new_session'); assert.ok(!partialCreate.images?.length);
  const warningIndex = transcript.findIndex(f => f.ref === newDroppedRef && f.type === 'error');
  assert.ok(transcript.findIndex(f => f.ref === newDroppedRef && f.type === 'opened') > warningIndex);
  ui.send({ type: 'close', runId: partialOpen.runId, ref: randomUUID() });
  await agent.next('close');
  console.log(JSON.stringify({ passed: true, checks: ['new_session idless acceptance ref', 'input distinct acceptance ref', 'different attachment bytes reached agent', 'attachment loss reports zero accepted images', 'new_session warning precedes valid opened and text acceptance', 'both replay refs belong to subscribe', 'direct error ref', 'close reached agent'], transcript }, null, 2));
} finally {
  ui?.ws.terminate(); agent.ws.terminate();
}
