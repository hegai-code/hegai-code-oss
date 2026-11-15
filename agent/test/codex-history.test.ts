import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexActivityFromTail,
  codexRolloutMtime,
  codexUuidFromFilename,
  scanCodexSessions,
  loadCodexImage,
  loadCodexHistory,
  readCodexTranscript,
  resetCodexParseCache,
  parseCodexLines,
  parseCodexRecord,
  parseCodexRolloutHead,
  isInjectedUserText,
} from '../src/codex.js';

// Minimal synthetic rollout lines (the real files are ~/.codex/sessions/**).
const meta = JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd: '/p' } });
const devMsg = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>\n…' }] } });
const injected = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\ncwd=/p' }] } });
const userMsg = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<div>real prompt starting with a tag</div>' }] } });
const asstMsg = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] } });
const reasoning = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'thinking…' }] } });
const toolCall = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'Bash', call_id: 'c1', arguments: '{"command":"ls"}' } });
const toolOut = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'a'.repeat(20000) } });

test('metadata / developer / injected records produce no message', () => {
  assert.equal(parseCodexRecord(JSON.parse(meta), meta), null);
  assert.equal(parseCodexRecord(JSON.parse(devMsg), devMsg), null);
  assert.equal(parseCodexRecord(JSON.parse(injected), injected), null, 'env_context wrapper must be dropped');
});

test('a real user message that merely STARTS with < is kept (P0-3 regression guard)', () => {
  const m = parseCodexRecord(JSON.parse(userMsg), userMsg);
  assert.equal(m?.type, 'user');
  assert.deepEqual(m?.blocks, [{ kind: 'text', text: '<div>real prompt starting with a tag</div>' }]);
});

test('assistant text, reasoning->thinking, tool_use, tool_result mapping', () => {
  assert.deepEqual(parseCodexRecord(JSON.parse(asstMsg), asstMsg)?.blocks, [{ kind: 'text', text: 'hello' }]);
  assert.deepEqual(parseCodexRecord(JSON.parse(reasoning), reasoning)?.blocks, [{ kind: 'thinking', text: 'thinking…' }]);
  const call = parseCodexRecord(JSON.parse(toolCall), toolCall);
  assert.deepEqual(call?.blocks, [{ kind: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }]);
  const out = parseCodexRecord(JSON.parse(toolOut), toolOut);
  const block = out?.blocks[0] as { kind: string; text: string; toolUseId: string; isError: boolean };
  assert.equal(block.kind, 'tool_result');
  assert.equal(block.toolUseId, 'c1');
  assert.equal(block.text.length, 8000, 'tool_result output is capped at 8000 chars');
  assert.equal(block.isError, false);
});

test('uuid is deterministic per raw line and differs across lines', () => {
  const userUuid = parseCodexRecord(JSON.parse(userMsg), userMsg)?.uuid;
  assert.equal(userUuid, parseCodexRecord(JSON.parse(userMsg), userMsg)?.uuid);
  assert.match(userUuid ?? '', /^codex-[0-9a-f]{32}$/);
  assert.notEqual(userUuid, parseCodexRecord(JSON.parse(asstMsg), asstMsg)?.uuid);
});

test('parseCodexLines skips blanks/metadata and returns messages in order', () => {
  const text = [meta, devMsg, userMsg, asstMsg, '', toolCall, toolOut].join('\n');
  const msgs = parseCodexLines(text);
  assert.deepEqual(msgs.map((m) => m.type), ['user', 'assistant', 'assistant', 'user']);
});

test('Codex image wrappers are stripped and each real image gets a resolvable ref', () => {
  const record = {
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_image-1',
      role: 'user',
      content: [
        { type: 'input_text', text: 'посмотри' },
        { type: 'input_text', text: '<image name=[Image #1] path="/tmp/private.png">' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        { type: 'input_text', text: '</image>' },
      ],
    },
  };
  const raw = JSON.stringify(record);
  assert.deepEqual(parseCodexRecord(record, raw)?.blocks, [
    { kind: 'text', text: 'посмотри' },
    { kind: 'image', ref: 'msg_image-1#2' },
  ]);
});

test('a matching compaction handoff is hidden behind one neutral boundary', () => {
  const handoff = '## Handoff summary\n\n### User request\nrepeat me';
  const lines = [
    userMsg,
    JSON.stringify({
      timestamp: '2026-09-22T10:00:00Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: handoff }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-09-22T10:00:01Z',
      type: 'compacted',
      payload: {
        message: `Another language model started to solve this problem.\n${handoff}`,
      },
    }),
    asstMsg,
  ];
  const messages = parseCodexLines(lines.join('\n'));
  assert.deepEqual(messages.map((m) => m.type), ['user', 'system', 'assistant']);
  assert.deepEqual(messages[1]?.blocks, [{ kind: 'compact_boundary', trigger: 'auto' }]);
  assert.deepEqual(messages[2]?.blocks, [{ kind: 'text', text: 'hello' }]);
});

