import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A big Claude transcript is parsed once and then only extended
 * (`readClaudeTranscript`). Whatever the file looks like after any number of
 * appends, the result must be what a one-shot `readClaudeHistory` returns for
 * the same bytes — the replica's append check hashes these messages.
 */

const HOME = await mkdtemp(join(tmpdir(), 'claude-incremental-home-'));
process.env['HOME'] = HOME;
const { loadHistory, readClaudeHistory, readClaudeTranscript, resetClaudeParseCache, attachTaskNotices, taskNoticesOf, TranscriptTooLargeError } =
  await import('../src/history.js');

const PROJECT = join(HOME, '.claude', 'projects', '-tmp-incremental');
const CWD = '/tmp/incremental';
let counter = 0;

const at = (s: number) => new Date(Date.UTC(2026, 9, 14, 12, 0, s)).toISOString();
const row = (r: Record<string, unknown>) => JSON.stringify({ isSidechain: false, sessionId: 's', cwd: CWD, ...r });
const user = (uuid: string, parent: string | null, s: number, content: unknown) =>
  row({ type: 'user', uuid, parentUuid: parent, timestamp: at(s), message: { role: 'user', content } });
const assistant = (uuid: string, parent: string, s: number, content: unknown) =>
  row({ type: 'assistant', uuid, parentUuid: parent, timestamp: at(s), message: { role: 'assistant', model: 'claude-opus-5-5', content } });
const queued = (uuid: string, parent: string, s: number, prompt: string) =>
  row({ type: 'attachment', uuid, parentUuid: parent, timestamp: at(s), attachment: { type: 'queued_command', commandMode: 'prompt', prompt } });
// Over STREAM/INCREMENTAL_MIN_BYTES by itself, so the parse is kept between reads.
const huge = (uuid: string, parent: string) =>
  user(uuid, parent, 3, [{ type: 'tool_result', tool_use_id: 'tbig', content: 'x'.repeat(5 * 1024 * 1024) }]);
const note = (callId: string, status: string, result: string) =>
  `<task-notification><tool-use-id>${callId}</tool-use-id><status>${status}</status><result>${result}</result></task-notification>`;

async function withSession(fn: (id: string, file: string) => Promise<void>): Promise<void> {
  const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  await mkdir(PROJECT, { recursive: true });
  resetClaudeParseCache();
  try {
    await fn(id, join(PROJECT, `${id}.jsonl`));
  } finally {
    resetClaudeParseCache();
    await rm(PROJECT, { recursive: true, force: true });
  }
}

/** What a one-shot parse of exactly these bytes returns. */
async function oneShot(text: string): Promise<unknown> {
  const file = join(HOME, 'oneshot.jsonl');
  await writeFile(file, text);
  return readClaudeHistory(file, Infinity);
}

async function assertSame(id: string, text: string): Promise<void> {
  assert.deepEqual((await readClaudeTranscript(id))?.messages, await oneShot(text));
}

