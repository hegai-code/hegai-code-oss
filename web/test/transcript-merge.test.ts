import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryMessage } from '@cc-remote/shared';
import { groupHistory, groupLive } from '../src/render/Blocks.js';
import {
  dropEchoedUserLine,
  dropReplayedTurnFromHistory,
  foldStreamEvent,
  foldUserTurn,
  keepUnansweredTail,
} from '../src/central-reducers.js';
import type { TranscriptLine } from '../src/central-reducers.js';

/**
 * Continuation flags: a turn that follows the same speaker on the same day is a
 * CONTINUATION — the UI drops its header and rule and it reads as the next
 * paragraph. These tests pin the grouping rules, because the failure mode is
 * silent: a wrong flag renders as "every turn has a header again" (annoying) or
 * "the speaker changed and nobody was told" (worse).
 */

const DAY1 = Date.UTC(2026, 8, 1, 10, 0);
const DAY2 = Date.UTC(2026, 8, 2, 10, 0);

let n = 0;
const user = (text: string, ts?: number): HistoryMessage => ({
  type: 'user',
  uuid: `u${++n}`,
  blocks: [{ kind: 'text', text }],
  ...(ts !== undefined ? { ts } : {}),
});
const assistant = (text: string, ts?: number): HistoryMessage => ({
  type: 'assistant',
  uuid: `a${++n}`,
  blocks: [{ kind: 'text', text }],
  ...(ts !== undefined ? { ts } : {}),
});
const toolResults = (ts?: number): HistoryMessage => ({
  type: 'user',
  uuid: `t${++n}`,
  blocks: [
    { kind: 'tool_result', toolUseId: 'x1', text: 'ok' },
    { kind: 'tool_result', toolUseId: 'x2', text: 'ok' },
  ],
  ...(ts !== undefined ? { ts } : {}),
});

const conts = (items: ReturnType<typeof groupHistory>) =>
  items.map((it) => (it.kind === 'msg' ? it.cont : 'run'));

test('consecutive assistant turns continue; the first of a speaker does not', () => {
  const items = groupHistory([user('go', DAY1), assistant('a', DAY1), assistant('b', DAY1)]);
  assert.deepEqual(conts(items), [false, false, true]);
});

test('a text→tools→text split folds its run into the announcing prose', () => {
  const msg: HistoryMessage = {
    type: 'assistant',
    uuid: 'split',
    ts: DAY1,
    blocks: [
      { kind: 'text', text: 'before' },
      { kind: 'tool_use', id: 't1', name: 'Read', input: {} },
      { kind: 'tool_use', id: 't2', name: 'Bash', input: {} },
      { kind: 'text', text: 'after' },
    ],
  };
  const items = groupHistory([msg]);
  // The run is not a row of its own any more — it attaches to -p0, the prose
  // that announced it, and -p1 continues as the next paragraph.
  assert.deepEqual(
    items.map((it) => it.kind),
    ['msg', 'msg'],
  );
  assert.deepEqual(conts(items), [false, true]);
  assert.equal(items[0]!.kind === 'msg' && items[0]!.runAfter?.length, 2);
  assert.equal(items[1]!.kind === 'msg' && items[1]!.runBefore, undefined);
});

test('machinery messages between two assistant turns fold onto the earlier one', () => {
  const items = groupHistory([assistant('a', DAY1), toolResults(DAY1), assistant('b', DAY1)]);
  assert.deepEqual(conts(items), [false, true]);
  assert.equal(items[0]!.kind === 'msg' && items[0]!.runAfter?.length, 2);
});

test('a run that OPENS the exchange attaches ahead of the prose that reports it', () => {
  // The turn starts with tools (after a user bubble): the text that follows is
  // their result, so the chip leads that text rather than trailing the bubble.
  const opener: HistoryMessage = {
    type: 'assistant',
    uuid: 'opener',
    ts: DAY1,
    blocks: [
      { kind: 'tool_use', id: 't1', name: 'Read', input: {} },
      { kind: 'tool_use', id: 't2', name: 'Grep', input: {} },
      { kind: 'text', text: 'Нашёл.' },
    ],
  };
  const items = groupHistory([user('найди', DAY1), opener]);
  assert.deepEqual(
    items.map((it) => it.kind),
    ['msg', 'msg'],
  );
  assert.equal(items[1]!.kind === 'msg' && items[1]!.runBefore?.length, 2);
});

test('a run with no assistant prose on either side stays a row of its own', () => {
  const items = groupHistory([user('go', DAY1), toolResults(DAY1)]);
  assert.deepEqual(
    items.map((it) => it.kind),
    ['msg', 'run'],
  );
});

