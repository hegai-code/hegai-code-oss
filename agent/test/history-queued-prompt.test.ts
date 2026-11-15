import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A message sent while the turn runs is written by the CLI as an `attachment`
 * of type `queued_command`, not as a `user` record (seen on stage 10.10.2026,
 * CLI 2.1.296). History must still carry it — with its picture — at the point
 * it was SENT, or every client disagrees with its own live copy of the turn.
 */

const HOME = await mkdtemp(join(tmpdir(), 'queued-prompt-home-'));
process.env['HOME'] = HOME;
const { loadHistory, loadImage, readClaudeHistory } = await import('../src/history.js');

const SESSION = '11111111-2222-4333-8444-555555555555';
const CWD = '/tmp/queued-prompt-proj';
const PNG = 'iVBORw0KGgo=';

function rows(abandoned = false): unknown[] {
  const base = { isSidechain: false, sessionId: SESSION, cwd: CWD, userType: 'external', version: '2.1.296' };
  const at = (s: number) => new Date(Date.UTC(2026, 9, 10, 8, 37, s)).toISOString();
  return [
    { ...base, parentUuid: null, type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'Почему такое название модели?' } },
    { ...base, parentUuid: 'u1', type: 'assistant', uuid: 'a1', timestamp: at(5), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    // Prose streamed AFTER the person pressed send (at 9 s), BEFORE the CLI absorbed it.
    { ...base, parentUuid: 'a1', type: 'assistant', uuid: 'a2', timestamp: at(10), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Смотрю код.' }] } },
    { ...base, parentUuid: 'a2', type: 'assistant', uuid: 'a3', timestamp: at(11), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pwd' } }] } },
    { ...base, parentUuid: 'a3', type: 'user', uuid: 'r2', timestamp: at(12), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '/tmp' }] } },
    { ...base, parentUuid: 'r2', type: 'attachment', uuid: 'q1', timestamp: at(9), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: 'И картинка не подтягивается' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } }] } },
    { ...base, parentUuid: 'q1', type: 'attachment', uuid: 'q2', timestamp: at(12), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } },
    { ...base, parentUuid: 'q2', type: 'attachment', uuid: 'tn', timestamp: at(12), attachment: { type: 'queued_command', commandMode: 'task-notification', origin: { kind: 'task-notification' }, prompt: '<task-notification><task-id>x</task-id></task-notification>' } },
    // A prompt queued on a branch the person later rewound away from.
    ...(abandoned ? [{ ...base, parentUuid: 'a1', type: 'attachment', uuid: 'qx', timestamp: at(13), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'с брошенной ветки' } }] : []),
    { ...base, parentUuid: 'tn', type: 'assistant', uuid: 'a4', timestamp: at(20), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Веб это уже умеет.' }] } },
  ];
}

