import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolishRequest, type HistoryMessage } from '@cc-remote/shared';
import { dictationVisible, polishContext, recentForPolish, swapDictation, transcribeHints } from '../src/polish.js';

const msg = (type: HistoryMessage['type'], text: string, uuid = Math.random().toString(36)): HistoryMessage => ({
  type,
  uuid,
  blocks: [{ kind: 'text', text }],
});

test('the recent context is the end of the conversation, oldest first, tool noise out', () => {
  const history: HistoryMessage[] = [
    ...Array.from({ length: 10 }, (_, i) => msg('user', `старое ${i}`)),
    msg('assistant', 'Поправил `useRecorder` в web/src/useRecorder.ts'),
    { type: 'user', uuid: 't', blocks: [{ kind: 'tool_result', toolUseId: 'x', text: 'ok' } as never] },
    msg('system', 'compact'),
    msg('user', 'а теперь хаб'),
  ];
  const recent = recentForPolish(history)!;
  const lines = recent.split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines.at(-1), 'user: а теперь хаб');
  assert.equal(lines.at(-2), 'assistant: Поправил `useRecorder` в web/src/useRecorder.ts');
  assert.ok(!recent.includes('compact'));
  assert.ok(!recent.includes('старое 5'));
});

test('a very long turn keeps its end', () => {
  const recent = recentForPolish([msg('assistant', `${'а'.repeat(5000)} ИТОГ`)])!;
  assert.ok(recent.endsWith('ИТОГ'));
  assert.ok(recent.length < 1300);
});

test('the context omits empty fields and passes the shared schema', () => {
  const ctx = polishContext({ project: 'remotehegai', title: '  ', history: [] });
  assert.deepEqual(ctx, { project: 'remotehegai' });
  assert.ok(PolishRequest.safeParse({ text: 'ок', ...ctx }).success);
  const full = polishContext({ project: 'p', title: 't', history: [msg('user', 'x'.repeat(20_000))] });
  assert.ok(PolishRequest.safeParse({ text: 'ок', ...full }).success);
});

test('«как сказал» swaps the last copy and back again', () => {
  const pair = { raw: 'юз рекордер', polished: '`useRecorder`', showing: 'polished' as const };
  const one = swapDictation('до `useRecorder` и `useRecorder`', pair)!;
  assert.equal(one.draft, 'до `useRecorder` и юз рекордер');
  assert.equal(one.pair.showing, 'raw');
  const back = swapDictation(one.draft, one.pair)!;
  assert.equal(back.draft, 'до `useRecorder` и `useRecorder`');
  assert.equal(back.pair.showing, 'polished');
});

test('the switch goes away once its text has left the box', () => {
  const pair = { raw: 'ок', polished: 'Ок.', showing: 'polished' as const };
  assert.equal(dictationVisible('', pair), false);
  assert.equal(swapDictation('другое', pair), null);
  assert.equal(dictationVisible('Ок. и ещё', pair), true);
  assert.equal(dictationVisible('Ок.', null), false);
});

test('a cut through an emoji leaves no lone surrogate for serde to refuse', () => {
  // 1199 units then an emoji: the 1200-unit tail starts on its low half.
  const text = `😀${'б'.repeat(1199)}`;
  const recent = recentForPolish([msg('assistant', text)])!;
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(recent)));
  assert.ok(!/[\uD800-\uDFFF]/.test(recent.replace(/😀/g, '')));
  const ctx = polishContext({ title: `${'а'.repeat(199)}😀` });
  assert.ok(!/[\uD800-\uDBFF]$/.test(ctx.title!));
});

import { polishDictationText, transcribeProject, type DictationPolisher } from '../src/polish.js';

test('send-now polishes with the safe flag; the normal stop does not', async () => {
  const seen: boolean[] = [];
  const clean: DictationPolisher = async (t, safe) => {
    seen.push(safe);
    return { kind: 'ok', text: `${t}.` };
  };
  const a = await polishDictationText('привет', clean, true);
  assert.deepEqual(a, { text: 'привет.', raw: 'привет', failed: false });
  await polishDictationText('привет', clean, false);
  assert.deepEqual(seen, [true, false]);
});

test('failure is flagged, off and unchanged are not', async () => {
  assert.equal((await polishDictationText('т', async () => ({ kind: 'failed' }), false)).failed, true);
  assert.equal((await polishDictationText('т', async () => { throw new Error('x'); }, true)).failed, true);
  assert.equal((await polishDictationText('т', async () => ({ kind: 'off' }), false)).failed, false);
  const same = await polishDictationText('т', async () => ({ kind: 'ok', text: 'т' }), false);
  assert.deepEqual(same, { text: 'т', failed: false });
});

test('the transcribe project label is capped at 80', () => {
  assert.equal(transcribeProject('  ' + 'x'.repeat(100))!.length, 80);
  assert.equal(transcribeProject('  '), undefined);
});

test('hints keep identifiers and file names, drop URLs, hashes and stopwords', () => {
  const hints = transcribeHints([
    msg('assistant', 'Поправил useRecorder в web/src/useRecorder.ts, see https://example.com/Foo/barBaz and commit deadbeef12 with the fix.'),
  ])!;
  const terms = hints.split(', ');
  assert.ok(terms.includes('useRecorder'));
  assert.ok(terms.includes('web/src/useRecorder.ts'));
  assert.ok(!terms.some((t) => /example|barBaz/.test(t)));
  assert.ok(!terms.includes('deadbeef12'));
  assert.ok(!terms.includes('the') && !terms.includes('with'));
});

test('hints keep a Russian name mid-sentence and drop sentence-initial words', () => {
  const hints = transcribeHints([msg('user', 'Привет. Сегодня позвони Владельцу и Марату.\nДеплой готов, спроси у Сергея')])!;
  const terms = hints.split(', ');
  assert.ok(terms.includes('Владельцу'));
  assert.ok(terms.includes('Марату'));
  assert.ok(terms.includes('Сергея'));
  assert.ok(!terms.includes('Привет'));
  assert.ok(!terms.includes('Сегодня'));
  assert.ok(!terms.includes('Деплой'));
});

test('hints rank by frequency and identifier-likeness, dedupe case-insensitively', () => {
  const hints = transcribeHints([
    msg('user', 'build build build Build hub useHub'),
    msg('assistant', 'plain'),
  ])!;
  const terms = hints.split(', ');
  assert.equal(terms.filter((t) => t.toLowerCase() === 'build').length, 1);
  assert.equal(terms[0]!.toLowerCase(), 'build');
  // identifier-like (+1) beats an equally frequent plain word
  assert.ok(terms.indexOf('useHub') < terms.indexOf('hub'));
});

test('hints are capped at 300 chars on a term boundary, 20 terms, and ignore system/tool turns', () => {
  const many = Array.from({ length: 60 }, (_, i) => `identifier_number_${String(i).padStart(2, '0')}_x`).join(' ');
  const hints = transcribeHints([msg('system', 'systemOnlyTerm'), msg('user', many)])!;
  assert.ok(hints.length <= 300);
  assert.ok(hints.split(', ').length <= 20);
  assert.ok(hints.split(', ').every((t) => t.startsWith('identifier_number_')));
  assert.ok(!hints.includes('systemOnlyTerm'));
  assert.equal(transcribeHints([]), undefined);
  assert.equal(transcribeHints([msg('user', 'да нет и ок 123 the and')]), undefined);
});
