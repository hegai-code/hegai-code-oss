import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Subagent } from '@cc-remote/shared';
import { CodexSessionRun } from '../src/codex-run.js';

/**
 * A `CodexSessionRun` against a scripted app-server that spawns one sub-agent
 * on the first turn and narrates it on the same pipe, the way codex-cli does.
 * No model, no credentials, no real transcript.
 */
const SERVER = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = process.env.CCR_SUB_MODE;
const send = v => process.stdout.write(JSON.stringify(v) + '\n');
const child = 'child-thread';
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  appendFileSync(process.env.CCR_SUB_LOG, JSON.stringify(m) + '\n');
  const ok = result => send({ id: m.id, result });
  if (m.method === 'initialize') ok({});
  if (m.method === 'thread/start') ok({ thread: { id: 'parent-thread' }, model: 'parent-model' });
  if (m.method === 'turn/start') {
    send({ method: 'turn/started', params: { threadId: 'parent-thread', turn: { id: 'turn-1' } } });
    ok({ turn: { id: 'turn-1' } });
    send({ method: 'item/started', params: { threadId: 'parent-thread', turnId: 'turn-1', item: {
      type: 'subAgentActivity', id: 'call-1', kind: 'started', agentThreadId: child, agentPath: '/root/checker', model: 'child-model' } } });
    // codex-cli 0.162 sends no thread/started for a child; older ones did.
    if (mode === 'child-finishes') send({ method: 'thread/started', params: { thread: { id: child, parentThreadId: 'parent-thread', agentNickname: 'Hegel', model: 'child-model' } } });
    if (mode !== 'no-child-turn') send({ method: 'turn/started', params: { threadId: child, turn: { id: 'child-turn' } } });
    send({ method: 'item/started', params: { threadId: child, turnId: 'child-turn', item: { type: 'commandExecution', id: 'x1', command: 'git status' } } });
    // The child's turn ending must not end ours (30.09.2026).
    if (mode === 'child-finishes') {
      send({ method: 'item/completed', params: { threadId: child, turnId: 'child-turn', item: { type: 'agentMessage', id: 'm1', text: 'all good' } } });
      send({ method: 'turn/completed', params: { threadId: child, turn: { id: 'child-turn', status: 'completed' } } });
    }
    send({ method: 'turn/plan/updated', params: { threadId: 'parent-thread', turnId: 'turn-1', plan: [{ step: 'marker', status: 'completed' }] } });
    if (mode === 'parent-ends') send({ method: 'turn/completed', params: { threadId: 'parent-thread', turn: { id: 'turn-1', status: 'completed' } } });
  }
  if (m.method === 'turn/steer') ok({ turnId: m.params.expectedTurnId });
  if (m.method === 'thread/read') {
    if (m.params.threadId === child) ok({ thread: { id: child, parentThreadId: 'parent-thread', agentNickname: mode === 'child-finishes' ? 'Hegel' : 'Noether', agentRole: null } });
    else send({ id: m.id, error: { code: -32602, message: 'thread not found' } });
  }
  if (m.method === 'turn/interrupt') {
    const p = m.params;
    if (p.threadId === child) {
      if (p.turnId !== 'child-turn') { send({ id: m.id, error: { code: -32602, message: 'expected active turn id ' + p.turnId + ' but found child-turn' } }); return; }
      ok({});
      send({ method: 'turn/completed', params: { threadId: child, turn: { id: 'child-turn', status: 'interrupted' } } });
      return;
    }
    ok({});
    send({ method: 'turn/completed', params: { threadId: 'parent-thread', turn: { id: p.turnId, status: 'interrupted' } } });
  }
});
`;

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, 'fixture condition timed out');
    await delay(10);
  }
}

function fixture(t: TestContext, mode = '') {
  const root = mkdtempSync(join(tmpdir(), 'ccr-codex-sub-run-'));
  const log = join(root, 'rpc.jsonl');
  const server = join(root, 'server.mjs');
  const bin = join(root, 'codex');
  writeFileSync(server, SERVER);
  writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(server)};\n`, { mode: 0o755 });
  const keys = ['CODEX_BIN', 'CCR_SUB_LOG', 'CCR_SUB_MODE'] as const;
  const before = keys.map((key) => process.env[key]);
  Object.assign(process.env, { CODEX_BIN: bin, CCR_SUB_LOG: log, CCR_SUB_MODE: mode });
  const events: Array<{ kind: string; text?: string; code?: string; data?: Record<string, unknown> }> = [];
  const models: string[] = [];
  const run = new CodexSessionRun({
    cwd: root,
    handlers: { onEvent: (e) => events.push(e), onActiveModel: (m) => models.push(m) },
  });
  t.after(async () => {
    run.close();
    await run.completed;
    keys.forEach((key, i) => {
      if (before[i] === undefined) delete process.env[key];
      else process.env[key] = before[i];
    });
    rmSync(root, { recursive: true, force: true });
  });
  const calls = (method: string): Array<{ params: Record<string, any> }> =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((m) => m.method === method);
  const frames = () => events.filter((e) => e.code === 'subagents').map((e) => e.data!['agents'] as Subagent[]);
  const lastFrame = () => frames().at(-1) ?? [];
  return { run, calls, events, models, frames, lastFrame };
}