async function withTranscript(fn: (file: string) => Promise<void>, abandoned = false): Promise<void> {
  const dir = join(HOME, '.claude', 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${SESSION}.jsonl`);
  await writeFile(file, rows(abandoned).map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    await fn(file);
  } finally {
    await rm(join(HOME, '.claude'), { recursive: true, force: true });
  }
}

const EXPECTED = ['u1', 'a1', 'q1', 'a2', 'a3', 'r2', 'q2', 'a4'];

test('the SDK path keeps mid-turn prompts, at send time, without task notifications', async () => {
  await withTranscript(async () => {
    const history = await loadHistory(SESSION, CWD);
    assert.deepEqual(history.map((m) => m.uuid), EXPECTED);
    const q1 = history.find((m) => m.uuid === 'q1')!;
    assert.equal(q1.type, 'user');
    assert.deepEqual(q1.blocks, [{ kind: 'text', text: 'И картинка не подтягивается' }, { kind: 'image', ref: 'q1#1' }]);
    assert.deepEqual(history.find((m) => m.uuid === 'q2')!.blocks, [{ kind: 'image', ref: 'q2#0' }]);
  });
});

test('the streaming path for large transcripts agrees with the SDK path', async () => {
  await withTranscript(async (file) => {
    assert.deepEqual((await readClaudeHistory(file, 1000)).map((m) => m.uuid), EXPECTED);
  });
});

test('a picture sent mid-turn loads by its ref', async () => {
  await withTranscript(async () => {
    assert.deepEqual(await loadImage(SESSION, 'q1#1'), { mediaType: 'image/jpeg', dataB64: PNG });
    assert.deepEqual(await loadImage(SESSION, 'q2#0'), { mediaType: 'image/png', dataB64: PNG });
    assert.equal(await loadImage(SESSION, 'q1#0'), null, 'a text block is not a picture');
  });
});

test('a queued prompt on an abandoned branch stays out, as the SDK leaves that branch out', async () => {
  await withTranscript(async (file) => {
    assert.deepEqual((await loadHistory(SESSION, CWD)).map((m) => m.uuid), EXPECTED);
    assert.deepEqual((await readClaudeHistory(file, 1000)).map((m) => m.uuid), EXPECTED);
    assert.deepEqual((await readClaudeHistory(file, 2)).map((m) => m.uuid), EXPECTED.slice(-2), 'the dead prompt evicts nothing');
  }, true);
});

test('a background agent\'s task-notification survives into history on its call\'s result', async () => {
  const { taskNoticesOf, attachTaskNotices } = await import('../src/history.js');
  const { parseTaskNotification } = await import('@cc-remote/shared');
  const raw = {
    type: 'user',
    message: { content: '<task-notification>\n<task-id>t</task-id>\n<tool-use-id>toolu_B</tool-use-id>\n<status>stopped</status>\n<summary>Agent "x" was stopped</summary>\n<result>Успел прогнать половину.</result>\n</task-notification>' },
  };
  const messages = [
    { type: 'assistant' as const, uuid: 'a', blocks: [{ kind: 'tool_use' as const, id: 'toolu_B', name: 'Agent', input: { description: 'x' } }] },
    { type: 'user' as const, uuid: 'r', blocks: [{ kind: 'tool_result' as const, toolUseId: 'toolu_B', text: 'Async agent launched successfully.' }] },
  ];
  attachTaskNotices(messages, taskNoticesOf(raw));
  const kept = messages[1]!.blocks[1];
  const n = kept?.kind === 'text' ? parseTaskNotification(kept.text) : null;
  assert.equal(n?.toolUseId, 'toolu_B');
  assert.equal(n?.status, 'stopped');
  assert.equal(n?.summary, 'Успел прогнать половину.');
  assert.equal(messages[1]!.blocks.length, 2, 'no new message — a text block on the result');
});

test('history keeps the FIRST ending and reads a notice folded in mid-turn', async () => {
  const { taskNoticesOf, attachTaskNotices } = await import('../src/history.js');
  const { parseTaskNotification } = await import('@cc-remote/shared');
  const note = (status: string, result: string) =>
    `<task-notification><tool-use-id>toolu_C</tool-use-id><status>${status}</status><result>${result}</result></task-notification>`;
  const mid = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: note('stopped', 'Остановлен на середине.') } };
  const late = { type: 'user', message: { content: note('completed', 'Готово.') } };
  const messages = [
    { type: 'user' as const, uuid: 'r', blocks: [{ kind: 'tool_result' as const, toolUseId: 'toolu_C', text: 'Async agent launched successfully.' }] },
  ];
  attachTaskNotices(messages, [...taskNoticesOf(mid), ...taskNoticesOf(late)]);
  attachTaskNotices(messages, taskNoticesOf(late)); // a second pass adds nothing
  assert.equal(messages[0]!.blocks.length, 2);
  const kept = messages[0]!.blocks[1];
  const n = kept?.kind === 'text' ? parseTaskNotification(kept.text) : null;
  assert.equal(n?.status, 'stopped');
  assert.equal(n?.summary, 'Остановлен на середине.');
});

test('a helper started by a skill is found by its task id, and the id cannot climb out', async () => {
  const { loadSubagentHistory } = await import('../src/history.js');
  // No such session: nothing, whatever the id — and never a path outside.
  assert.deepEqual(await loadSubagentHistory('no-such-session', undefined, 10, undefined, '../../etc'), []);
});

test('the SDK copy of a mid-turn prompt is set aside, the attachment path owns it', async () => {
  const { splitSdkQueuedCopies } = await import('../src/history.js');
  const kept = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Да' } };
  const copy = { type: 'user', uuid: 'src-1', isQueuedCommand: true, message: { role: 'user', content: 'И проверь' } };
  assert.deepEqual(splitSdkQueuedCopies([kept, copy]), { rest: [kept], copies: [copy] });
});
