import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SUBAGENTS_MAX, type Subagent } from '@cc-remote/shared';
import {
  CodexSubagents,
  codexForkBoundary,
  interruptRaceTurnId,
  loadCodexSubagentHistory,
  uuidV7Ms,
} from '../src/codex-subagents.js';
import { resetCodexParseCache } from '../src/codex.js';

const PARENT = 'parent-thread';

function tracker(opts: { tickMs?: number; now?: () => number } = {}) {
  const frames: Subagent[][] = [];
  const t = new CodexSubagents(() => PARENT, (agents) => frames.push(agents), { tickMs: opts.tickMs ?? 10_000, now: opts.now });
  return { t, frames, last: () => frames[frames.length - 1] ?? [] };
}

const activity = (kind: string, id = 'child-1', extra: Record<string, unknown> = {}) => ({
  type: 'subAgentActivity', id: `act-${kind}-${id}`, kind, agentThreadId: id, agentPath: '/root/post_critic', model: 'gpt-x', ...extra,
});

test('subAgentActivity started → one running card, named by the path until the child names itself', () => {
  const { t, frames, last } = tracker();
  assert.equal(t.parentItem(activity('started')), true);
  assert.equal(frames.length, 1);
  assert.deepEqual(
    { ...last()[0], startedAt: 0 },
    { id: 'child-1', kind: 'agent', description: 'post_critic', status: 'running', startedAt: 0, model: 'gpt-x' },
  );
  // The child's own thread/started carries its nickname.
  t.childNotification('child-1', 'thread/started', {
    thread: { id: 'child-1', parentThreadId: PARENT, agentNickname: 'Hegel', agentRole: null },
  });
  assert.equal(last()[0]!.kind, 'Hegel');
  assert.equal(t.isRunning('child-1'), true);
  // Not a sub-agent item.
  assert.equal(t.parentItem({ type: 'agentMessage', text: 'hi' }), false);
});

test('thread/started of somebody else\'s child or a grandchild registers nothing', () => {
  const { t, frames } = tracker();
  t.childNotification('g', 'thread/started', { thread: { id: 'g', parentThreadId: 'child-1' } });
  t.childNotification('x', 'thread/started', { thread: { id: 'x', parentThreadId: null } });
  t.childNotification('unknown', 'turn/started', { threadId: 'unknown', turn: { id: 't' } });
  assert.equal(frames.length, 0);
  // But one spawned by this thread (all-CLI `source` shape) does.
  t.childNotification('c', 'thread/started', {
    thread: { id: 'c', source: { subagent: { thread_spawn: { parent_thread_id: PARENT, agent_path: '/root/w', agent_role: 'worker' } } } },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0]![0]!.kind, 'worker');
  assert.equal(frames[0]![0]!.description, 'w');
});

test('child activity sets lastAction and counts each tool call once; turn end → completed with its last message', () => {
  const { t, frames, last } = tracker({ tickMs: 0 });
  t.parentItem(activity('started'));
  t.childNotification('child-1', 'turn/started', { threadId: 'child-1', turn: { id: 'ct-1' } });
  assert.equal(t.activeTurn('child-1'), 'ct-1');
  const cmd = { type: 'commandExecution', id: 'exec-1', command: '/bin/bash -lc git status' };
  t.childNotification('child-1', 'item/started', { threadId: 'child-1', item: cmd });
  t.childNotification('child-1', 'item/completed', { threadId: 'child-1', item: { ...cmd, status: 'completed' } });
  assert.equal(last()[0]!.lastAction, 'Bash · git status');
  assert.equal(last()[0]!.toolUses, 1);
  t.childNotification('child-1', 'item/completed', {
    threadId: 'child-1', item: { type: 'fileChange', id: 'fc-1', changes: [{ path: '/srv/x/a.ts' }, { path: 'b.ts' }] },
  });
  assert.equal(last()[0]!.lastAction, 'Edit · a.ts, b.ts');
  assert.equal(last()[0]!.toolUses, 2);
  t.childNotification('child-1', 'thread/tokenUsage/updated', {
    threadId: 'child-1', tokenUsage: { total: { totalTokens: 1234.4 } },
  });
  assert.equal(last()[0]!.tokens, 1234);
  t.childNotification('child-1', 'item/completed', { threadId: 'child-1', item: { type: 'agentMessage', id: 'm', text: 'verdict: pass' } });
  const before = frames.length;
  t.childNotification('child-1', 'turn/completed', { threadId: 'child-1', turn: { id: 'ct-1', status: 'completed' } });
  assert.equal(frames.length, before + 1);
  const done = last()[0]!;
  assert.equal(done.status, 'completed');
  assert.equal(done.summary, 'verdict: pass');
  assert.equal(done.lastAction, undefined);
  assert.equal(typeof done.endedAt, 'number');
  assert.equal(t.activeTurn('child-1'), undefined);
  // A follow-up wakes it again.
  t.childNotification('child-1', 'turn/started', { threadId: 'child-1', turn: { id: 'ct-2' } });
  assert.equal(last()[0]!.status, 'running');
  assert.equal(last()[0]!.summary, undefined);
});

