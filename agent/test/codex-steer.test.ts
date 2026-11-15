import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { PermissionMode } from '@cc-remote/shared';
import { CodexSessionRun } from '../src/codex-run.js';
import type { ToolApprovalDecision, ToolApprovalRequest, ToolApprover } from '../src/claude-session.js';

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, 'fixture condition timed out');
    await delay(10);
  }
}

function fixture(
  t: TestContext,
  mode = '',
  onSessionId?: (id: string) => void,
  extra: { permissionMode?: PermissionMode; approveTool?: ToolApprover; requireGateway?: boolean; model?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'ccr-steer-test-'));
  const log = join(root, 'rpc.jsonl');
  const bin = join(root, 'codex');
  const server = fileURLToPath(new URL('./fixtures/codex-steer-server.mjs', import.meta.url));
  writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(server)};\n`, { mode: 0o755 });
  const keys = ['CODEX_BIN', 'CCR_STEER_LOG', 'CCR_STEER_MODE'] as const;
  const before = keys.map(key => process.env[key]);
  Object.assign(process.env, { CODEX_BIN: bin, CCR_STEER_LOG: log, CCR_STEER_MODE: mode });
  const events: Array<{ kind: string; text?: string; code?: string; data?: Record<string, unknown> }> = [];
  const run = new CodexSessionRun({
    cwd: root,
    requireGateway: extra.requireGateway,
    model: extra.model,
    ...(extra.permissionMode ? { permissionMode: extra.permissionMode } : {}),
    handlers: { onEvent: e => events.push(e), onSessionId, ...(extra.approveTool ? { approveTool: extra.approveTool } : {}) },
  });
  t.after(async () => {
    run.close();
    await run.completed;
    keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
    rmSync(root, { recursive: true, force: true });
  });
  const calls = (method: string): Array<{ params: Record<string, any> }> =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(m => m.method === method);
  return { run, calls, events };
}

test('busy input steers the same turn immediately and preserves order and images', async t => {
  const { run, calls, events } = fixture(t);
  run.sendInput('first');
  await until(() => calls('turn/start').length === 1);
  const image = { media_type: 'image/png' as const, data: Buffer.from('image').toString('base64') };
  run.sendInput('clarification', [image]);
  run.sendInput('second clarification', [image]);
  await until(() => calls('turn/steer').length === 2);
  assert.equal(calls('turn/start').length, 1);
  assert.equal(events.filter(e => e.kind === 'result').length, 0, 'steer cannot wait for completion');
  const steers = calls('turn/steer');
  assert.deepEqual(steers.map(c => c.params.input[0].text), ['clarification', 'second clarification']);
  assert.ok(steers.every(c => c.params.expectedTurnId === 'turn-1'));
  assert.deepEqual(Object.keys(steers[0]!.params).sort(), ['expectedTurnId', 'input', 'threadId']);
  const paths = steers.map(c => c.params.input[1].path as string);
  assert.notEqual(paths[0], paths[1]);
  assert.ok(paths.every(existsSync));
  await run.interrupt();
  await until(() => events.some(e => e.kind === 'result'));
  assert.ok(paths.every(p => !existsSync(p)));
});

test('a rejected thread reports no session; an ambiguous creation crash never does', async t => {
  for (const mode of ['reject-thread', 'crash-thread']) {
    await t.test(mode, async t => {
      const { run, events } = fixture(t, mode);
      run.sendInput('do not lose this draft');
      await run.completed;
      const failure = events.find(event => event.kind === 'error');
      assert.ok(failure);
      assert.equal(failure.code === 'session_not_created', mode === 'reject-thread');
      assert.equal(run.finishedWith, 'error');
    });
  }
});

test('origin persistence failure before thread/start response prevents user input', async t => {
  let writes = 0;
  const { run, calls, events } = fixture(t, 'notify-thread-first', () => {
    writes++;
    throw new Error('ENOSPC: cannot persist session origin');
  });
  run.sendInput('must never reach the model');
  await run.completed;
  await delay(80); // consume the delayed thread/start response
  assert.equal(writes, 1);
  assert.equal(run.finishedWith, 'error');
  assert.equal(calls('turn/start').length, 0);
  const failure = events.find(event => event.kind === 'error');
  assert.match(failure?.text ?? '', /ENOSPC/);
  assert.notEqual(failure?.code, 'session_not_created', 'the runtime already created a thread');
});

test('input arriving before turn/start returns steers as soon as its id arrives', async t => {
  const { run, calls } = fixture(t, 'delayed-start');
  run.sendInput('first');
  run.sendInput('during startup');
  await until(() => calls('turn/steer').length === 1);
  assert.equal(calls('turn/start').length, 1);
  assert.equal(calls('turn/steer')[0]!.params.expectedTurnId, 'turn-1');
});

test('explicit rejection retries once after the turn ends without a busy loop', async t => {
  const { run, calls, events } = fixture(t, 'reject');
  run.sendInput('first');
  await until(() => calls('turn/start').length === 1);
  run.sendInput('rejected input');
  await until(() => events.some(e => e.text?.includes('будет отправлено следующим')));
  assert.equal(calls('turn/steer').length, 1);
  assert.equal(calls('turn/start').length, 1);
  await run.interrupt();
  await until(() => calls('turn/start').length === 2);
  assert.equal(calls('turn/start')[1]!.params.input[0].text, 'rejected input');
});

test('completion racing a steering rejection starts the input once as a new turn', async t => {
  const { run, calls } = fixture(t, 'race');
  run.sendInput('first');
  await until(() => calls('turn/start').length === 1);
  run.sendInput('at boundary');
  await until(() => calls('turn/start').length === 2);
  assert.equal(calls('turn/steer').length, 1);
  assert.equal(calls('turn/start')[1]!.params.input[0].text, 'at boundary');
});

test('accepted steering that races completion is not replayed', async t => {
  const { run, calls, events } = fixture(t, 'accepted-race');
  run.sendInput('first');
  await until(() => calls('turn/start').length === 1);
  run.sendInput('accepted');
  await until(() => events.some(e => e.kind === 'result'));
  await delay(30);
  assert.equal(calls('turn/start').length, 1);
  assert.equal(calls('turn/steer').length, 1);
});

test('late start response cannot resurrect a completed turn id', async t => {
  const { run, calls } = fixture(t, 'late-start');
  run.sendInput('short first turn');
  run.sendInput('next turn');
  await until(() => calls('turn/start').length === 2);
  run.sendInput('steer second');
  await until(() => calls('turn/steer').length === 1);
  assert.equal(calls('turn/steer')[0]!.params.expectedTurnId, 'turn-2');
});

test('an unacknowledged steer is reported and never blindly replayed', async t => {
  const { run, calls, events } = fixture(t, 'timeout');
  run.sendInput('first');
  await until(() => calls('turn/start').length === 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  run.sendInput('uncertain delivery');
  await until(() => calls('turn/steer').length === 1);
  t.mock.timers.tick(30_001);
  await until(() => events.some(e => e.text?.includes('Не удалось подтвердить')));
  t.mock.timers.reset();
  await run.interrupt();
  await delay(30);
  assert.equal(calls('turn/start').length, 1);
  assert.equal(calls('turn/steer').length, 1);
});

test('input during manual compaction waits for its completion', async t => {
  const { run, calls } = fixture(t);
  await until(() => calls('thread/start').length === 1);
  // Allow the thread/start response to be consumed by the driver.
  await delay(20);
  await run.compact();
  run.sendInput('after compaction');
  assert.equal(calls('turn/steer').length, 0);
  await run.interrupt();
  await until(() => calls('turn/start').length === 1);
  assert.equal(calls('turn/start')[0]!.params.input[0].text, 'after compaction');
});

test('closing with a steer in flight releases its images and sends no next turn', async t => {
  const { run, calls } = fixture(t, 'timeout');
  run.sendInput('first');
  await until(() => calls('turn/start').length === 1);
  run.sendInput('image', [{ media_type: 'image/png', data: Buffer.from('image').toString('base64') }]);
  await until(() => calls('turn/steer').length === 1);
  const path = calls('turn/steer')[0]!.params.input[1].path;
  run.close();
  assert.equal(existsSync(path), false);
  await delay(20);
  assert.equal(calls('turn/start').length, 1);
});

test('a refused manual compaction does not block later steering', async t => {
  const { run, calls } = fixture(t, 'reject-compact');
  run.sendInput('first');
  await until(() => calls('turn/start').length === 1);
  await assert.rejects(run.compact(), /Compaction refused/);
  run.sendInput('still steer');
  await until(() => calls('turn/steer').length === 1);
});


test('runtime token notifications emit current-turn snapshots across turns', async t => {
  const { run, events } = fixture(t, 'usage');
  run.sendInput('first');
  await until(() => events.filter(e => e.code === 'turn_usage').length === 2);
  assert.deepEqual(events.filter(e => e.code === 'turn_usage').map(e => e.data?.['totalTokens']), [50, 100]);
  await run.interrupt();
  await until(() => events.some(e => e.kind === 'result'));
  run.sendInput('second');
  await until(() => events.filter(e => e.code === 'turn_usage').length === 4);
  assert.deepEqual(events.filter(e => e.code === 'turn_usage').map(e => e.data?.['totalTokens']), [50, 100, 50, 100]);
});

test('a command that outlives the stop of its turn does not narrate into the idle run', async t => {
  // 28.09.2026: an `nmap` finished 72 s after the stop; its output was
  // forwarded and the session read «работает…» for four hours.
  const { run, calls, events } = fixture(t, 'late-item');
  run.sendInput('scan the lan');
  await until(() => events.some(e => e.kind === 'tool_use'));
  await run.interrupt();
  await until(() => events.some(e => e.kind === 'result'));
  const afterStop = events.length;
  // The fixture sends a turn-less plan update right AFTER its stragglers, on
  // the same pipe: once it lands, every straggler has been seen (or dropped).
  await until(() => events.some(e => e.code === 'plan_update'));
  assert.deepEqual(
    events.slice(afterStop).map(e => e.code),
    ['plan_update'],
    'nothing from the ended turn after its result — only the marker',
  );
  assert.equal(events.filter(e => e.kind === 'result').length, 1, 'a repeated turn/completed is not a second result');
  assert.equal(events.find(e => e.kind === 'result')?.text, 'interrupted');
  // The run is still usable: the next turn narrates as normal.
  run.sendInput('again');
  await until(() => calls('turn/start').length === 2);
});

test('a sub-agent thread finishing mid-turn does not end the parent turn', async t => {
  // 30.09.2026: a child thread's turn/completed ended the parent run (idle
  // while Codex was still working) and the parent's own events were dropped.
  const { run, events } = fixture(t, 'child-thread');
  run.sendInput('delegate to a sub-agent');
  await until(() => events.some(e => e.code === 'plan_update'));
  assert.equal(events.filter(e => e.kind === 'result').length, 0, 'the child turn is not our result');
  assert.ok(!events.some(e => e.text === 'from the child'), "the child's output is not ours");
  await run.interrupt();
  await until(() => events.some(e => e.kind === 'result'));
  assert.equal(events.filter(e => e.kind === 'result').length, 1);
});

test('a plan turn ends with the plan card; accepting it leaves plan mode and implements', async t => {
  // 29.09.2026: a Codex plan ended in plain text and every «реализуй» after it
  // was answered «I am in Plan Mode» — nothing ever asked to leave it.
  const asked: ToolApprovalRequest[] = [];
  let answer!: (d: ToolApprovalDecision) => void;
  const approveTool: ToolApprover = req => {
    asked.push(req);
    return new Promise(resolve => { answer = resolve; });
  };
  const { run, calls, events } = fixture(t, 'plan', undefined, { permissionMode: 'plan', approveTool });
  run.sendInput('plan the CI');
  await until(() => asked.length === 1);
  assert.equal(asked[0]!.tool, 'ExitPlanMode');
  assert.equal(asked[0]!.afterTurn, true);
  assert.equal(asked[0]!.input['plan'], '# План\n- шаг');
  const resultAt = events.findIndex(e => e.kind === 'result');
  assert.ok(resultAt >= 0, 'the card comes after the turn\'s result');
  answer({ allow: true, permissionMode: 'acceptEdits' });
  await until(() => calls('turn/start').length === 2);
  const second = calls('turn/start')[1]!.params;
  assert.equal(second.collaborationMode.mode, 'default');
  assert.equal(second.input[0].text, 'Implement the plan.');
  assert.ok(events.some(e => e.code === 'plan_accepted'));
  // The implementation turn is not a plan turn: no second card.
  await until(() => events.filter(e => e.kind === 'result').length === 2);
  await delay(30);
  assert.equal(asked.length, 1);
});

test('refusing the plan card keeps planning; a message typed instead of an answer wins', async t => {
  const asked: ToolApprovalRequest[] = [];
  const answers: Array<(d: ToolApprovalDecision) => void> = [];
  const approveTool: ToolApprover = req => {
    asked.push(req);
    return new Promise(resolve => { answers.push(resolve); });
  };
  const { run, calls } = fixture(t, 'plan', undefined, { permissionMode: 'plan', approveTool });
  run.sendInput('plan it');
  await until(() => asked.length === 1);
  answers[0]!({ allow: false });
  await delay(30);
  assert.equal(calls('turn/start').length, 1, 'a refusal starts nothing');
  run.sendInput('add a step');
  await until(() => asked.length === 2);
  assert.equal(calls('turn/start')[1]!.params.collaborationMode.mode, 'plan');
  // Walk past the second card: type instead, then a late «accept» arrives.
  run.sendInput('one more thing');
  await until(() => calls('turn/start').length === 3);
  answers[1]!({ allow: true });
  await delay(30);
  assert.equal(calls('turn/start').length, 3, 'a stale accept does not start an implementation');
  assert.equal(calls('turn/start')[2]!.params.collaborationMode.mode, 'plan');
});


test('internal sessions check the effective gateway before creating a thread', async t => {
  for (const mode of ['gateway-personal', 'gateway-error']) {
    await t.test(mode, async t => {
      const { run, calls, events } = fixture(t, mode, undefined, { requireGateway: true });
      run.sendInput('private spec');
      await run.completed;
      assert.equal(calls('config/read').length, 1);
      assert.equal(calls('thread/start').length, 0);
      assert.equal(calls('turn/start').length, 0);
      assert.ok(events.some(e => e.code === 'session_not_created'));
    });
  }
});

test('gateway selection survives rejected model fallback and keeps plan mode', async t => {
  const { run, calls } = fixture(t, 'gateway-reject-model', undefined,
    { requireGateway: true, permissionMode: 'plan', model: 'unknown-model' });
  run.sendInput('plan a backend change');
  await until(() => calls('turn/start').length === 1);
  const reads = calls('config/read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.params.cwd, calls('thread/start')[0]!.params.cwd);
  assert.equal(calls('thread/start').length, 2);
  assert.ok(calls('thread/start').every(c => c.params.modelProvider === 'hegai'));
  assert.equal(calls('thread/start')[1]!.params.model, undefined);
  assert.equal(calls('turn/start')[0]!.params.collaborationMode.mode, 'plan');
});

test('ordinary product sessions do not require or override a gateway', async t => {
  const { run, calls } = fixture(t, 'gateway-personal');
  run.sendInput('personal session');
  await until(() => calls('turn/start').length === 1);
  assert.equal(calls('config/read').length, 0);
  assert.equal(calls('thread/start')[0]!.params.modelProvider, undefined);
});

test('a picture written to the rollout during the turn becomes an image_gen card before the result', async t => {
  process.env['CC_REMOTE_IMAGE_TAIL_MS'] = '25';
  const { run, events } = fixture(t, 'rollout-image');
  const dir = mkdtempSync(join(tmpdir(), 'ccr-rollout-'));
  t.after(() => { delete process.env['CCR_ROLLOUT']; delete process.env['CC_REMOTE_IMAGE_TAIL_MS']; rmSync(dir, { recursive: true, force: true }); });
  const rollout = join(dir, 'rollout.jsonl');
  // An older picture already in the file must not be announced.
  const old = { type: 'response_item', payload: { type: 'image_generation_call', id: 'ig_old', status: 'completed', result: 'BBBB' } };
  writeFileSync(rollout, `${JSON.stringify(old)}\n`);
  process.env['CCR_ROLLOUT'] = rollout;
  (run as unknown as { rolloutPath: string }).rolloutPath = rollout;
  run.sendInput('draw');
  await until(() => events.some(e => e.kind === 'result'));
  const gen = events.filter(e => e.code === 'image_gen');
  assert.deepEqual(gen.map(e => [e.data?.['id'], e.data?.['state'], e.data?.['ref'], e.data?.['prompt']]), [
    ['ig_live', 'started', undefined, 'a red fox'],
    ['ig_live', 'done', 'gen:ig_live', 'a red fox'],
  ]);
  assert.ok(events.findIndex(e => e.code === 'image_gen') < events.findIndex(e => e.kind === 'result'));
});
