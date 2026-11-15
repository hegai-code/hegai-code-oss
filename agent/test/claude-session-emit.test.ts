import { SubagentTracker } from '../src/subagent-tracker.js';
import { ImageGenLiveTracker } from '../src/image-gen.js';
import { ClaudeTurnUsage } from '../src/turn-usage.js';
import { TurnSettle } from '../src/turn-settle.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSessionRun, type StreamEvent } from '../src/claude-session.js';

/**
 * SDK message → the events the product shows.
 *
 * Every row here is a message that used to fall into `default` and vanish,
 * and each was a way for a live session to look dead: the CLI retrying an
 * overloaded API for minutes, a compaction that failed, «Not enough messages
 * to compact.», a failed turn reported as a bare subtype. The run is built
 * without spawning a CLI: `emit` is exercised on a prototype-only instance
 * with a recording handler, which is exactly the boundary under test.
 */

function harness(): { run: ClaudeSessionRun; events: StreamEvent[]; emit: (msg: unknown) => void } {
  const events: StreamEvent[] = [];
  const run = Object.create(ClaudeSessionRun.prototype) as ClaudeSessionRun;
  Object.assign(run as unknown as Record<string, unknown>, {
    handlers: { onEvent: (e: StreamEvent) => events.push(e) },
    compactInFlight: false,
    backgroundSince: new Map<string, number>(),
    subagents: new SubagentTracker(() => 1000),
    imageGen: new ImageGenLiveTracker(),
    turnUsage: new ClaudeTurnUsage(),
    settle: new TurnSettle(() => (run as unknown as { finishSettledTurn(): void }).finishSettledTurn(), 0),
  });
  const emit = (msg: unknown) => (run as unknown as { emit: (m: unknown) => void }).emit(msg);
  return { run, events, emit };
}

test('api_retry becomes a status line with a countdown and a code', () => {
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 30_000, error_status: 529, error: 'overloaded' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'status');
  assert.equal(events[0]!.code, 'api_retry');
  assert.match(events[0]!.text!, /API 529.*повтор 3\/10 через 30 с/);
  assert.equal(events[0]!.data?.['attempt'], 3);
});

test('a failed turn is an error that does NOT end the run, with the real reason', () => {
  const { events, emit } = harness();
  emit({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['API Error: Connection closed mid-response'],
    total_cost_usd: 0.42,
    num_turns: 7,
  });
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.kind, 'error');
  assert.equal(e.code, 'turn_failed');
  assert.equal(e.fatal, undefined, 'a failed turn is not a dead run');
  assert.match(e.text!, /Connection closed mid-response/);
  assert.equal(e.data?.['total_cost_usd'], 0.42);
});

test('a failed turn with no errors[] still gets a sentence, not a subtype', () => {
  const { events, emit } = harness();
  emit({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] });
  assert.match(events[0]!.text!, /предел шагов/);
});

test('a successful result carries cost and usage', async () => {
  const { events, emit } = harness();
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 1.5, usage: { input_tokens: 10 }, duration_ms: 1234 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(events[0]!.kind, 'result');
  assert.deepEqual(events[0]!.data, { subtype: 'success', total_cost_usd: 1.5, usage: { input_tokens: 10 }, duration_ms: 1234 });
});

test('compaction: started, done, failed and «not enough messages» all have codes', () => {
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'status', status: 'compacting' });
  emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 746_000, post_tokens: 10_000 } });
  emit({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'context too small' });
  emit({ type: 'system', subtype: 'local_command_output', content: 'Not enough messages to compact.' });
  const codes = events.map((e) => e.code);
  assert.deepEqual(codes, ['compact_started', 'compact_done', 'compact_failed', 'command_output', 'compact_failed']);
  assert.match(events[1]!.text!, /746k → 10k/);
  assert.equal(events[1]!.data?.['trigger'], 'manual');
  assert.match(events[2]!.text!, /context too small/);
});

test('compact_result: success counts as done only when no boundary arrived', () => {
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'status', status: 'compacting' });
  emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  assert.deepEqual(events.map((e) => e.code), ['compact_started', 'compact_done']);
  // A second verdict with nothing in flight is not a second compaction.
  emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  assert.equal(events.length, 2);
});