test('ending statuses: interrupted, failed, errored, closed while running, subAgentActivity', () => {
  const { t, last } = tracker();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) t.parentItem(activity('started', id));
  t.childNotification('a', 'turn/started', { threadId: 'a', turn: { id: 'ta' } });
  t.childNotification('a', 'turn/completed', { threadId: 'a', turn: { id: 'ta', status: 'interrupted' } });
  t.childNotification('b', 'turn/completed', { threadId: 'b', turn: { id: 'tb', status: 'failed', error: { message: 'boom' } } });
  t.parentItem({
    type: 'collabAgentToolCall', id: 'w1', tool: 'wait', status: 'completed', receiverThreadIds: ['c', 'd'],
    agentsStates: { c: { status: 'errored', message: 'no model' }, d: { status: 'completed', message: 'report D' } },
  });
  t.parentItem({ type: 'collabAgentToolCall', id: 'k', tool: 'closeAgent', receiverThreadIds: ['e'], agentsStates: { e: { status: 'shutdown' } } });
  t.parentItem(activity('interrupted', 'f'));
  const by = new Map(last().map((a) => [a.id, a]));
  assert.equal(by.get('a')!.status, 'stopped');
  assert.equal(by.get('b')!.status, 'failed');
  assert.equal(by.get('b')!.summary, 'boom');
  assert.equal(by.get('c')!.status, 'failed');
  assert.equal(by.get('c')!.summary, 'no model');
  assert.equal(by.get('d')!.status, 'completed');
  assert.equal(by.get('d')!.summary, 'report D');
  assert.equal(by.get('e')!.status, 'stopped');
  assert.equal(by.get('f')!.status, 'stopped');
  // A stale `running` in a later call does not revive a finished one.
  t.parentItem({ type: 'collabAgentToolCall', id: 'w2', tool: 'wait', receiverThreadIds: ['d'], agentsStates: { d: { status: 'running' } } });
  assert.equal(new Map(last().map((a) => [a.id, a])).get('d')!.status, 'completed');
  // An ending for an agent this run never saw start is not a card.
  t.parentItem(activity('completed', 'old-child'));
  assert.equal(last().some((a) => a.id === 'old-child'), false);
});

test('v1 spawnAgent: the prompt is the description and the call id anchors the card', () => {
  const { t, last } = tracker();
  t.parentItem({
    type: 'collabAgentToolCall', id: 'call-spawn', tool: 'spawnAgent', status: 'inProgress', senderThreadId: PARENT,
    receiverThreadIds: ['kid'], prompt: '  Review the\n diff for bugs ', model: 'gpt-5', agentsStates: { kid: { status: 'pendingInit', message: null } },
  });
  assert.deepEqual(
    { ...last()[0], startedAt: 0 },
    { id: 'kid', kind: 'agent', description: 'Review the diff for bugs', status: 'running', startedAt: 0, model: 'gpt-5', toolUseId: 'call-spawn' },
  );
  // The later subAgentActivity does not overwrite the prompt with the path.
  t.parentItem(activity('started', 'kid'));
  assert.equal(last()[0]!.description, 'Review the diff for bugs');
});

test('stopped() marks a running agent at once; an unknown one is not running', () => {
  const { t, last } = tracker();
  t.parentItem(activity('started'));
  t.stopped('child-1');
  assert.equal(last()[0]!.status, 'stopped');
  assert.equal(t.isRunning('child-1'), false);
  assert.equal(t.isRunning('nope'), false);
  assert.equal(t.has('nope'), false);
});

