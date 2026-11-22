import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HistoryMessage } from '@cc-remote/shared';
import { dropGeneratedShownInHistory, foldImageGen, foldStreamEvent, type TranscriptLine } from '../src/central-reducers.js';
import { dataUrlToBlob, genClock, genFileName, genProgress, hasAssistantReplyAfterLastUser } from '../src/render/imageGen.js';
import { imageCacheKey, peekImage, resolveImage, scopedFetch } from '../src/render/Attachment.js';
import { groupHistory, groupLive, LiveLine } from '../src/render/Blocks.js';

let n = 0;
const nextId = () => ++n;
const gen = (state: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'status', code: 'image_gen', text: state, data: { id: 'ig_1', state, ...extra } }) as never;

test('progress: 0 at the start, monotonic, never reaches 0.92', () => {
  assert.equal(genProgress(0), 0);
  assert.equal(genProgress(-5), 0);
  assert.equal(genProgress(Number.NaN), 0);
  assert.ok(Math.abs(genProgress(28_000) - 0.92 * (1 - Math.exp(-1))) < 1e-9);
  let prev = 0;
  for (let s = 1; s <= 600; s += 7) {
    const p = genProgress(s * 1000);
    assert.ok(p > prev && p < 0.92);
    prev = p;
  }
});

test('clock is m:ss', () => {
  assert.equal(genClock(0), '0:00');
  assert.equal(genClock(12_900), '0:12');
  assert.equal(genClock(61_000), '1:01');
  assert.equal(genClock(-1), '0:00');
});

test('file name comes from the prompt, else image.png', () => {
  assert.equal(genFileName('A red fox, in the snow!'), 'a-red-fox-in-the-snow.png');
  assert.equal(genFileName('Рыжая лиса на снегу'), 'рыжая-лиса-на-снегу.png');
  assert.equal(genFileName('!!!'), 'image.png');
  assert.equal(genFileName(undefined), 'image.png');
  assert.ok(genFileName('x'.repeat(200)).length <= 44);
});

test('dataUrlToBlob refuses active content types (same-origin blob tab)', () => {
  assert.equal(dataUrlToBlob('data:image/svg+xml;base64,PHN2Zy8+'), null);
  assert.equal(dataUrlToBlob('data:text/html;base64,PGI+'), null);
  assert.ok(dataUrlToBlob('data:image/jpeg;base64,AAEC'));
});

test('dataUrlToBlob decodes base64 and refuses junk', () => {
  const b = dataUrlToBlob('data:image/png;base64,AAEC');
  assert.equal(b?.type, 'image/png');
  assert.equal(b?.size, 3);
  assert.equal(dataUrlToBlob('https://x/y.png'), null);
});

test('started → done updates ONE line in place; a replayed started does not regress it', () => {
  let lines: TranscriptLine[] = [];
  lines = foldStreamEvent(lines, gen('started', { prompt: 'fox', startedAt: 1000 }), nextId, () => 5000);
  assert.equal(lines.length, 1);
  const id = lines[0]!.id;
  assert.equal(lines[0]!.data?.['startedAt'], 1000);
  lines = foldStreamEvent(lines, gen('started', { prompt: 'fox', startedAt: 1000 }), nextId); // replay
  assert.equal(lines.length, 1);
  lines = foldStreamEvent(lines, gen('done', { ref: 'gen:ig_1' }), nextId);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.id, id, 'same row id: React keeps the node');
  assert.equal(lines[0]!.data?.['state'], 'done');
  assert.equal(lines[0]!.data?.['ref'], 'gen:ig_1');
  assert.equal(lines[0]!.data?.['prompt'], 'fox', 'prompt from started survives done');
  assert.equal(lines[0]!.data?.['startedAt'], 1000);
  const again = foldStreamEvent(lines, gen('started', { startedAt: 1000 }), nextId);
  assert.equal(again, lines);
  assert.equal(foldStreamEvent(lines, gen('failed', { error: 'x' }), nextId), lines);
});