test('a big transcript extended by appends always equals a one-shot parse', async () => {
  await withSession(async (id, file) => {
    let text = [
      user('u1', null, 0, 'Первый вопрос'),
      assistant('a1', 'u1', 1, [{ type: 'tool_use', id: 'toolu_B', name: 'Agent', input: { description: 'x' } }]),
      user('r1', 'a1', 2, [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'Async agent launched successfully.' }]),
      huge('big', 'r1'),
      assistant('a2', 'big', 10, [{ type: 'text', text: 'Ответ' }]),
    ].join('\n') + '\n';
    await writeFile(file, text);
    await assertSame(id, text);
    assert.equal((await readClaudeTranscript(id))?.size, Buffer.byteLength(text));

    // A queued prompt sent at 5 s, absorbed after the reply written at 10 s.
    const q = queued('q1', 'a2', 5, 'Сообщение посреди хода') + '\n';
    await appendFile(file, q);
    text += q;
    await assertSame(id, text);
    assert.deepEqual((await readClaudeTranscript(id))?.messages.map((m) => m.uuid), ['u1', 'a1', 'r1', 'big', 'q1', 'a2']);

    // A record still being written is not consumed...
    const a3 = assistant('a3', 'q1', 20, [{ type: 'text', text: 'Дописываю' }]);
    await appendFile(file, a3.slice(0, 30));
    await assertSame(id, text + a3.slice(0, 30));
    // ...and arrives exactly once when complete.
    await appendFile(file, a3.slice(30) + '\n');
    text += a3 + '\n';
    await assertSame(id, text);

    // A background helper's ending lands on a result read long ago.
    const notice = user('n1', 'a3', 21, note('toolu_B', 'completed', 'Готово.')) + '\n';
    await appendFile(file, notice);
    text += notice;
    await assertSame(id, text);
    const r1 = (await readClaudeTranscript(id))!.messages.find((m) => m.uuid === 'r1')!;
    assert.equal(r1.blocks.length, 2, 'the notice rides on the call\'s result');

    // A compaction seam, with a sidechain record that must not move the leaf.
    const tail =
      [
        row({ type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'n1', timestamp: at(30), compactMetadata: { trigger: 'auto', preTokens: 100 } }),
        user('s1', 'c1', 31, { type: 'x' } as never),
        row({ type: 'assistant', uuid: 'side', parentUuid: 'a1', isSidechain: true, timestamp: at(32), message: { role: 'assistant', content: [{ type: 'text', text: 'не в основной ветке' }] } }),
        assistant('a4', 'c1', 40, [{ type: 'text', text: 'После сжатия' }]),
      ].join('\n') + '\n';
    await appendFile(file, tail);
    text += tail;
    await assertSame(id, text);
    assert.equal((await readClaudeTranscript(id))?.messages.at(-1)?.uuid, 'a4');
  });
});

test('a transcript rewritten in place or shrunk is parsed afresh', async () => {
  await withSession(async (id, file) => {
    const base = [user('u1', null, 0, 'вопрос'), huge('big', 'u1'), assistant('a1', 'big', 5, [{ type: 'text', text: 'one' }])].join('\n') + '\n';
    await writeFile(file, base);
    await assertSame(id, base);

    const rewritten = base.replace('"one"', '"eno"');
    await writeFile(file, rewritten);
    await assertSame(id, rewritten);

    const longer = rewritten + assistant('a2', 'a1', 6, [{ type: 'text', text: 'two' }]) + '\n';
    await writeFile(file, longer);
    await assertSame(id, longer);

    const shrunk = [user('u9', null, 0, 'другой'), assistant('a9', 'u9', 1, [{ type: 'text', text: 'only' }])].join('\n') + '\n';
    await writeFile(file, shrunk);
    await assertSame(id, shrunk);
  });
});

test('a queued prompt off the active branch is dropped, even when the branch is abandoned only later', async () => {
  await withSession(async (id, file) => {
    let text = [
      user('u1', null, 0, 'вопрос'),
      huge('big', 'u1'),
      assistant('a1', 'big', 5, [{ type: 'text', text: 'ответ' }]),
      queued('q1', 'a1', 6, 'живая'),
      queued('qx', 'a1', 8, 'с брошенной ветки'),
      assistant('a2', 'q1', 7, [{ type: 'text', text: 'дальше' }]),
    ].join('\n') + '\n';
    await writeFile(file, text);
    // qx hangs off a1 while the newest record (a2) continues from q1.
    await assertSame(id, text);
    assert.deepEqual((await readClaudeTranscript(id))?.messages.map((m) => m.uuid), ['u1', 'big', 'a1', 'q1', 'a2']);

    // The person rewinds to the first question: q1 and everything after are now the dead branch.
    const rewind = user('b1', 'u1', 20, 'спрошу иначе') + '\n';
    await appendFile(file, rewind);
    text += rewind;
    await assertSame(id, text);
    assert.deepEqual((await readClaudeTranscript(id))?.messages.map((m) => m.uuid), ['u1', 'big', 'a1', 'a2', 'b1']);
  });
});