test('progress is throttled to one trailing frame per tick; status goes out at once; close() cancels', async () => {
  const { t, frames, last } = tracker({ tickMs: 80 });
  t.parentItem(activity('started'));
  assert.equal(frames.length, 1);
  for (let i = 0; i < 5; i++) {
    t.childNotification('child-1', 'item/started', { threadId: 'child-1', item: { type: 'commandExecution', id: `e${i}`, command: `echo ${i}` } });
  }
  assert.equal(frames.length, 1, 'progress inside the tick waits');
  await delay(130);
  assert.equal(frames.length, 2, 'one trailing frame');
  assert.equal(last()[0]!.toolUses, 5);
  assert.equal(last()[0]!.lastAction, 'Bash · echo 4');
  // Status pre-empts a pending progress timer.
  t.childNotification('child-1', 'item/started', { threadId: 'child-1', item: { type: 'webSearch', id: 's', query: 'x' } });
  t.childNotification('child-1', 'turn/completed', { threadId: 'child-1', turn: { id: 'z', status: 'completed' } });
  assert.equal(frames.length, 3);
  assert.equal(last()[0]!.status, 'completed');
  await delay(130);
  assert.equal(frames.length, 3, 'the cancelled progress tick sent nothing more');
  // After close nothing is sent.
  t.parentItem(activity('started', 'late'));
  t.childNotification('late', 'item/started', { threadId: 'late', item: { type: 'commandExecution', id: 'q', command: 'ls' } });
  const n = frames.length;
  t.close();
  t.parentItem(activity('started', 'later'));
  await delay(130);
  assert.equal(frames.length, n);
});

test('cap: running first, then the newest finished, at most SUBAGENTS_MAX', () => {
  let clock = 1000;
  const { t, last } = tracker({ now: () => ++clock });
  for (let i = 0; i < 40; i++) t.parentItem(activity('started', `c${i}`));
  for (let i = 0; i < 38; i++) t.parentItem(activity('completed', `c${i}`));
  const agents = last();
  assert.equal(agents.length, SUBAGENTS_MAX);
  assert.deepEqual(agents.slice(0, 2).map((a) => a.id), ['c38', 'c39']);
  assert.ok(agents.slice(0, 2).every((a) => a.status === 'running'));
  assert.equal(agents[2]!.id, 'c37', 'newest finished first');
  assert.equal(agents.some((a) => a.id === 'c0'), false, 'the oldest finished fell off');
  assert.equal(t.has('c0'), false, 'and is forgotten');
});

test('interruptRaceTurnId reads the live turn out of Codex\'s refusal', () => {
  assert.equal(interruptRaceTurnId('expected active turn id turn-a but found turn-b'), 'turn-b');
  assert.equal(interruptRaceTurnId('expected active turn id  but found turn-b'), 'turn-b');
  assert.equal(interruptRaceTurnId('no active turn'), undefined);
});

// ── history ──────────────────────────────────────────────────────────────

const CHILD = '01a0f81b-048d-7a41-8f2e-b7281ad042c9';
const PARENT_V7 = '01a0f815-a4f4-7a42-84b0-15ec3fcb7b77';
const line = (type: string, payload: Record<string, unknown>, ts = '2026-10-01T15:35:15.000Z') =>
  JSON.stringify({ timestamp: ts, type, payload });