test('requesting is a heartbeat with no text, not a line', () => {
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'status', status: 'requesting' });
  assert.equal(events[0]!.code, 'requesting');
  assert.equal(events[0]!.text, '');
});

test('a rate limit hit says when it resets', () => {
  const { events, emit } = harness();
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_800_000_000 } });
  assert.equal(events[0]!.code, 'rate_limit');
  assert.match(events[0]!.text!, /^исчерпан лимит сессии \(5 ч\) — сброс /);
  // An allowed reading is silence.
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  assert.equal(events.length, 1);
  // A warning carries the share used — the number the line used to leave out.
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.768, resetsAt: 1_800_000_000 } });
  assert.match(events[1]!.text!, /^использовано 76% — недельный лимит — сброс /);
  assert.equal(events[1]!.data?.['utilization'], 0.768);
});

test('an assistant message the API cut short names the reason', () => {
  const { events, emit } = harness();
  emit({ type: 'assistant', error: 'max_output_tokens', message: { content: [{ type: 'text', text: 'partial…' }] }, aborted: true });
  assert.deepEqual(events.map((e) => [e.kind, e.code]), [
    ['status', 'model_error'],
    ['assistant', undefined],
    ['status', 'aborted'],
  ]);
});

test('machinery nobody needs a line for stays silent', () => {
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'hook_started', hook_name: 'x' });
  emit({ type: 'system', subtype: 'task_progress', task_id: 't' });
  emit({ type: 'user', message: { role: 'user', content: 'echo' } });
  assert.equal(events.length, 0);
});

test('assistant usage reaches the stream once per snapshot, including tool-only requests', () => {
  const { events, emit } = harness();
  const message = { id: 'm1', usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 1000 }, content: [] };
  emit({ type: 'assistant', message });
  emit({ type: 'assistant', message });
  assert.deepEqual(events.map(e => e.data?.['totalTokens']), [1030, 1030]);
  assert.ok(events.every(e => e.code === 'turn_usage' && e.text === ''));
  emit({ type: 'result', subtype: 'success' });
  emit({ type: 'assistant', message: { ...message, id: 'm2' } });
  assert.equal(events.at(-1)?.data?.['totalTokens'], 1030);
});

test('a turn killed by 401 says it is the login, not the CLI diagnostic', () => {
  // The exact frames a real CLI emits with a rejected credential (captured
  // 24.09.2026 in an isolated HOME): ten api_retry with 401, then a failed
  // result whose errors[] is only its own diagnostic.
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 615, error_status: 401, error: 'authentication_failed' });
  assert.match(events[0]!.text!, /401: Claude не принимает вход/, 'said on the first retry, not after ten');
  emit({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
  });
  const e = events[events.length - 1]!;
  assert.equal(e.kind, 'error');
  assert.equal(e.code, 'auth_failed');
  assert.match(e.text!, /не принимает вход.*401/);
  assert.doesNotMatch(e.text!, /ede_diagnostic/);
  assert.match(String(e.data?.['detail']), /ede_diagnostic/, 'the CLI text is kept for whoever debugs');
});

test('the cause belongs to one turn: a later failure does not inherit an old 401', () => {
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 600, error_status: 401, error: 'authentication_failed' });
  // The retry succeeded — the API answered.
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: Connection closed mid-response'] });
  const e = events[events.length - 1]!;
  assert.equal(e.code, 'turn_failed');
  assert.match(e.text!, /Connection closed/);
});

test('api_error_status on the result alone is enough', () => {
  const { events, emit } = harness();
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] x'], api_error_status: 529 });
  assert.match(events[0]!.text!, /529 overloaded/);
});

test('a rate limit still becomes the calm budget card', () => {
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'api_retry', attempt: 10, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' });
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] x'] });
  assert.equal(events[events.length - 1]!.code, 'budget_exhausted');
});

test('the one-shot shape of a 401: an assistant error message, then a failed result', () => {
  // Captured from the real CLI after its ten retries (24.09.2026).
  const { events, emit } = harness();
  emit({
    type: 'assistant',
    error: 'authentication_failed',
    message: { content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 API key is invalid.' }] },
  });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 401,
    result: 'Failed to authenticate. API Error: 401 API key is invalid.',
  });
  const e = events[events.length - 1]!;
  assert.equal(e.code, 'auth_failed');
  assert.equal(e.data?.['api_error_status'], 401);
});