test('first-seen time is the clock when the event has none; two ids are two lines', () => {
  let lines = foldImageGen([], { id: 'a', state: 'started' }, 't', nextId, () => 777);
  assert.equal(lines[0]!.data?.['startedAt'], 777);
  lines = foldImageGen(lines, { id: 'b', state: 'started' }, 't', nextId, () => 800);
  assert.equal(lines.length, 2);
  // done with no started (evicted from the replay window) opens finished
  lines = foldImageGen(lines, { id: 'c', state: 'done', ref: 'gen:c' }, 't', nextId, () => 900);
  assert.equal(lines.length, 3);
  assert.equal(lines[2]!.data?.['state'], 'done');
});

test('malformed data is dropped, other status lines are untouched', () => {
  assert.deepEqual(foldImageGen([], { state: 'started' }, 't', nextId), []);
  assert.deepEqual(foldImageGen([], undefined, 't', nextId), []);
  const out = foldStreamEvent([], { kind: 'status', code: 'command_output', text: 'ls' } as never, nextId);
  assert.equal(out[0]!.code, 'command_output');
});

test('the card is not folded into the tool-lines group and sits where it happened', () => {
  const tool = (id: number) => ({ id, kind: 'tool_use' as const, text: `Bash ${JSON.stringify({ command: 'hegai-image "fox" out.png' })}` });
  const card = foldImageGen([], { id: 'ig_1', state: 'started', startedAt: 1 }, '🎨 Рисую картинку…', nextId)[0]!;
  const items = groupLive([
    { id: 1, kind: 'assistant', text: 'Рисую.', ts: 1 },
    tool(2),
    card,
    tool(3),
    { id: 4, kind: 'assistant', text: 'Готово.', ts: 2 },
  ]);
  const cardAt = items.findIndex((it) => it.kind === 'line' && it.line.code === 'image_gen');
  assert.ok(cardAt >= 0, 'a line of its own, not inside a run');
  assert.ok(items.every((it) => it.kind !== 'run' || it.lines.every((l) => l.code !== 'image_gen')));
  const html = renderToStaticMarkup(createElement(LiveLine, { line: card }));
  assert.match(html, /Рисую картинку/);
  assert.match(html, /role="progressbar"/);
  const done = { ...card, data: { ...card.data, state: 'done', ref: 'gen:ig_1' } };
  assert.doesNotMatch(renderToStaticMarkup(createElement(LiveLine, { line: done })), /progressbar/);
  const failed = { ...card, data: { id: 'ig_1', state: 'failed', error: 'модерация' } };
  assert.match(renderToStaticMarkup(createElement(LiveLine, { line: failed })), /Не удалось нарисовать/);
});

test('a Bash hegai-image call and a Codex shell line still fold as tool lines', () => {
  const items = groupLive([
    { id: 1, kind: 'tool_use', text: `Bash ${JSON.stringify({ command: 'hegai-image "fox" out.png' })}` },
    { id: 2, kind: 'tool_use', text: '$ hegai-image "fox" out.png' },
    { id: 3, kind: 'status', code: 'command_output', text: 'out.png 1122x1402 1834 KB 47s' },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, 'run');
});

test('history: a generated image is its own assistant turn, not folded into the run', () => {
  const hist: HistoryMessage[] = [
    { type: 'assistant', uuid: 'a1', ts: 1, blocks: [{ kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'hegai-image "fox" o.png' } }] },
    { type: 'user', uuid: 'u1', ts: 2, blocks: [{ kind: 'tool_result', toolUseId: 't1', text: 'o.png 1x1 1 KB 1s', isError: false }] },
    { type: 'assistant', uuid: 'a2', ts: 3, blocks: [{ kind: 'image', ref: 'gen:t1#0', generated: true, prompt: 'fox' }] },
  ] as never;
  const items = groupHistory(hist);
  const msg = items.find((it) => it.kind === 'msg');
  assert.ok(msg && msg.kind === 'msg');
  assert.equal(msg.msg.blocks[0]!.kind, 'image');
  const run = items.find((it) => it.kind === 'run');
  assert.ok(run && run.kind === 'run');
  assert.ok(run.blocks.every((b) => b.kind !== 'image'));
});