test('a user bubble breaks the chain in both directions', () => {
  const items = groupHistory([assistant('a', DAY1), user('q', DAY1), assistant('b', DAY1)]);
  assert.deepEqual(conts(items), [false, false, false]);
});

test('consecutive user bubbles continue each other too', () => {
  const items = groupHistory([user('one', DAY1), user('two', DAY1)]);
  assert.deepEqual(conts(items), [false, true]);
});

test('a calendar-day boundary breaks the merge — a divider will stand there', () => {
  const items = groupHistory([assistant('a', DAY1), assistant('b', DAY2)]);
  assert.deepEqual(conts(items), [false, false]);
});

test('absent timestamps degrade to speaker-only merging', () => {
  const items = groupHistory([assistant('a', DAY1), assistant('b'), assistant('c', DAY1)]);
  assert.deepEqual(conts(items), [false, true, true]);
});

/* --- повтор штампа -------------------------------------------------------
 *
 * Штамп на каждом ходе отвечает «когда ИМЕННО этот», и это верно ровно до тех
 * пор, пока ответы отличаются. Один ход, разбитый машинерией на несколько
 * кусков, несёт в них ОДИН ts — и печатал одно и то же время подряд столько
 * раз, сколько было кусков. На проде это выглядело как колонка из десяти
 * «19:48» и не отвечало ни на что.
 */

const stamps = (items: ReturnType<typeof groupHistory>) =>
  items.filter((it) => it.kind === 'msg').map((it) => (it.kind === 'msg' ? it.showStamp : null));

test('одинаковый штамп подряд печатается один раз', () => {
  // У агента — ПОСЛЕДНИЙ в минуте: время стоит под тем, что он сказал последним.
  const items = groupHistory([assistant('a', DAY1), assistant('b', DAY1), assistant('c', DAY1)]);
  assert.deepEqual(stamps(items), [false, false, true]);
});

test('один ход, разбитый машинерией, не штампует каждый свой кусок', () => {
  const split: HistoryMessage = {
    type: 'assistant',
    uuid: 'split-stamp',
    ts: DAY1,
    blocks: [
      { kind: 'text', text: 'Now the contract.' },
      { kind: 'tool_use', id: 't1', name: 'Read', input: {} },
      { kind: 'text', text: 'Контракт собран.' },
      { kind: 'tool_use', id: 't2', name: 'Edit', input: {} },
      { kind: 'text', text: 'Now the adopted store itself:' },
    ],
  };
  assert.deepEqual(stamps(groupHistory([split])), [false, false, true]);
});

test('смена минуты печатает себя сама', () => {
  const later = DAY1 + 60_000;
  const items = groupHistory([assistant('a', DAY1), assistant('b', DAY1), assistant('c', later)]);
  assert.deepEqual(stamps(items), [false, true, true]);
});

test('смена дня печатает себя — stamp пишет её другой строкой', () => {
  assert.deepEqual(stamps(groupHistory([assistant('a', DAY1), assistant('b', DAY2)])), [true, true]);
});

test('новый говорящий штампуется даже в ту же минуту — жёлоб это единица', () => {
  // Метка, имя и время — один блок; молчащее время оставляет штамп предыдущего
  // хода висеть между двумя говорящими и читаться как чужая подпись.
  const items = groupHistory([user('go', DAY1), assistant('a', DAY1)]);
  assert.deepEqual(stamps(items), [true, true]);
});

test('ход без времени не считается разрывом — одинаковый штамп печатается один раз, в конце', () => {
  const items = groupHistory([assistant('a', DAY1), assistant('b'), assistant('c', DAY1)]);
  assert.deepEqual(stamps(items), [false, false, true]);
});

test('продолжение после чужого хода снова штампуется — цепочка началась заново', () => {
  const items = groupHistory([
    assistant('a', DAY1),
    assistant('b', DAY1),
    user('стоп', DAY1),
    assistant('c', DAY1),
    assistant('d', DAY1),
  ]);
  assert.deepEqual(stamps(items), [false, true, true, false, true]);
});

// ---- live twin ------------------------------------------------------------

let ln = 0;
const line = (kind: TranscriptLine['kind'], text: string, ts?: number): TranscriptLine =>
  ({ id: ++ln, kind, text, ...(ts !== undefined ? { ts } : {}) }) as TranscriptLine;

const liveConts = (items: ReturnType<typeof groupLive>) =>
  items.map((it) => (it.kind === 'line' ? it.cont : 'run'));