test('turn_settled waits for the background to empty, not for the result', async () => {
  const { events, emit } = harness();
  const settled = () => events.filter((e) => e.code === 'turn_settled').length;
  const tick = () => new Promise((r) => setTimeout(r, 10));
  emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't', task_type: 'agent', description: 'x' }] });
  emit({ type: 'result', subtype: 'success', result: 'Запустил агента, жду.' });
  emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await tick();
  assert.equal(settled(), 0, 'a background agent is still working');
  assert.equal(events.filter(e => e.kind === 'result').length, 0, 'no completion/push while the child is working');
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  emit({ type: 'result', subtype: 'success', result: 'Готово.' });
  emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await tick();
  assert.equal(settled(), 1);
  assert.deepEqual(events.filter(e => e.kind === 'result').map(e => e.text), ['Готово.']);
});

test('background tasks become a status with the list, each task keeping its start', () => {
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Score all batches' }] });
  const first = events.at(-1)!;
  assert.equal(first.kind, 'status');
  assert.equal(first.code, 'background_tasks');
  const [t1] = first.data?.['tasks'] as { id: string; description: string; since: number }[];
  assert.equal(t1!.id, 'b1');
  assert.equal(t1!.description, 'Score all batches');
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'b1', task_type: 'local_bash', description: 'Score all batches' },
    { task_id: 'a2', task_type: 'local_agent', description: 'Research' },
  ] });
  const both = events.at(-1)!.data?.['tasks'] as { id: string; since: number }[];
  assert.equal(both.length, 2);
  assert.equal(both[0]!.since, t1!.since, 'a task keeps the start it was first seen at');
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.deepEqual(events.at(-1)!.data?.['tasks'], [], 'the empty set is said out loud — it is what ends the hold');
});

test('a denied tool says why in words, not the SDK discriminator', () => {
  // 30.09.2026: «Bash was denied (subcommandResults)» read as a crash — one
  // subcommand of a compound Bash touched a path in the deny list.
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', decision_reason_type: 'subcommandResults', message: 'x' });
  assert.equal(events[0]!.code, 'permission_denied');
  assert.equal(events[0]!.text, 'Bash не выполнен — часть составной команды задела запрет в настройках');
  assert.doesNotMatch(events[0]!.text!, /subcommandResults|denied/);
});

test('a denial keeps the deciding component’s own reason, without ANSI and bounded', () => {
  const { events, emit } = harness();
  emit({ type: 'system', subtype: 'permission_denied', tool_name: 'Read', tool_use_id: 't2', decision_reason_type: 'hook', decision_reason: '\x1b[31mblocked\x1b[0m   by  hook ' + 'a'.repeat(300), message: 'x' });
  const text = events[0]!.text!;
  assert.match(text, /^Read не выполнен — остановлено хуком: blocked by hook a+…$/);
  assert.ok(text.length < 260);
  emit({ type: 'system', subtype: 'permission_denied', tool_use_id: 't3', decision_reason_type: 'whatever', message: 'x' });
  assert.equal(events[1]!.text, 'Инструмент не выполнен — отказано в разрешении');
});

test('a sub-agent’s messages never stream as the main thread’s reply (10.10.2026)', () => {
  const { events, emit } = harness();
  // Shapes as the SDK delivered them for a background Agent call (CLI 2.1.296):
  // its thinking, tool calls and final report all carry parent_tool_use_id.
  const parent = 'toolu_01W5papZNKV6XneE3Svw1pRF';
  emit({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] } });
  emit({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: '## 8. Where admin lives and secret-token patterns' }], usage: { input_tokens: 90_000 } } });
  emit({ type: 'stream_event', parent_tool_use_id: parent, event: { delta: { type: 'text_delta', text: '## SUBAGENT' } } });
  assert.deepEqual(events, []);
  // The main thread's own text still comes through.
  emit({ type: 'stream_event', parent_tool_use_id: null, event: { delta: { type: 'text_delta', text: 'got' } } });
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'got it' }] } });
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [['partial', 'got'], ['assistant', 'got it']]);
});