const msg = (role: string, text: string) =>
  line('response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });

/** The shape of a real child rollout (10.10.2026): own meta, the parent's
 *  copied meta and turns, then the child's turn. */
function forkedRollout(spawnSource = true): string[] {
  return [
    line('session_meta', {
      id: CHILD, forked_from_id: PARENT_V7, timestamp: '2026-10-01T15:35:15.364Z',
      ...(spawnSource ? { source: { subagent: { thread_spawn: { parent_thread_id: PARENT_V7, depth: 1, agent_path: '/root/post_critic' } } } } : { source: 'vscode' }),
      thread_source: spawnSource ? 'subagent' : null,
    }),
    line('session_meta', { id: PARENT_V7, source: 'vscode', timestamp: '2026-10-01T15:29:23.223Z' }),
    line('event_msg', { type: 'task_started', turn_id: '01a0f815-a5c3-7ae2-b19d-6ede2ec57b8d', started_at: 1790868563 }),
    line('turn_context', { turn_id: '01a0f815-a5c3-7ae2-b19d-6ede2ec57b8d' }),
    msg('user', 'PARENT QUESTION'),
    msg('assistant', 'PARENT ANSWER'),
    line('event_msg', { type: 'task_started', turn_id: '01a0f818-e1f0-7931-a0a2-8f692d11623b', started_at: 1790868775 }),
    msg('user', 'глянь в проекте'),
    line('event_msg', { type: 'thread_settings_applied', thread_id: CHILD }),
    line('event_msg', { type: 'task_started', turn_id: '01a0f81b-052e-7d93-83e3-b5d841eb32f4', root_turn_id: '01a0f818-e1f0-7931-a0a2-8f692d11623b', started_at: 1790868915 }),
    line('turn_context', { turn_id: '01a0f81b-052e-7d93-83e3-b5d841eb32f4' }),
    line('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'cat voice.md' }),
    line('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'x'.repeat(500) }),
    msg('assistant', 'CHILD REPORT'),
  ];
}

test('uuidV7Ms reads the minting time; other ids are not v7', () => {
  assert.equal(uuidV7Ms(CHILD), 0x01a0f81b048d);
  assert.equal(uuidV7Ms('fixture-thread'), undefined);
  assert.equal(uuidV7Ms('3f2b1c4d-1111-4abc-8def-0123456789ab'), undefined);
});

test('fork boundary: the first turn minted after the child thread', () => {
  const lines = forkedRollout();
  assert.equal(codexForkBoundary(lines, CHILD), 9);
  // Older CLI: no copied session_meta, no thread_settings_applied.
  const older = lines.filter((l) => !l.includes('thread_settings_applied') && !l.includes(`"id":"${PARENT_V7}"`));
  assert.equal(JSON.parse(older[codexForkBoundary(older, CHILD)]!).payload.turn_id, '01a0f81b-052e-7d93-83e3-b5d841eb32f4');
  // codex-cli 0.162: the turn id nests in `turn_attribution`.
  const nested = lines.map((l) => l.replace(/"type":"task_started","turn_id":("[^"]+")/, '"type":"task_started","turn_attribution":{"turn_id":$1}'))
    .filter((l) => !l.includes('turn_context'));
  assert.ok(nested[8]!.includes('turn_attribution'));
  assert.equal(codexForkBoundary(nested, CHILD), 8);
  // A child with no turn of its own yet.
  assert.equal(codexForkBoundary(lines.slice(0, 9), CHILD), -1);
});

test('fork boundary falls back to started_at for ids that are not UUIDv7', () => {
  const lines = [
    line('session_meta', { id: 'kid', timestamp: '2026-10-01T15:35:15.364Z' }),
    line('event_msg', { type: 'task_started', turn_id: 'p-turn', started_at: Date.parse('2026-10-01T15:30:00Z') / 1000 }),
    line('event_msg', { type: 'task_started', turn_id: 'k-turn', started_at: Date.parse('2026-10-01T15:35:15Z') / 1000 }),
  ];
  assert.equal(codexForkBoundary(lines, 'kid'), 2);
});

test('loadCodexSubagentHistory returns only the child\'s own turns, through the shared parser', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccr-codex-sub-'));
  const day = join(root, 'sessions', '2026', '10', '01');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-10-01T17-35-15-${CHILD}.jsonl`), forkedRollout().join('\n') + '\n');
  const plain = '01a0f900-0000-7000-8000-000000000000';
  writeFileSync(join(day, `rollout-2026-10-01T18-00-00-${plain}.jsonl`), [
    line('session_meta', { id: plain, source: 'vscode' }),
    line('event_msg', { type: 'task_started', turn_id: '01a0f900-0001-7000-8000-000000000000' }),
    msg('user', 'a normal session'),
  ].join('\n') + '\n');
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = root;
  resetCodexParseCache();
  t.after(() => {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    resetCodexParseCache();
    rmSync(root, { recursive: true, force: true });
  });

  const messages = await loadCodexSubagentHistory(CHILD, 1000);
  const text = JSON.stringify(messages);
  assert.ok(!text.includes('PARENT QUESTION') && !text.includes('PARENT ANSWER') && !text.includes('глянь в проекте'), 'no forked parent history');
  assert.deepEqual(messages.map((m) => m.type), ['assistant', 'user', 'assistant']);
  assert.equal(messages[0]!.blocks[0]!.kind, 'tool_use');
  assert.ok(text.includes('CHILD REPORT'));

  // limit keeps the newest; toolChars trims tool payloads.
  assert.equal((await loadCodexSubagentHistory(CHILD, 1)).length, 1);
  const trimmed = await loadCodexSubagentHistory(CHILD, 1000, 50);
  const result = trimmed[1]!.blocks[0]!;
  assert.ok(result.kind === 'tool_result' && result.text.length < 200);

  // Parent check, unknown ids, and a rollout that is not a spawned thread.
  assert.equal((await loadCodexSubagentHistory(CHILD, 1000, undefined, PARENT_V7)).length, 3);
  assert.deepEqual(await loadCodexSubagentHistory(CHILD, 1000, undefined, 'someone-else'), []);
  assert.deepEqual(await loadCodexSubagentHistory('01a0ffff-0000-7000-8000-000000000000', 1000), []);
  assert.deepEqual(await loadCodexSubagentHistory(plain, 1000), []);
});