test('live: assistant after assistant continues, machinery folds onto the announcer', () => {
  const items = groupLive([
    line('assistant', 'a'),
    line('tool_use', 'Read {}'),
    line('tool_use', 'Bash {}'),
    line('assistant', 'b'),
  ]);
  assert.deepEqual(liveConts(items), [false, true]);
  assert.equal(items[0]!.kind === 'line' && items[0]!.runAfter?.lines.length, 2);
});

test('live: the streaming tail run attaches to the line that announced it, tail intact', () => {
  const items = groupLive([
    line('assistant', 'Смотрю глазами:'),
    line('tool_use', 'Bash {}'),
    line('tool_use', 'Read {}'),
  ]);
  assert.deepEqual(
    items.map((it) => it.kind),
    ['line'],
  );
  assert.equal(items[0]!.kind === 'line' && items[0]!.runAfter?.tail, true);
});

test('live: Codex command verdicts stay inside the gear instead of becoming transcript lines', () => {
  const items = groupLive([
    line('assistant', 'Проверяю.'),
    line('tool_use', '$ npm test'),
    { ...line('status', '→ completed'), code: 'command_output' },
    line('assistant', 'Готово.'),
  ]);
  assert.deepEqual(items.map((item) => item.kind), ['line', 'line']);
  const first = items[0];
  assert.equal(first?.kind === 'line' && first.runAfter?.lines.length, 2);
  assert.equal(first?.kind === 'line' && first.runAfter?.lines[1]?.text, '→ completed');
});

test('live: одинаковый штамп подряд печатается один раз', () => {
  const items = groupLive([
    line('assistant', 'a', DAY1),
    line('tool_use', 'Read {}', DAY1),
    line('assistant', 'b', DAY1),
    line('assistant', 'c', DAY1 + 60_000),
  ]);
  assert.deepEqual(
    items.filter((it) => it.kind === 'line').map((it) => (it.kind === 'line' ? it.showStamp : null)),
    [false, true, true],
  );
});

test('live: у агента штамп — в конце минуты, у человека — всегда', () => {
  const items = groupLive([
    line('assistant', 'a', DAY1),
    line('user', 'стоп', DAY1),
    line('assistant', 'b', DAY1),
    line('assistant', 'c', DAY1),
  ]);
  assert.deepEqual(
    items.filter((it) => it.kind === 'line').map((it) => (it.kind === 'line' ? it.showStamp : null)),
    [true, true, false, true],
  );
});

test('live: a user or error line resets the chain; the first line never continues', () => {
  const items = groupLive([
    line('assistant', 'a'),
    line('user', 'go'),
    line('assistant', 'b'),
    line('error', 'boom'),
    line('assistant', 'c'),
  ]);
  assert.deepEqual(liveConts(items), [false, false, false, false, false]);
});

/* --- эхо хода пользователя на стыке истории и живого потока --------------
 *
 * Найдено в проде: человек отправил длинное сообщение, оно исчезло с экрана,
 * а в транскрипте на диске лежало целым. Худшая форма бага — смотреть не на
 * что и винить некого.
 */

const toolResult = (): HistoryMessage => ({
  // Результат инструмента приходит С РОЛЬЮ user и без текстовых блоков. Именно
  // поэтому «последняя строка user» и «последнее, что сказал человек» — разные
  // вопросы.
  type: 'user',
  uuid: `tr${++n}`,
  blocks: [{ kind: 'tool_result', id: 't1', text: 'ok' } as never],
});

const liveUser = (text: string): TranscriptLine => ({ kind: 'user', text } as TranscriptLine);

test('эхо снимается, когда история уже содержит этот ход', () => {
  const lines = [liveUser('привет'), { kind: 'assistant', text: 'ответ' } as TranscriptLine];
  const out = dropEchoedUserLine(lines, [user('привет')], false);
  assert.equal(out.length, 1, 'дубля быть не должно');
  assert.equal(out[0]?.kind, 'assistant');
});

test('эхо с картинкой снимается по нормализованному тексту', () => {
  const history: HistoryMessage[] = [{
    type: 'user',
    uuid: 'with-image',
    blocks: [
      { kind: 'text', text: 'посмотри' },
      { kind: 'image', ref: 'msg_image#2' },
    ],
  }];
  const lines: TranscriptLine[] = [{
    ...liveUser('посмотри'),
    images: ['data:image/png;base64,aGVsbG8='],
  }];
  assert.deepEqual(dropEchoedUserLine(lines, history, false), []);
});