test('a sub-agent becomes a card: started, progress, its result, never its words', () => {
  const { events, emit } = harness();
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: 'Проверить вход' } }] } });
  const call = events.find((e) => e.kind === 'tool_use')!;
  assert.equal(call.data?.['id'], 'toolu_A', 'the live call carries its id for the card');
  emit({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_A', task_type: 'local_agent', subagent_type: 'Explore', description: 'Проверить вход' });
  let frame = events.filter((e) => e.code === 'subagents').at(-1)!;
  assert.deepEqual((frame.data!['agents'] as Array<Record<string, unknown>>).map((a) => [a['id'], a['kind'], a['status']]), [['t1', 'Explore', 'running']]);
  // The sub-agent's own message is not the session's.
  emit({ type: 'assistant', parent_tool_use_id: 'toolu_A', message: { content: [{ type: 'text', text: 'я субагент' }] } });
  assert.ok(!events.some((e) => e.kind === 'assistant' && e.text === 'я субагент'));
  // A background Bash is the panel's, not a card.
  const before = events.filter((e) => e.code === 'subagents').length;
  emit({ type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash', description: 'npm test' });
  assert.equal(events.filter((e) => e.code === 'subagents').length, before);
  // Foreground: the Agent call's result is its report and its end.
  emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: [{ type: 'text', text: 'Вход работает.' }] }] } });
  frame = events.filter((e) => e.code === 'subagents').at(-1)!;
  const a = (frame.data!['agents'] as Array<Record<string, unknown>>)[0]!;
  assert.equal(a['status'], 'completed');
  assert.equal(a['summary'], 'Вход работает.');
});

test('a hegai-image Bash call becomes image_gen started, then done with a gen: ref', () => {
  const { events, emit } = harness();
  emit({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_G1', name: 'Bash', input: { command: 'hegai-image "cat" out.png' } }] },
  });
  emit({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_G1', content: 'out.png 10x10 5 KB 2s' }] },
  });
  const gen = events.filter((e) => e.code === 'image_gen');
  assert.deepEqual(
    gen.map((e) => [e.data?.['id'], e.data?.['state'], e.data?.['ref']]),
    [
      ['toolu_G1#0', 'started', undefined],
      ['toolu_G1#0', 'done', 'gen:toolu_G1#0'],
    ],
  );
  assert.equal(gen[0]!.data?.['prompt'], 'cat');
});

test('a background task gets its owner when task_started names the call, in a second list', () => {
  const { events, emit } = harness();
  const lists = () => events.filter((e) => e.code === 'background_tasks').map((e) => e.data?.['tasks'] as Array<Record<string, unknown>>);
  emit({ type: 'system', subtype: 'task_started', task_id: 'h', tool_use_id: 'toolu_h', task_type: 'local_agent', subagent_type: 'implementer', description: 'Admin layout' });
  emit({ type: 'assistant', parent_tool_use_id: 'toolu_h', message: { content: [{ type: 'tool_use', id: 'toolu_m', name: 'Monitor', input: {} }] } });
  const mon = { task_id: 'm', task_type: 'local_bash', description: 'my shots done' };
  // The real order (probe 04.11.2026): the level first, its bookend after.
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [mon] });
  assert.equal(lists().at(-1)![0]!['owner'], undefined);
  assert.ok(!('owner' in lists().at(-1)![0]!), 'absent, never null');
  const before = lists().length;
  const since = lists().at(-1)![0]!['since'];
  emit({ type: 'system', subtype: 'task_started', task_id: 'm', tool_use_id: 'toolu_m', task_type: 'local_bash', description: 'my shots done' });
  assert.equal(lists().length, before + 1);
  assert.equal(lists().at(-1)![0]!['owner'], 'Admin layout');
  assert.equal(lists().at(-1)![0]!['ownerId'], 'h');
  assert.equal(lists().at(-1)![0]!['since'], since, 'sending it again does not restart its clock');
  // A task of the session's own: no second list for nothing.
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [mon, { task_id: 'o', task_type: 'local_bash', description: 'npm test' }] });
  const settled = lists().length;
  emit({ type: 'system', subtype: 'task_started', task_id: 'o', tool_use_id: 'toolu_o', task_type: 'local_bash', description: 'npm test' });
  assert.equal(lists().length, settled);
  assert.equal(lists().at(-1)![0]!['owner'], 'Admin layout', 'a later list keeps the owner');
  assert.ok(!('owner' in lists().at(-1)![1]!));
});
