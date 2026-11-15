/**
 * The board contract. The hub (Rust) serializes cards by hand, so the shape
 * pinned here is what `deploy/board-assemble.py` writes and what the web
 * parses at the boundary; a drift shows up here before it shows up as an
 * empty board. Run: `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_STAGES } from '../src/stages.js';
import { BoardCard, BoardCardPatch, BoardResponse, BoardStatus } from '../src/board.js';

const card = {
  cardId: 'crd_0123456789ab',
  title: 'Диктовка на телефоне не глотает пробелы',
  summary: 'Хотели, чтобы надиктованный текст приходил целиком. Сделано и выложено.',
  status: 'done',
  attention: 'none',
  project: 'hegaivoice',
  area: 'transcribe',
  owner: { userId: 'u1', label: 'Владелец', email: 'owner@x.test' },
  machines: [{ machineId: 'm1', name: 'buildbox-pc' }],
  firstSeen: 1_790_000_000_000,
  lastActivity: 1_790_400_000_000,
  doneAt: 1_790_400_000_000,
  stale: false,
  evidence: {
    commits: 2,
    lastCommitAt: 1_790_399_000_000,
    pushed: true,
    deployed: true,
    verified: false,
    editedFiles: 5,
    humanTurns: 9,
  },
  confidence: 0.8,
  manualOverride: false,
  sessions: [
    {
      machineId: 'm1',
      source: 'claude',
      sessionId: 's1',
      title: 'Визуал распознавания аудио',
      lastModified: 1_790_400_000_000,
      role: 'origin',
    },
  ],
  events: [{ at: 1_790_400_000_000, actor: 'assembler', kind: 'created', reason: 'коммит и выкат' }],
};

test('board columns are exactly the kanban stages, in order', () => {
  assert.deepEqual(
    BoardStatus.options,
    SESSION_STAGES.map((s) => s.id),
  );
});

test('a full card and a minimal response parse', () => {
  assert.equal(BoardCard.safeParse(card).success, true);
  const minimal = { ...card };
  delete (minimal as Record<string, unknown>).owner;
  delete (minimal as Record<string, unknown>).area;
  delete (minimal as Record<string, unknown>).doneAt;
  assert.equal(BoardCard.safeParse(minimal).success, true);
  const res = BoardResponse.safeParse({ generatedAt: 1, areas: [], owners: [], cards: [minimal] });
  assert.equal(res.success, true);
});

test('absent means absent — null is not a value on this wire', () => {
  assert.equal(BoardCard.safeParse({ ...card, owner: null }).success, false);
  assert.equal(BoardCard.safeParse({ ...card, doneAt: null }).success, false);
});

test('a hand edit is strict: known fields, known values, nothing else', () => {
  assert.equal(BoardCardPatch.safeParse({ status: 'testing', note: 'проверю утром' }).success, true);
  assert.equal(BoardCardPatch.safeParse({ status: null }).success, false);
  assert.equal(BoardCardPatch.safeParse({ status: 'nope' }).success, false);
  assert.equal(BoardCardPatch.safeParse({ summary: 'model-owned' }).success, false);
  assert.equal(BoardCardPatch.safeParse({ title: '' }).success, false);
});