test('эхо НЕ снимается, пока история перечитывается', () => {
  // `lines` обнуляются при переподключении, история приходит мгновением позже.
  // В этом промежутке эхо — единственная копия сообщения на экране.
  const lines = [liveUser('привет')];
  assert.deepEqual(dropEchoedUserLine(lines, [user('привет')], true), lines);
});

test('эхо НЕ снимается, если история заканчивается результатом инструмента', () => {
  // Раньше сравнение шло с последней строкой user — а у результата инструмента
  // текста нет, и сравнение молча шло с пустой строкой.
  const lines = [liveUser('привет')];
  const history = [user('привет'), toolResult()];
  const out = dropEchoedUserLine(lines, history, false);
  assert.equal(out.length, 0, 'текстовый ход всё равно должен быть найден и эхо снято');

  // А вот ДРУГОЙ текст снимать нельзя ни при каких условиях.
  const other = [liveUser('второе сообщение')];
  assert.deepEqual(dropEchoedUserLine(other, history, false), other);
});

test('эхо не снимается, когда истории ещё нет', () => {
  const lines = [liveUser('первое сообщение в сессии')];
  assert.deepEqual(dropEchoedUserLine(lines, [], false), lines);
});

/* --- один ответ, напечатанный дважды ------------------------------------
 *
 * Найдено в проде по скриншоту: одна и та же реплика агента стоит в колонке
 * дважды, с разницей в минуту, а в `.jsonl` она ровно одна. Две копии — это
 * живая строка и та же реплика, перечитанная из файла; штампы разные, потому
 * что каждая копия датируется своим источником. Читается как «агент повторяется».
 */

test('живой ответ снимается, когда файл уже содержит этот ход', () => {
  const lines = [line('assistant', 'Проверяю.'), line('tool_use', 'Bash ls')];
  const out = dropEchoedUserLine(lines, [user('глянь'), assistant('Проверяю.')], false);
  assert.equal(out.length, 1, 'дубль ответа снят');
  assert.equal(out[0]?.kind, 'tool_use', 'машинерия остаётся — её в файле нет');
});

test('снимается вся пара «вопрос + ответ», если файл догнал обоих', () => {
  const lines = [line('user', 'глянь'), line('assistant', 'Проверяю.'), line('status', 'working')];
  const out = dropEchoedUserLine(lines, [user('глянь'), assistant('Проверяю.')], false);
  assert.deepEqual(out.map((l) => l.kind), ['status']);
});

test('повтор той же фразы человеком не съедается', () => {
  // «ок» час назад лежит в файле; «ок», отправленное сейчас, — другое сообщение.
  const lines = [line('user', 'ок')];
  const history = [user('ок'), assistant('сделал'), user('и ещё'), assistant('готово')];
  assert.deepEqual(dropEchoedUserLine(lines, history, false), lines, 'префикс не совпал — ничего не снято');
});

test('строку, которая ещё печатается, снимать нельзя', () => {
  const streaming: TranscriptLine = { kind: 'assistant', text: 'Проверяю.', streaming: true } as TranscriptLine;
  const lines = [streaming];
  assert.deepEqual(dropEchoedUserLine(lines, [assistant('Проверяю.')], false), lines);
});

/* --- свёртывание потока: ответ не печатается дважды ---------------------- */

test('финальный блок сворачивается в свою строку, даже если после неё уже машинерия', () => {
  // Одно сообщение агента несёт блоки по порядку: текст, затем tool_use. Агент
  // шлёт каждый своим событием, поэтому к приходу текстового блока буфер уже
  // заканчивается инструментом — и проверка «последняя строка» промахивалась.
  let id = 0;
  const nextId = () => ++id;
  const clock = () => 1000;
  let lines = foldStreamEvent([], { kind: 'partial', text: 'Прове' } as never, nextId, clock);
  lines = foldStreamEvent(lines, { kind: 'partial', text: 'ряю.' } as never, nextId, clock);
  lines = foldStreamEvent(lines, { kind: 'tool_use', text: 'Bash ls' } as never, nextId, clock);
  lines = foldStreamEvent(lines, { kind: 'assistant', text: 'Проверяю.' } as never, nextId, () => 99_000);
  const spoken = lines.filter((l) => l.kind === 'assistant');
  assert.equal(spoken.length, 1, 'ответ ровно один');
  assert.equal(spoken[0]?.streaming, false, 'строка больше не печатается');
  assert.equal(spoken[0]?.ts, 1000, 'штамп — момент начала речи, а не конца инструментов');
});

test('повторное событие с тем же текстом не добавляет вторую копию', () => {
  let id = 0;
  const nextId = () => ++id;
  let lines = foldStreamEvent([], { kind: 'assistant', text: 'Готово.' } as never, nextId, () => 1);
  lines = foldStreamEvent(lines, { kind: 'assistant', text: 'Готово.' } as never, nextId, () => 2);
  assert.equal(lines.filter((l) => l.kind === 'assistant').length, 1);
});