test('a live card is dropped once the history carries the same ref', () => {
  const card = foldImageGen([], { id: 'ig_1', state: 'done', ref: 'gen:ig_1' }, 't', nextId);
  const hist = [{ type: 'assistant', uuid: 'a', blocks: [{ kind: 'image', ref: 'gen:ig_1', generated: true }] }] as never as HistoryMessage[];
  assert.deepEqual(dropGeneratedShownInHistory(card, hist), []);
  assert.equal(dropGeneratedShownInHistory(card, []), card);
  const other = [{ type: 'assistant', uuid: 'a', blocks: [{ kind: 'image', ref: 'gen:zzz', generated: true }] }] as never as HistoryMessage[];
  assert.equal(dropGeneratedShownInHistory(card, other), card);
  // a missed `done` (reconnect) must not leave a crawling bar beside the picture
  const started = foldImageGen([], { id: 'ig_1', state: 'started' }, 't', nextId);
  assert.deepEqual(dropGeneratedShownInHistory(started, hist), []);
  const claude = foldImageGen([], { id: 'toolu_1#0', state: 'started' }, 't', nextId);
  const claudeHist = [{ type: 'assistant', uuid: 'b', blocks: [{ kind: 'image', ref: 'gen:toolu_1#0', generated: true }] }] as never as HistoryMessage[];
  assert.deepEqual(dropGeneratedShownInHistory(claude, claudeHist), []);
});

test('caughtUp: a synthetic generated-image-only assistant message is not the turn reply', () => {
  const user = { type: 'user', uuid: 'u', blocks: [{ kind: 'text', text: 'draw' }] };
  const tool = { type: 'assistant', uuid: 'a1', blocks: [{ kind: 'tool_use', id: 't', name: 'Bash', input: {} }] };
  const pics = { type: 'assistant', uuid: 'a1:gen', blocks: [{ kind: 'image', ref: 'gen:t#0', generated: true }] };
  const text = { type: 'assistant', uuid: 'a2', blocks: [{ kind: 'text', text: 'done' }] };
  const asH = (m: unknown[]) => m as never as HistoryMessage[];
  assert.equal(hasAssistantReplyAfterLastUser(asH([user, pics])), false);
  assert.equal(hasAssistantReplyAfterLastUser(asH([user, { type: 'user', uuid: 'r', blocks: [] }, pics])), false);
  assert.equal(hasAssistantReplyAfterLastUser(asH([user, tool, pics])), true, 'the tool_use message is an assistant message');
  assert.equal(hasAssistantReplyAfterLastUser(asH([user, pics, text])), true);
  const mixed = { type: 'assistant', uuid: 'm', blocks: [{ kind: 'image', ref: 'gen:t#0', generated: true }, { kind: 'text', text: 'here' }] };
  assert.equal(hasAssistantReplyAfterLastUser(asH([user, mixed])), true);
  assert.equal(hasAssistantReplyAfterLastUser(asH([user, { type: 'assistant', uuid: 'x', blocks: [{ kind: 'image', ref: 'f' }] }])), true, 'a plain image is a reply');
});

test('image cache: the same ref in two sessions never shares an entry', async () => {
  const calls: string[] = [];
  const fa = scopedFetch(async (ref) => (calls.push(`A:${ref}`), { mediaType: 'image/png', dataB64: 'QUFB' }), 'm1\u0000sA\u0000');
  const fb = scopedFetch(async (ref) => (calls.push(`B:${ref}`), { mediaType: 'image/png', dataB64: 'QkJC' }), 'm1\u0000sB\u0000');
  const a = await resolveImage(fa, 'gen:t#0');
  const b = await resolveImage(fb, 'gen:t#0');
  assert.equal(a, 'data:image/png;base64,QUFB');
  assert.equal(b, 'data:image/png;base64,QkJC');
  assert.deepEqual(calls, ['A:gen:t#0', 'B:gen:t#0']);
  assert.equal(peekImage(fa, 'gen:t#0'), a);
  assert.equal(peekImage(fb, 'gen:t#0'), b);
  // a rebuilt fetcher for the SAME session reuses the entry
  const fa2 = scopedFetch(async () => null, 'm1\u0000sA\u0000');
  assert.equal(await resolveImage(fa2, 'gen:t#0'), a);
  // unscoped fetchers get private namespaces
  const u1 = async () => null;
  const u2 = async () => null;
  assert.notEqual(imageCacheKey(u1 as never, 'r'), imageCacheKey(u2 as never, 'r'));
  assert.equal(peekImage(undefined, 'gen:t#0'), null);
});