test('a spawned child becomes a subagents card; its narration never ends or joins our turn', async (t) => {
  const { run, events, models, lastFrame } = fixture(t, 'child-finishes');
  run.sendInput('go');
  await until(() => events.some((e) => e.code === 'plan_update'));
  const [card] = lastFrame();
  assert.equal(card?.id, 'child-thread');
  assert.equal(card?.kind, 'Hegel');
  assert.equal(card?.description, 'checker');
  assert.equal(card?.status, 'completed');
  assert.equal(card?.summary, 'all good');
  assert.equal(card?.model, 'child-model');
  assert.equal(events.filter((e) => e.kind === 'result').length, 0, "the child's turn/completed did not end ours");
  assert.ok(!events.some((e) => e.text?.includes('git status') || e.text === 'all good'), 'child items are not parent rows');
  assert.ok(!models.includes('child-model'), "the child's thread/started is not our model");
  // Finished: nothing to stop.
  assert.equal(await run.stopSubagent('child-thread'), false);
});

test('stopSubagent interrupts the child thread\'s turn and marks it stopped; the parent turn goes on', async (t) => {
  const { run, events, calls, lastFrame } = fixture(t);
  run.sendInput('go');
  await until(() => lastFrame()[0]?.kind === 'Noether' && lastFrame()[0]?.lastAction !== undefined);
  assert.equal(lastFrame()[0]!.lastAction, 'Bash · git status');
  assert.deepEqual(calls('thread/read').map((c) => c.params), [{ threadId: 'child-thread', includeTurns: false }]);
  assert.equal(await run.stopSubagent('nobody'), false);
  assert.equal(await run.stopSubagent('child-thread'), true);
  const interrupts = calls('turn/interrupt');
  assert.deepEqual(interrupts.map((c) => c.params), [{ threadId: 'child-thread', turnId: 'child-turn' }]);
  assert.equal(lastFrame()[0]!.status, 'stopped');
  assert.equal(events.filter((e) => e.kind === 'result').length, 0);
  // Codex does not tell a parent blocked in wait_agent; the run does, into
  // the live turn (a steer, never a new turn).
  await until(() => calls('turn/steer').length === 1);
  const steer = calls('turn/steer')[0]!.params;
  assert.equal(steer.expectedTurnId, 'turn-1');
  assert.match(steer.input[0].text, /остановил помощника «checker»/);
  assert.equal(calls('turn/start').length, 1);
});

test('without a known child turn, the interrupt retries with the turn Codex names', async (t) => {
  const { run, calls, lastFrame } = fixture(t, 'no-child-turn');
  run.sendInput('go');
  await until(() => lastFrame()[0]?.status === 'running');
  assert.equal(await run.stopSubagent('child-thread'), true);
  assert.deepEqual(
    calls('turn/interrupt').map((c) => c.params.turnId),
    ['', 'child-turn'],
  );
  assert.equal(lastFrame()[0]!.status, 'stopped');
});

test('stopping a child of an idle parent starts nothing in the parent', async (t) => {
  const { run, events, calls, lastFrame } = fixture(t, 'parent-ends');
  run.sendInput('go');
  await until(() => events.some((e) => e.kind === 'result') && lastFrame()[0]?.status === 'running');
  assert.equal(await run.stopSubagent('child-thread'), true);
  assert.equal(lastFrame()[0]!.status, 'stopped');
  await delay(100);
  assert.equal(calls('turn/steer').length, 0);
  assert.equal(calls('turn/start').length, 1);
});