test('Codex без дельт по-прежнему печатает свои ответы подряд', () => {
  // У Codex нет канала `partial`: `assistant` — единственный носитель реплики,
  // и две РАЗНЫЕ реплики подряд должны остаться двумя.
  let id = 0;
  const nextId = () => ++id;
  let lines = foldStreamEvent([], { kind: 'assistant', text: 'Первое.' } as never, nextId, () => 1);
  lines = foldStreamEvent(lines, { kind: 'assistant', text: 'Второе.' } as never, nextId, () => 2);
  assert.deepEqual(lines.map((l) => l.text), ['Первое.', 'Второе.']);
});

test('обновления плана заменяют одну live-строку, а не множат её', () => {
  let id = 0;
  const nextId = () => ++id;
  let lines = foldStreamEvent(
    [],
    { kind: 'status', code: 'plan_update', text: '○ первый' } as never,
    nextId,
  );
  lines = foldStreamEvent(
    lines,
    { kind: 'status', code: 'plan_update', text: '✓ первый\n○ второй' } as never,
    nextId,
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.text, '✓ первый\n○ второй');
});

test('финальный ответ убирает временный live-план этого хода', () => {
  let id = 0;
  const nextId = () => ++id;
  let lines: TranscriptLine[] = [liveUser('составь план')];
  lines = foldStreamEvent(
    lines,
    { kind: 'status', code: 'plan_update', text: '✓ исследовать\n○ описать' } as never,
    nextId,
  );
  lines = foldStreamEvent(
    lines,
    { kind: 'assistant', text: '# Итоговый план' } as never,
    nextId,
  );
  assert.deepEqual(lines.map((l) => [l.kind, l.code, l.text]), [
    ['user', undefined, 'составь план'],
    ['assistant', undefined, '# Итоговый план'],
  ]);
});

/* --- открыли сессию посреди хода: файл и повтор хаба -----------------------
 *
 * Найдено в проде по скриншоту: весь ход агента напечатан дважды, верхняя копия
 * короче нижней. Обе правы. `session.messages` читает `.jsonl`, куда рантайм
 * уже слил законченные реплики этого хода; сразу за этим `subscribe` приносит
 * окно повтора хаба (`run.replay`), которое держит ТЕКУЩИЙ ход с самого начала —
 * ровно затем, чтобы поздно открытая панель показывала работу, а не пустоту.
 */

test('копия хода из файла снимается, когда хаб повторяет тот же ход', () => {
  const history = [user('сделай'), assistant('Берусь.'), toolResults(), assistant('Готово наполовину.')];
  const lines = [line('assistant', 'Берусь.'), line('tool_use', 'Bash ls'), line('assistant', 'Готово наполовину.')];
  const out = dropReplayedTurnFromHistory(history, lines);
  assert.deepEqual(out.map((m) => m.type), ['user'], 'от хода в файле остаётся только реплика человека');
});

test('ход человека и всё до него неприкосновенны', () => {
  // Повтор хаба покрывает только текущий ход. Предыдущая переписка живёт
  // исключительно в файле — снести её означало бы стереть сессию с экрана.
  const history = [user('первое'), assistant('ответ'), user('второе'), assistant('второй ответ')];
  const lines = [line('assistant', 'второй ответ')];
  const out = dropReplayedTurnFromHistory(history, lines);
  assert.deepEqual(out.map((m) => m.type), ['user', 'assistant', 'user']);
});

test('та же фраза в ПРОШЛОМ ходе не становится точкой отреза', () => {
  const history = [user('раз'), assistant('Готово.'), user('два'), assistant('Иначе.')];
  const lines = [line('assistant', 'Готово.')];
  // «Готово.» есть в файле, но в прошлом ходе — а повтор хаба про текущий.
  assert.deepEqual(dropReplayedTurnFromHistory(history, lines), history, 'ничего не снято');
});

test('окно повтора обрезано спереди — файл остаётся целым', () => {
  // Хаб выбрасывает старые кадры (REPLAY_MAX_FRAMES). Тогда первая живая строка
  // — обрывок, равенства нет, и НИЧЕГО не снимается: дубль доживёт до конца
  // хода, где его снимет сведение. Потерять абзац было бы хуже.
  const history = [user('сделай'), assistant('Длинная первая реплика.'), assistant('Вторая.')];
  const lines = [line('assistant', 'ервая реплика.')];
  assert.deepEqual(dropReplayedTurnFromHistory(history, lines), history);
});