test('ordinary handoff wording is not hidden without a matching compaction record', () => {
  const raw = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '## Handoff summary\nThis is user-visible.' }],
    },
  });
  assert.equal(parseCodexLines(raw).length, 1);
});

test('Codex images load only from inline data URLs at the referenced content index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-image-test-'));
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = root;
  try {
    const dir = join(root, 'sessions', '2026', '09', '22');
    await mkdir(dir, { recursive: true });
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg_image-load',
        role: 'user',
        content: [
          { type: 'input_text', text: 'x' },
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      },
    });
    await writeFile(join(dir, `rollout-2026-09-22T10-00-00-${sessionId}.jsonl`), `${line}\n`);
    assert.deepEqual(await loadCodexImage(sessionId, 'msg_image-load#1'), {
      mediaType: 'image/png',
      dataB64: 'aGVsbG8=',
    });
    assert.equal(await loadCodexImage(sessionId, 'msg_image-load#0'), null);
    assert.equal(await loadCodexImage(sessionId, '../etc/passwd#1'), null);
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('rollout summary uses the first real user message and session metadata', () => {
  const summary = parseCodexRolloutHead(
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: '11111111-1111-1111-1111-111111111111', cwd: '/work/project', timestamp: '2026-07-01T10:00:00Z' },
      }),
      injected,
      userMsg,
    ].join('\n'),
    1234,
  );

  assert.deepEqual(summary, {
    sessionId: '11111111-1111-1111-1111-111111111111',
    title: '<div>real prompt starting with a tag</div>',
    source: 'codex',
    cwd: '/work/project',
    project: 'project',
    lastModified: 1234,
    createdAt: Date.parse('2026-07-01T10:00:00Z'),
  });
});

test('rollout summary marks OpenCode Go threads with provider', () => {
  const head = (payload: Record<string, unknown>) =>
    JSON.stringify({ type: 'session_meta', payload: { id: '22222222-2222-2222-2222-222222222222', cwd: '/work/p', ...payload } });
  assert.equal(parseCodexRolloutHead(head({ model_provider: 'hegai_go' }), 1, 99)?.provider, 'opencode');
  assert.equal(parseCodexRolloutHead(head({ model_provider: 'openai' }), 1, 99)?.provider, undefined);
  assert.equal(parseCodexRolloutHead(head({}), 1, 99)?.provider, undefined);
});

test('rollout summary supports legacy event titles and deterministic fallbacks', () => {
  const legacy = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Legacy prompt' } });
  assert.equal(parseCodexRolloutHead([meta, legacy].join('\n'), 0, 99)?.title, 'Legacy prompt');
  assert.equal(parseCodexRolloutHead(meta, 0, 99)?.title, 'p');
  assert.equal(parseCodexRolloutHead('not json', 0, 99), null);
});

test('rollout filename lookup extracts only an exact trailing uuid', () => {
  assert.equal(
    codexUuidFromFilename('/tmp/rollout-2026-07-01T10-00-00-11111111-1111-1111-1111-111111111111.jsonl'),
    '11111111-1111-1111-1111-111111111111',
  );
  assert.equal(codexUuidFromFilename('/tmp/rollout-contains-11111111-1111-1111-1111-111111111111-copy.jsonl'), null);
});

// --- ephemeral rollouts (codex exec / spawned sub-agent threads) -------------

const head = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd: '/p', ...payload } });

test('codex exec one-shots and sub-agent threads are not sessions', () => {
  assert.equal(parseCodexRolloutHead(head({ source: 'exec' }), 1), null);
  assert.equal(parseCodexRolloutHead(head({ thread_source: 'subagent' }), 1), null);
  // Older CLIs carry the parent inside `source` instead of `thread_source`.
  const spawned = head({ source: { subagent: { thread_spawn: { parent_thread_id: 'p1', depth: 1 } } } });
  assert.equal(parseCodexRolloutHead(spawned, 1), null);
});

test('interactive rollouts survive, and --all brings the rest back', () => {
  assert.ok(parseCodexRolloutHead(head({ source: 'vscode' }), 1));
  assert.ok(parseCodexRolloutHead(head({}), 1));
  assert.ok(parseCodexRolloutHead(head({ source: 'exec' }), 1, undefined, true));
});

test('the recommended_plugins wrapper never becomes a title', () => {
  assert.ok(isInjectedUserText('<recommended_plugins>\nHere is a list of plugins'));
});