test('readers get fresh arrays; trimming and notices never touch what is kept', async () => {
  await withSession(async (id, file) => {
    const text =
      [
        user('u1', null, 0, 'вопрос'),
        assistant('a1', 'u1', 1, [{ type: 'tool_use', id: 'toolu_C', name: 'Agent', input: { description: 'y' } }]),
        user('r1', 'a1', 2, [{ type: 'tool_result', tool_use_id: 'toolu_C', content: 'launched' }]),
        huge('big', 'r1'),
        assistant('a2', 'big', 5, [{ type: 'text', text: 'ответ' }]),
      ].join('\n') + '\n';
    await writeFile(file, text);

    const first = (await readClaudeTranscript(id))!.messages;
    const held = first.find((m) => m.uuid === 'r1')!;
    first.length = 0; // a caller scribbling on its array
    const second = (await readClaudeTranscript(id))!.messages;
    assert.notEqual(first, second);
    assert.equal(second.length, 5);

    // The windowed, trimmed read leaves the kept text whole.
    const trimmed = await loadHistory(id, CWD, 2, 100);
    assert.deepEqual(trimmed.map((m) => m.uuid), ['big', 'a2']);
    const clipped = trimmed[0]!.blocks[0]!;
    assert.ok(clipped.kind === 'tool_result' && clipped.text.length < 200);
    const kept = (await readClaudeTranscript(id))!.messages.find((m) => m.uuid === 'big')!.blocks[0]!;
    assert.ok(kept.kind === 'tool_result' && kept.text.length === 5 * 1024 * 1024);
    assert.deepEqual(await loadHistory(id, CWD, 0), []);

    // A notice that lands later changes a copy: a message already handed out stays as it was.
    const late = user('n1', 'a2', 6, note('toolu_C', 'stopped', 'Остановлен.')) + '\n';
    await appendFile(file, late);
    const after = (await readClaudeTranscript(id))!.messages.find((m) => m.uuid === 'r1')!;
    assert.equal(held.blocks.length, 1);
    assert.equal(after.blocks.length, 2);
  });
});

test('attachTaskNotices replaces a changed message instead of editing it', () => {
  const original = { type: 'user' as const, uuid: 'r', blocks: [{ kind: 'tool_result' as const, toolUseId: 'toolu_D', text: 'launched' }] };
  const messages = [original];
  attachTaskNotices(messages, taskNoticesOf({ type: 'user', message: { content: note('toolu_D', 'completed', 'ok') } }));
  assert.equal(original.blocks.length, 1);
  assert.equal(messages[0]!.blocks.length, 2);
  assert.equal(messages[0]!.uuid, 'r');
});

test('a small transcript is read afresh and a missing one is null', async () => {
  await withSession(async (id, file) => {
    const small = [user('u1', null, 0, 'вопрос'), assistant('a1', 'u1', 1, [{ type: 'text', text: 'ответ' }])].join('\n') + '\n';
    await writeFile(file, small);
    await assertSame(id, small);
    assert.equal(await readClaudeTranscript('99999999-0000-4000-8000-000000000000'), null);
  });
});

test('a transcript whose parse would not fit is refused, windowed reads still answer, a rewrite is read afresh', async () => {
  await withSession(async (id, file) => {
    // 20 × 5 MiB of retained tool output: over the 96 MiB kept-parse cap.
    const lines = [user('u0', null, 1, 'start')];
    for (let i = 1; i <= 20; i++) lines.push(huge(`h${i}`, `${i === 1 ? 'u0' : `h${i - 1}`}`).replace('"tbig"', `"t${i}"`));
    lines.push(assistant('a1', 'h20', 4, [{ type: 'text', text: 'последний ответ' }]));
    await writeFile(file, `${lines.join('\n')}\n`);

    await assert.rejects(readClaudeTranscript(id), TranscriptTooLargeError);
    // Remembered: the second refusal does not parse again, and still refuses.
    await assert.rejects(readClaudeTranscript(id), TranscriptTooLargeError);
    // The replica's whole-history read is told so (and skips) …
    await assert.rejects(loadHistory(id, CWD), TranscriptTooLargeError);
    // … a client's window is answered by the bounded scan.
    const window = await loadHistory(id, CWD, 1);
    assert.equal(window.length, 1);
    assert.deepEqual(window[0]!.blocks, [{ kind: 'text', text: 'последний ответ' }]);

    // Rewritten in place: no longer the file that was too big.
    await writeFile(file, `${huge('s1', 'u0')}\n`);
    assert.equal((await readClaudeTranscript(id))?.messages.length, 1);
  });
});