test('строку, которая ещё печатается, за якорь не берут', () => {
  const streaming: TranscriptLine = { kind: 'assistant', text: 'Бер', streaming: true } as TranscriptLine;
  const history = [user('сделай'), assistant('Берусь.')];
  assert.deepEqual(dropReplayedTurnFromHistory(history, [streaming]), history);
});

// ---- the person's turn from another screen (user_turn, 28.09.2026) ---------

let seq = 1000;
const ids = () => ++seq;
const turn = (turnId: string, text: string) => ({ turnId, text, ts: DAY1 });

test('чужая реплика появляется на экране, который её не отправлял', () => {
  // Телефон написал «1-4 гоу», десктоп следит за тем же ходом: раньше вопрос
  // на десктопе не появлялся вовсе — ответ шёл сразу под прошлым ответом.
  const before = [line('assistant', 'Делаю пункты 1–4, а 5-й откладываем?')];
  const out = foldUserTurn(before, turn('t1', '1-4 гоу'), ids);
  assert.deepEqual(out.map((l) => [l.kind, l.text]), [
    ['assistant', 'Делаю пункты 1–4, а 5-й откладываем?'],
    ['user', '1-4 гоу'],
  ]);
  assert.equal(out[1]!.turnId, 't1');
  assert.equal(out[1]!.ts, DAY1);
});

test('своё эхо подтверждается, а не повторяется', () => {
  const echo = { ...line('user', '1-4 гоу'), id: 1 };
  const out = foldUserTurn([echo], turn('t1', '1-4 гоу'), ids);
  assert.equal(out.length, 1, 'один пузырь, не два');
  assert.equal(out[0]!.turnId, 't1');
  assert.equal(out[0]!.id, 1, 'та же строка, не новая');
});

test('повтор хода после переподключения не удваивает реплику', () => {
  const once = foldUserTurn([], turn('t1', 'ок'), ids);
  assert.equal(foldUserTurn(once, turn('t1', 'ок'), ids), once);
  // А второе «ок» — это второй ход, не повтор.
  assert.equal(foldUserTurn(once, turn('t2', 'ок'), ids).length, 2);
});

test('реплика без слов показывает вложения', () => {
  const out = foldUserTurn([], { turnId: 't1', text: '', images: 2, files: ['plan.md'] }, ids);
  assert.equal(out[0]!.text, '[2 картинки, plan.md]');
  assert.deepEqual(out[0]!.files, ['plan.md']);
  assert.deepEqual(foldUserTurn([], { turnId: 't2', text: '  ' }, ids), [], 'пустоту не рисуем');
});

const heard = (text: string, turnId = 'tX'): TranscriptLine => ({ ...line('user', text), turnId });

test('повтор, открытый вопросом, снимает копию хода из файла — вместе с вопросом', () => {
  const history = [user('раньше'), assistant('давно'), user('1-4 гоу'), assistant('Беру 1–4.'), toolResults()];
  const lines = [heard('1-4 гоу'), line('assistant', 'Беру 1–4.'), line('tool_use', 'Bash ls')];
  const out = dropReplayedTurnFromHistory(history, lines);
  assert.deepEqual(out.map((m) => m.uuid), history.slice(0, 2).map((m) => m.uuid));
});

test('файл успел только вопрос — снимаем вопрос, повтор покажет его сам', () => {
  const history = [user('раньше'), assistant('давно'), user('1-4 гоу')];
  const out = dropReplayedTurnFromHistory(history, [heard('1-4 гоу')]);
  assert.equal(out.length, 2);
});

test('старое «ок» с другим ответом под ним — не этот ход', () => {
  const history = [user('ок'), assistant('Сделал вчера.')];
  const lines = [heard('ок'), line('assistant', 'Сделаю сейчас.')];
  assert.deepEqual(dropReplayedTurnFromHistory(history, lines), history);
});

test('старое «ок», за которым шла ещё переписка, — не этот ход', () => {
  const history = [user('ок'), assistant('Сделал.'), user('а тесты?'), assistant('Зелёные.')];
  assert.deepEqual(dropReplayedTurnFromHistory(history, [heard('ок')]), history);
});

test('ответ в файле есть, а живого ещё нет — файл не трогаем', () => {
  const history = [user('1-4 гоу'), assistant('Беру 1–4.')];
  assert.deepEqual(dropReplayedTurnFromHistory(history, [heard('1-4 гоу')]), history);
});

