import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryMessage } from '@cc-remote/shared';
import type { TranscriptLine } from '../src/central-reducers.js';
import { buildTurnDigest, describeCall, heuristicEnrichment, mergeEnrichment, textKey } from '../src/render/enrich.js';

/**
 * The heuristic layer runs on every tail turn with no model behind it, so a
 * wrong guess here is a wrong BUTTON on the screen — the table below pins both
 * what it offers and, just as deliberately, what it refuses to guess.
 */

const labels = (text: string) => heuristicEnrichment(text)?.quickReplies?.map((r) => r.label);

test('a closing yes/no question earns [Да]/[Нет]', () => {
  assert.deepEqual(labels('Изменение в одном файле, восемь строк. Раскатывать?'), ['Да', 'Нет']);
});

test('«X или Y?» and a menu above the question get NO guessed buttons — only Да/Нет, label === send', () => {
  // These used to split into clipped labels that sent a whole sentence; a
  // button must send exactly what it shows.
  const or = heuristicEnrichment('Готово. Делаем сейчас или после ревью?')?.quickReplies;
  assert.deepEqual(or, [
    { label: 'Да', send: 'Да' },
    { label: 'Нет', send: 'Нет' },
  ]);
  const text = ['Варианты:', '1) Только веб', '2) Веб и хаб', '3) Отложить', 'Берём?'].join('\n');
  assert.deepEqual(heuristicEnrichment(text)?.quickReplies, or);
  // …and an open question over a list still gets nothing.
  assert.equal(heuristicEnrichment(['1) Только веб', '2) Веб и хаб', 'Какой берём?'].join('\n')), null);
});

test('an open question gets NO buttons — better none than wrong ones', () => {
  assert.equal(heuristicEnrichment('Починил. Какой порог тишины поставить?'), null);
});

test('a question the agent already moved past does not qualify', () => {
  assert.equal(heuristicEnrichment('Раскатывать? Пока проверяю тесты.\nТесты зелёные.'), null);
});

test('a paragraph-long "question" is prose, not a prompt', () => {
  const long = `Может быть, стоит ${'очень '.repeat(40)}подумать?`;
  assert.equal(heuristicEnrichment(long), null);
});

test('markdown emphasis does not hide the question mark', () => {
  assert.deepEqual(labels('Готово. **Раскатывать?**'), ['Да', 'Нет']);
});

test('merge: the model wins where it spoke, heuristics survive where it did not', () => {
  const heuristic = { quickReplies: [{ label: 'Да', send: 'Да' }] };
  const llm = {
    quickReplies: [
      { label: 'Да, раскатывай', send: 'Да, раскатывай', kind: 'answer' as const },
      { label: 'Проверить хвост в стриминге', send: 'Проверь хвост в стриминге', kind: 'idea' as const },
    ],
  };
  const merged = mergeEnrichment(heuristic, llm);
  assert.equal(merged?.quickReplies?.[0]?.label, 'Да, раскатывай');
  // The model's whole set replaces the heuristic one — including the kinds the
  // heuristics cannot produce at all.
  assert.equal(merged?.quickReplies?.[1]?.kind, 'idea');

  // A model that answered with nothing MEANT nothing: it read the whole turn
  // and judged it a stop on the way, or not worth a tap. Да/Нет does not come
  // back over that verdict.
  assert.equal(mergeEnrichment(heuristic, {}), null);

  // No model answer at all (no gateway, a failed call) — the heuristic stands.
  assert.equal(mergeEnrichment(heuristic, null)?.quickReplies?.[0]?.label, 'Да');

  // Nothing from either layer collapses to null, not to an empty strip.
  assert.equal(mergeEnrichment(null, {}), null);
});

// ---- the digest ------------------------------------------------------------

const msg = (type: 'user' | 'assistant', uuid: string, blocks: HistoryMessage['blocks']): HistoryMessage =>
  ({ type, uuid, blocks }) as HistoryMessage;

test('the digest says what the turn DID, and leaves the final message out', () => {
  const history: HistoryMessage[] = [
    msg('user', 'u0', [{ kind: 'text', text: 'Почини уведомления' }]),
    msg('assistant', 'a0', [{ kind: 'text', text: 'Починил тост и пуш.' }]),
    msg('user', 'u1', [{ kind: 'text', text: 'Раскатай и проверь на бою' }]),
    msg('assistant', 'a1', [
      { kind: 'text', text: 'Раскатываю.' },
      { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push origin main' } },
      { kind: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ssh hub-main-box deploy-hub.sh' } },
    ]),
    msg('user', 'r1', [{ kind: 'tool_result', toolUseId: 't2', text: 'deploy failed: lock held', isError: true }]),
    // A background-task notification is a USER row of pure machinery.
    msg('user', 'n1', [{ kind: 'text', text: '<task-notification>done</task-notification>' }]),
    msg('assistant', 'a2', [{ kind: 'text', text: 'Деплой упал на локе. Повторить?' }]),
  ];
  const d = buildTurnDigest(history, [], { cwd: '/srv/main-source' })!;
  assert.match(d, /PROJECT: \/srv\/main-source/);
  assert.match(d, /USER TURN[^\n]*\nРаскатай и проверь на бою/, 'the ask is the last thing the PERSON said');
  assert.match(d, /- Bash: git push origin main/);
  assert.match(d, /✗ ERROR: deploy failed: lock held/);
  assert.match(d, /EARLIER IN THE SESSION:\nUSER: Почини уведомления\nASSISTANT \(last words\): Починил тост и пуш\./);
  assert.ok(!d.includes('Повторить?'), 'the final message travels as `text`, not twice');
  assert.ok(!d.includes('task-notification'));
});

test('live lines ahead of the file count as the turn, with repeats folded', () => {
  const history: HistoryMessage[] = [msg('user', 'u1', [{ kind: 'text', text: 'Прочитай логи' }])];
  const live = [
    { id: 1, kind: 'tool_use', text: 'Read {"file_path":"/var/log/a/b/hub.log"}' },
    { id: 2, kind: 'tool_use', text: 'Read {"file_path":"/var/log/a/b/hub.log"}' },
    { id: 3, kind: 'tool_use', text: 'Agent {"description":"scan agents","subagent_type":"Explore","run_in_background":true}' },
    { id: 4, kind: 'assistant', text: 'Запустил агента в фоне, жду результат.' },
  ] as TranscriptLine[];
  const d = buildTurnDigest(history, live)!;
  assert.match(d, /- Read a\/b\/hub\.log ×2/);
  assert.match(d, /Agent\(Explore\): scan agents \[in background\]/, 'a background launch is visible to the model');
  assert.ok(!d.includes('жду результат'));
});

test('describeCall names the thing a call acted on', () => {
  assert.equal(describeCall('$', { command: 'npm test' }), '$ npm test');
  assert.equal(describeCall('Edit', { file_path: '/srv/x/web/src/a.ts' }), 'Edit web/src/a.ts');
  assert.equal(describeCall('Grep', { pattern: 'enrich' }), 'Grep enrich');
});

test('textKey is stable per text and differs across texts', () => {
  assert.equal(textKey('Готово.'), textKey('Готово.'));
  assert.notEqual(textKey('Готово.'), textKey('Готово!'));
});