test('a mid-turn copy of the transcript does not hold the live answer', async () => {
  const { historyHoldsLiveAnswer } = await import('../src/render/imageGen.js');
  const asH = (m: unknown[]) => m as never as HistoryMessage[];
  const q = { type: 'user', uuid: 'u', blocks: [{ kind: 'text', text: 'какой номер?' }] };
  const use = { type: 'assistant', uuid: 't', blocks: [{ kind: 'tool_use', id: 'x', name: 'Bash', input: {} }] };
  const res = { type: 'user', uuid: 'r', blocks: [{ kind: 'tool_result', toolUseId: 'x', text: 'ok', isError: false }] };
  const final = { type: 'assistant', uuid: 'f', blocks: [{ kind: 'text', text: 'Шли на **+7 991**\n\nжду' }] };
  const live = [
    { kind: 'user', text: 'какой номер?' },
    { kind: 'tool_use', text: 'Bash' },
    { kind: 'assistant', text: 'Шли на **+7 991**\n\nжду' },
  ];
  // the 21.11 case: the hub's copy from the middle of the turn passes the old test…
  assert.equal(hasAssistantReplyAfterLastUser(asH([q, use, res, use])), true);
  // …and is refused by this one
  assert.equal(historyHoldsLiveAnswer(asH([q, use, res, use]), live), false);
  assert.equal(historyHoldsLiveAnswer(asH([q, use, res, use, res, final]), live), true);
  // the same words in an EARLIER turn are not this turn's answer
  assert.equal(historyHoldsLiveAnswer(asH([q, final, q, use, res, use]), live), false);
  // a line frozen mid-stream is not the answer — keep it (the safe side)
  assert.equal(historyHoldsLiveAnswer(asH([q, use, res, final]), [{ kind: 'assistant', text: 'Шли на **+7' }]), false);
  // whitespace differences do not matter
  assert.equal(historyHoldsLiveAnswer(asH([q, use, res, final]), [{ kind: 'assistant', text: '  Шли на **+7 991** жду\n' }]), true);
  // a short live answer inside a longer mid-turn message is not that answer
  const midway = { type: 'assistant', uuid: 'm', blocks: [{ kind: 'text', text: 'Готово. Теперь гоняю тесты' }] };
  assert.equal(historyHoldsLiveAnswer(asH([q, midway, use]), [{ kind: 'assistant', text: 'Готово.' }]), false);
  // two messages of one turn opening alike: only the full answer counts
  const head = 'x'.repeat(200);
  const early = { type: 'assistant', uuid: 'e', blocks: [{ kind: 'text', text: head + ' промежуточно' }] };
  assert.equal(historyHoldsLiveAnswer(asH([q, early, use]), [{ kind: 'assistant', text: head + ' итог' }]), false);
  // a picture-only question bounds the turn too
  const pic = { type: 'user', uuid: 'p', blocks: [{ kind: 'image', ref: 'p#0' }] };
  assert.equal(historyHoldsLiveAnswer(asH([q, final, pic, use]), live), false);
  // nothing said live — nothing to check
  assert.equal(historyHoldsLiveAnswer(asH([q, use]), [{ kind: 'user', text: 'q' }, { kind: 'tool_use', text: 'Bash' }]), true);
  assert.equal(historyHoldsLiveAnswer(asH([q, use]), []), true);
});