test('эхо своего композера этим правилом не обрабатывается', () => {
  const history = [user('раньше'), user('1-4 гоу')];
  const echo = line('user', '1-4 гоу');
  assert.deepEqual(dropReplayedTurnFromHistory(history, [echo]), history);
});

// ---- compaction: one line, in Russian (28.09.2026) --------------------------

test('сжатие — одна строка, как бы часто о нём ни сказали', () => {
  const ev = (code: string, text: string) => ({ kind: 'status' as const, code, text });
  let lines = foldStreamEvent([], ev('compact_started', 'compacting context… (queued behind the current turn)'), ids);
  const id = lines[0]!.id;
  assert.equal(lines[0]!.text, 'Сжимаю контекст — после текущего хода…');
  lines = foldStreamEvent(lines, ev('compact_started', 'compacting context…'), ids);
  lines = foldStreamEvent(lines, ev('compact_started', 'compacting context…'), ids);
  assert.equal(lines.length, 1, 'три объявления — одна строка');
  assert.equal(lines[0]!.id, id, 'та же строка: новизну вердикта Chat меряет по id');
  assert.equal(lines[0]!.text, 'Сжимаю контекст…');
  lines = foldStreamEvent(lines, ev('compact_done', 'context compacted'), ids);
  assert.deepEqual(lines.map((l) => [l.code, l.text]), [
    ['compact_started', 'Сжимаю контекст…'],
    ['compact_done', 'контекст сжат'],
  ]);
  assert.equal(
    foldStreamEvent([], ev('compact_done', 'context compacted: 746k → 10k tokens'), ids)[0]!.text,
    'контекст сжат: 746k → 10k токенов',
  );
  // Следующее сжатие — уже новая строка.
  lines = foldStreamEvent(lines, ev('compact_started', 'compacting context…'), ids);
  assert.equal(lines.length, 3);
  lines = foldStreamEvent(lines, ev('compact_failed', '⚠ compaction failed: Not enough messages to compact.'), ids);
  assert.equal(lines.at(-1)!.text, 'Не удалось сжать контекст: Not enough messages to compact.');
});

test('длинная вставка приходит головой — эхо всё равно одно, а у других видно «…»', () => {
  const full = 'а'.repeat(40) + ' хвост';
  const head = 'а'.repeat(40);
  const echo = { ...line('user', full), id: 7 };
  const mine = foldUserTurn([echo], { turnId: 't1', text: head, truncated: true }, ids);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.text, full, 'у отправителя — его полный текст');
  const theirs = foldUserTurn([], { turnId: 't1', text: head, truncated: true }, ids);
  assert.equal(theirs[0]!.text, `${head}…`);
  // И файл, где лежит полное сообщение, узнаёт в этой голове свой ход.
  const history = [user('раньше'), user(full)];
  assert.equal(dropReplayedTurnFromHistory(history, theirs).length, 1);
});

test('те же слова ещё раз — новый ход, старый обмен не прячем (ревью 28.09)', () => {
  const t0 = DAY1;
  const history = [
    user('проверь CI', t0),
    assistant('Смотрю.', t0 + 1000),
    toolResults(t0 + 2000),
    assistant('Зелёный.', t0 + 3000),
  ];
  // Эхо отправителя, подтверждённое хабом, и первый ответ нового хода — тот же.
  const lines = [{ ...heard('проверь CI', 'tNew'), ts: t0 + 3_600_000 }, line('assistant', 'Смотрю.')];
  assert.deepEqual(dropReplayedTurnFromHistory(history, lines), history);
  // А свежая запись того же хода (секунды разницы) снимается как раньше.
  const fresh = [{ ...heard('проверь CI', 'tNew'), ts: t0 + 500 }, line('assistant', 'Смотрю.')];
  assert.equal(dropReplayedTurnFromHistory(history, fresh).length, 0);
});

/* --- вопрос посреди хода и переподключение (10.10.2026, shop-app) ----------
 *
 * Человек дописал вопрос, пока агент работал, и тут же переподключился сокет.
 * `keepUnansweredTail` оставил вопрос в голове буфера, повтор хаба положил под
 * него весь ход — порядок «вопрос → инструменты → первый промпт». Голова уже
 * не начало хода, файл со стримом не сводился, и на экране было: вопрос из
 * файла, тот же вопрос из ленты, под ними ход второй раз.
 */