test('large rollouts retain speech before a >4 MB record and match the full parser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-history-large-'));
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = root;
  try {
    const dir = join(root, 'sessions');
    await mkdir(dir);
    const id = '22222222-2222-2222-2222-222222222222';
    const huge = JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'large', output: 'я'.repeat(3 * 1024 * 1024),
    } });
    const handoff = '## Handoff summary\nInternal handoff';
    const text = [userMsg, asstMsg, huge,
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: handoff }] } }),
      JSON.stringify({ type: 'compacted', payload: { message: 'Another language model started to solve this problem.\n' + handoff } }),
      asstMsg, '{incomplete'].join('\r\n');
    await writeFile(join(dir, `rollout-test-${id}.jsonl`), text);
    const expected = parseCodexLines(text);
    assert.equal(expected[0]?.type, 'user');
    for (const limit of [1, 2, 3, 1000]) {
      assert.deepEqual(await loadCodexHistory(id, limit), expected.slice(-limit));
    }
    assert.deepEqual(await loadCodexHistory(id), expected);
    assert.equal((await loadCodexHistory(id, 1000, 1000))[0]?.uuid, expected[0]?.uuid);
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('a big rollout is extended, not re-parsed, and still equals a one-shot parse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-history-incr-'));
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = root;
  resetCodexParseCache();
  try {
    const dir = join(root, 'sessions');
    await mkdir(dir);
    const id = '33333333-3333-3333-3333-333333333333';
    const file = join(dir, `rollout-test-${id}.jsonl`);
    // Over INCREMENTAL_MIN_BYTES, so the parse is kept between reads.
    const huge = JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'big', output: 'x'.repeat(5 * 1024 * 1024),
    } });
    const reply = (text: string) => JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
    let text = [meta, userMsg, huge, reply('one')].join('\n') + '\n';
    await writeFile(file, text);
    assert.deepEqual((await readCodexTranscript(id))?.messages, parseCodexLines(text));

    // A record still being written: its first half is not consumed...
    const second = reply('two');
    await appendFile(file, second.slice(0, 10));
    assert.deepEqual((await readCodexTranscript(id))?.messages, parseCodexLines(text));
    // ...and once complete it arrives exactly once, even before its newline.
    await appendFile(file, second.slice(10));
    text += second;
    assert.deepEqual((await readCodexTranscript(id))?.messages, parseCodexLines(text));
    await appendFile(file, '\n' + reply('three') + '\n');
    text += '\n' + reply('three') + '\n';
    const extended = await readCodexTranscript(id);
    assert.deepEqual(extended?.messages, parseCodexLines(text));
    assert.equal(extended?.messages.at(-1)?.blocks[0]?.kind, 'text');

    // A rollout rewritten in place (same length or longer) is parsed afresh.
    const rewritten = text.replace('"one"', '"eno"');
    await writeFile(file, rewritten);
    assert.deepEqual((await readCodexTranscript(id))?.messages, parseCodexLines(rewritten));
    // So is one that shrank.
    const shrunk = [meta, userMsg, reply('only')].join('\n') + '\n';
    await writeFile(file, shrunk);
    assert.deepEqual((await readCodexTranscript(id))?.messages, parseCodexLines(shrunk));
  } finally {
    resetCodexParseCache();
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent reads of one rollout see the same complete parse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-history-conc-'));
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = root;
  resetCodexParseCache();
  try {
    const dir = join(root, 'sessions');
    await mkdir(dir);
    const id = '44444444-4444-4444-4444-444444444444';
    const big = JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'big', output: 'y'.repeat(5 * 1024 * 1024),
    } });
    const text = [meta, userMsg, big, asstMsg].join('\n') + '\n';
    await writeFile(join(dir, `rollout-test-${id}.jsonl`), text);
    const expected = parseCodexLines(text);
    const reads = await Promise.all([readCodexTranscript(id), readCodexTranscript(id), loadCodexHistory(id, 2)]);
    assert.deepEqual(reads[0]?.messages, expected);
    assert.deepEqual(reads[1]?.messages, expected);
    assert.deepEqual(reads[2], expected.slice(-2));
  } finally {
    resetCodexParseCache();
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('a rollout line over the line cap is dropped like a torn record, the rest still parses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-history-cap-'));
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = root;
  resetCodexParseCache();
  try {
    const dir = join(root, 'sessions');
    await mkdir(dir);
    const id = '55555555-5555-5555-5555-555555555555';
    const dump = JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'dump', output: 'z'.repeat(33 * 1024 * 1024),
    } });
    await writeFile(join(dir, `rollout-test-${id}.jsonl`), [meta, userMsg, dump, asstMsg].join('\n') + '\n');
    const read = await readCodexTranscript(id);
    assert.deepEqual(read?.messages, parseCodexLines([meta, userMsg, asstMsg].join('\n')));
  } finally {
    resetCodexParseCache();
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('codexRolloutMtime reports the newest exact-id rollout mtime, the inventory number', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mtime-test-'));
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = root;
  try {
    const sessionId = '22222222-2222-2222-2222-222222222222';
    const older = join(root, 'sessions', '2026', '10', '06');
    const newer = join(root, 'sessions', '2026', '10', '07');
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    const a = join(older, `rollout-2026-10-06T10-00-00-${sessionId}.jsonl`);
    const b = join(newer, `rollout-2026-10-07T10-00-00-${sessionId}.jsonl`);
    const other = join(newer, 'rollout-2026-10-07T11-00-00-33333333-3333-3333-3333-333333333333.jsonl');
    await writeFile(a, `${meta}\n`);
    await writeFile(b, `${meta}\n`);
    await writeFile(other, `${meta}\n`);
    const { utimes, stat } = await import('node:fs/promises');
    await utimes(a, 1_000, 1_000);
    await utimes(b, 2_000, 2_000);
    await utimes(other, 3_000, 3_000);
    assert.equal(await codexRolloutMtime(sessionId), (await stat(b)).mtimeMs);
    assert.equal(await codexRolloutMtime('44444444-4444-4444-4444-444444444444'), undefined);
    // Second call answers from the remembered file: a later write shows.
    await utimes(b, 5_000, 5_000);
    assert.equal(await codexRolloutMtime(sessionId), (await stat(b)).mtimeMs);
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// --- Codex Desktop (ChatGPT app) rollouts, buildbox-pc 08.10.2026 -----------

const desktopMsg = (role: string, text: string, kinds: string[]) =>
  JSON.stringify({
    timestamp: '2026-10-01T07:43:30.060Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: 't1', content_item_kinds: kinds },
    },
  });
const openPage = desktopMsg(
  'user',
  '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
  ['additional_content.codex_apps_open_page'],
);
const desktopPrompt = desktopMsg('user', 'собери виртуалку под кабинеты', ['user.text']);
const settingsApplied = (ts: string) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'x' } });
const taskComplete = (ts: string) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete' } });

