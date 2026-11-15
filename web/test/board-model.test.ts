import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardCard } from '@cc-remote/shared';
import { applyPatch, evidenceMarks, groupCards, groupDone } from '../src/components/board/boardModel.js';
import { pluralRu, relTimeRu } from '../src/lib.js';

const base = (over: Partial<BoardCard>): BoardCard => ({
  cardId: 'crd_a',
  title: 'Тест',
  summary: '',
  status: 'in_progress',
  attention: 'none',
  project: 'hegai',
  machines: [],
  firstSeen: 1,
  lastActivity: 10,
  stale: false,
  evidence: { commits: 0, pushed: false, deployed: false, verified: false, editedFiles: 0, humanTurns: 1 },
  confidence: 0.8,
  manualOverride: false,
  sessions: [],
  events: [],
  ...over,
});

test('columns are the five stages and a waiting card floats up', () => {
  const g = groupCards([
    base({ cardId: 'old', lastActivity: 5 }),
    base({ cardId: 'new', lastActivity: 9 }),
    base({ cardId: 'ask', lastActivity: 1, attention: 'question' }),
    base({ cardId: 'done', status: 'done' }),
  ]);
  assert.deepEqual([...g.keys()], ['backlog', 'planning', 'in_progress', 'testing', 'done']);
  assert.deepEqual(g.get('in_progress')!.map((c) => c.cardId), ['ask', 'new', 'old']);
  assert.equal(g.get('done')!.length, 1);
  assert.equal(g.get('backlog')!.length, 0);
});

test('«Готово» groups by calendar day for a week and by week for longer', () => {
  const now = new Date(2026, 8, 26, 12, 0).getTime(); // Sat 26 Sep 2026
  const at = (d: number, h: number) => new Date(2026, 8, d, h).getTime();
  const cards = [
    base({ cardId: 'a', status: 'done', doneAt: at(26, 9) }),
    base({ cardId: 'b', status: 'done', doneAt: at(25, 23) }), // 23:30 yesterday, NOT today
    base({ cardId: 'c', status: 'done', doneAt: at(26, 0) }), // 00:10 today
    base({ cardId: 'd', status: 'done', doneAt: at(17, 15) }), // last week
  ];
  const days = groupDone(cards, now, 7);
  assert.deepEqual(days.map((g) => [g.label, g.cards.map((c) => c.cardId)]), [
    ['Сегодня', ['a', 'c']],
    ['Вчера', ['b']],
    ['чт, 17 сен', ['d']],
  ]);
  const weeks = groupDone(cards, now, 14);
  assert.deepEqual(weeks.map((g) => g.label), ['Эта неделя', 'Прошлая неделя']);
  assert.equal(weeks[0]!.cards.length, 3);
});

test('an optimistic patch pins the card and keeps doneAt honest', () => {
  const cards = [base({}), base({ cardId: 'crd_b', status: 'done', doneAt: 5 })];
  const moved = applyPatch(cards, 'crd_a', { status: 'done' });
  assert.equal(moved[0]!.status, 'done');
  assert.equal(moved[0]!.manualOverride, true);
  assert.ok(moved[0]!.doneAt);
  assert.equal(moved[1], cards[1], 'untouched cards are the same object');
  const reopened = applyPatch(moved, 'crd_b', { status: 'testing' });
  assert.equal('doneAt' in reopened[1]!, false, 'leaving done drops doneAt — absent, not null');
  const flagged = applyPatch(cards, 'crd_a', { attention: 'blocked' });
  assert.equal(flagged[0]!.attention, 'blocked');
  const unflagged = applyPatch([base({ attention: 'question', attentionNote: 'что?' })], 'crd_a', { attention: 'none' });
  assert.equal('attentionNote' in unflagged[0]!, false);
});

test('evidence marks: filled when it happened, hollow when not', () => {
  const marks = evidenceMarks(base({ evidence: { commits: 3, pushed: true, deployed: true, verified: false, editedFiles: 2, humanTurns: 4 } }));
  assert.deepEqual(marks.map((m) => [m.key, m.on]), [['commits', true], ['deployed', true], ['verified', false]]);
  assert.equal(marks[0]!.label, 'коммит ×3');
});

test('Russian plurals and relative time read like a sentence', () => {
  assert.equal(pluralRu(1, ['карточка', 'карточки', 'карточек']), 'карточка');
  assert.equal(pluralRu(3, ['карточка', 'карточки', 'карточек']), 'карточки');
  assert.equal(pluralRu(11, ['карточка', 'карточки', 'карточек']), 'карточек');
  assert.equal(pluralRu(22, ['карточка', 'карточки', 'карточек']), 'карточки');
  const now = new Date(2026, 8, 26, 12, 0).getTime();
  assert.equal(relTimeRu(now - 20_000, now), 'только что');
  assert.equal(relTimeRu(now - 5 * 60_000, now), '5 мин назад');
  assert.equal(relTimeRu(now - 2 * 3_600_000, now), '2 ч назад');
  assert.equal(relTimeRu(now - 30 * 3_600_000, now), 'вчера');
  assert.equal(relTimeRu(now - 3 * 86_400_000, now), '3 дн назад');
  assert.equal(relTimeRu(new Date(2026, 8, 10).getTime(), now), '10 сен');
});