test('удержанный вопрос встаёт на своё место, когда повтор приносит его ход', () => {
  const before = [heard('сделай аудит', 'u1'), line('tool_use', 'Agent'), heard('а по апи есть доступ?', 'u2')];
  let lines = keepUnansweredTail(before);
  assert.deepEqual(lines.map((l) => l.text), ['а по апи есть доступ?']);
  lines = foldUserTurn(lines, turn('u1', 'сделай аудит'), ids);
  lines = [...lines, line('tool_use', 'Agent')];
  lines = foldUserTurn(lines, turn('u2', 'а по апи есть доступ?'), ids);
  assert.deepEqual(
    lines.map((l) => [l.kind, l.text]),
    [
      ['user', 'сделай аудит'],
      ['tool_use', 'Agent'],
      ['user', 'а по апи есть доступ?'],
    ],
  );
  assert.equal(lines[2]!.carried, undefined, 'вернулся с повтором — больше не «удержанный»');
  // Второй повтор того же хода строку уже не двигает.
  const again = foldUserTurn(lines, turn('u2', 'а по апи есть доступ?'), ids);
  assert.equal(again, lines);
});

test('неподтверждённое эхо, удержанное при переподключении, тоже встаёт на место', () => {
  const echo = { ...line('user', 'а по апи?'), images: ['data:x'] };
  let lines = keepUnansweredTail([heard('сделай', 'u1'), line('assistant', 'Берусь.'), echo]);
  lines = foldUserTurn(lines, turn('u1', 'сделай'), ids);
  lines = foldUserTurn(lines, turn('u2', 'а по апи?'), ids);
  assert.deepEqual(lines.map((l) => l.text), ['сделай', 'а по апи?']);
  assert.equal(lines[1]!.turnId, 'u2');
  assert.deepEqual(lines[1]!.images, ['data:x'], 'картинки своего композера не теряются');
});

test('уведомление помощника на результате вызова — не реплика человека', () => {
  const notified: HistoryMessage = {
    type: 'user',
    uuid: `n${++n}`,
    blocks: [
      { kind: 'tool_result', toolUseId: 'a1', text: 'Async agent launched' },
      {
        kind: 'text',
        text: '<task-notification><tool-use-id>a1</tool-use-id><status>completed</status><result>отчёт</result></task-notification>',
      },
    ],
  };
  const history = [user('раньше'), assistant('давно'), user('сделай аудит'), assistant('Берусь.'), notified, user('а по апи?')];
  const lines = [heard('сделай аудит', 'u1'), line('assistant', 'Берусь.'), line('tool_use', 'Agent'), heard('а по апи?', 'u2')];
  const out = dropReplayedTurnFromHistory(history, lines);
  assert.deepEqual(out.map((m) => m.uuid), history.slice(0, 2).map((m) => m.uuid));
});

test('повтор, отправленный ДРУГОЙ панели, удержанную строку не двигает', () => {
  let lines = keepUnansweredTail([heard('сделай', 'u1'), line('tool_use', 'Agent'), heard('а по апи?', 'u2')]);
  // Чужой повтор: кадры инструментов между ходами этой панели отброшены.
  lines = foldUserTurn(lines, turn('u1', 'сделай'), ids, Date.now, false);
  lines = foldUserTurn(lines, turn('u2', 'а по апи?'), ids, Date.now, false);
  assert.equal(lines[0]!.text, 'а по апи?');
  assert.equal(lines[0]!.carried, true, 'ждёт своего повтора');
  // Свой повтор ставит на место.
  lines = [...lines, line('tool_use', 'Agent')];
  lines = foldUserTurn(lines, turn('u2', 'а по апи?'), ids);
  assert.deepEqual(lines.map((l) => l.text), ['сделай', 'Agent', 'а по апи?']);
});

test('второй обрыв посреди повтора не теряет удержанную строку', () => {
  let lines = keepUnansweredTail([heard('сделай', 'u1'), line('tool_use', 'Agent'), line('user', 'а по апи?')]);
  lines = foldUserTurn(lines, turn('u1', 'сделай'), ids);
  lines = [...lines, line('tool_use', 'Agent')];
  // Связь снова упала, пока повтор не дошёл до вопроса.
  lines = keepUnansweredTail(lines);
  assert.deepEqual(lines.map((l) => l.text), ['а по апи?']);
});

test('длинная вставка посреди хода не мешает снять копию хода из файла', () => {
  const long = `${'x'.repeat(40)} конец`;
  const history = [user('раньше'), assistant('давно'), user('сделай'), assistant('Берусь.'), user(long)];
  const cut: TranscriptLine = { ...heard(`${'x'.repeat(40)}…`, 'u2'), data: { truncated: true } };
  const lines = [heard('сделай', 'u1'), line('assistant', 'Берусь.'), cut];
  const out = dropReplayedTurnFromHistory(history, lines);
  assert.equal(out.length, 2);
});