test('the app-injected open page is neither the title nor a user bubble', () => {
  const summary = parseCodexRolloutHead([meta, openPage, desktopPrompt].join('\n'), 1);
  assert.equal(summary?.title, 'собери виртуалку под кабинеты');
  const messages = parseCodexLines([meta, openPage, desktopPrompt].join('\n'));
  assert.deepEqual(messages.map((m) => m.blocks), [[{ kind: 'text', text: 'собери виртуалку под кабинеты' }]]);
  // An unseen wrapper is caught by its metadata alone.
  const unknown = desktopMsg('user', 'some new context', ['additional_content.codex_apps_whatever']);
  assert.equal(parseCodexRecord(JSON.parse(unknown), unknown), null);
});

test('app opens appending settings do not count as activity', () => {
  const mtime = Date.parse('2026-10-08T10:28:34.500Z');
  const done = Date.parse('2026-10-04T12:53:27.239Z');
  const tail = [taskComplete('2026-10-04T12:53:27.239Z'), settingsApplied('2026-10-05T11:20:13Z'), settingsApplied('2026-10-08T10:28:34Z')];
  assert.equal(codexActivityFromTail(tail.join('\n') + '\n', mtime), done);
  // An ordinary session keeps its mtime exactly — the replica compares it.
  assert.equal(codexActivityFromTail(tail.slice(0, 1).join('\n') + '\n', mtime), mtime);
  // A record mid-write is activity.
  assert.equal(codexActivityFromTail(`${tail[0]}\n${tail[1]}\n{"timestamp":"2026`, mtime), mtime);
  // Only settings in the window: read further.
  assert.equal(codexActivityFromTail(tail.slice(1).join('\n'), mtime), undefined);
});

test('inventory and turn-end report the last real activity, not the app open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-activity-test-'));
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = root;
  try {
    const sessionId = '55555555-5555-5555-5555-555555555555';
    const dir = join(root, 'sessions', '2026', '10', '01');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-01T10-42-18-${sessionId}.jsonl`);
    const sessionMeta = JSON.stringify({ timestamp: '2026-10-01T07:43:27Z', type: 'session_meta', payload: { id: sessionId, cwd: 'D:\\winvps' } });
    // Pad past the first tail step so the second one has to find the turn.
    const pad = Array.from({ length: 6 }, () => settingsApplied('2026-10-08T10:28:34Z').replace('"x"', `"${'p'.repeat(2000)}"`));
    await writeFile(file, [sessionMeta, openPage, desktopPrompt, taskComplete('2026-10-04T12:53:27.239Z'), ...pad].join('\n') + '\n');
    const [summary] = await scanCodexSessions();
    assert.equal(summary?.title, 'собери виртуалку под кабинеты');
    assert.equal(summary?.lastModified, Date.parse('2026-10-04T12:53:27.239Z'));
    assert.equal(await codexRolloutMtime(sessionId), summary?.lastModified);
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
