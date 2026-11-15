import { SESSION_STAGES, type BoardAttention, type BoardCard, type BoardCardPatch, type BoardStatus } from '@cc-remote/shared';
import { dayKey, pluralRu } from '../../lib.js';

/**
 * Pure helpers for the task board — grouping, labels, the optimistic patch.
 * No React, no DOM: `web/test/board-model.test.ts` runs them under plain node.
 */

/** Columns in board order, with the cards that belong to each. A card waiting
 *  on a person floats to the top of its column; the rest are newest first. */
export function groupCards(cards: BoardCard[]): Map<BoardStatus, BoardCard[]> {
  const out = new Map<BoardStatus, BoardCard[]>();
  for (const s of SESSION_STAGES) out.set(s.id, []);
  for (const c of cards) out.get(c.status)?.push(c);
  for (const list of out.values()) {
    list.sort((a, b) => {
      const aw = a.attention === 'none' ? 0 : 1;
      const bw = b.attention === 'none' ? 0 : 1;
      if (aw !== bw) return bw - aw;
      return b.lastActivity - a.lastActivity;
    });
  }
  return out;
}

export interface DoneGroup {
  label: string;
  cards: BoardCard[];
}

const WEEKDAYS_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Monday 00:00 of the week `ms` falls in, in the reader's timezone. */
function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

/**
 * The «Готово» column, grouped by when things closed. A week's view groups by
 * day («Сегодня», «Вчера», «ср, 24 сен»); longer views by week («Эта неделя»,
 * «Прошлая неделя», «Неделя с 8 сен»). Calendar-based on purpose — see `dayKey`.
 */
export function groupDone(cards: BoardCard[], now: number, sinceDays: number): DoneGroup[] {
  const sorted = [...cards].sort((a, b) => (b.doneAt ?? b.lastActivity) - (a.doneAt ?? a.lastActivity));
  const groups: DoneGroup[] = [];
  let lastKey = '';
  for (const c of sorted) {
    const at = c.doneAt ?? c.lastActivity;
    let key: string;
    let label: string;
    if (sinceDays <= 7) {
      key = dayKey(at);
      if (key === dayKey(now)) label = 'Сегодня';
      else if (key === dayKey(now - 86_400_000)) label = 'Вчера';
      else {
        const d = new Date(at);
        label = `${WEEKDAYS_RU[d.getDay()]}, ${d.getDate()} ${MONTHS_RU[d.getMonth()]}`;
      }
    } else {
      const ws = weekStart(at);
      key = String(ws);
      const thisWeek = weekStart(now);
      if (ws === thisWeek) label = 'Эта неделя';
      else if (ws === weekStart(thisWeek - 86_400_000)) label = 'Прошлая неделя';
      else {
        const d = new Date(ws);
        label = `Неделя с ${d.getDate()} ${MONTHS_RU[d.getMonth()]}`;
      }
    }
    if (key !== lastKey) {
      groups.push({ label, cards: [] });
      lastKey = key;
    }
    groups[groups.length - 1]!.cards.push(c);
  }
  return groups;
}

/** The card as it will look once the hub accepts the edit. A hand edit pins
 *  the card (`manualOverride`), which is what the hub does too. */
export function applyPatch(cards: BoardCard[], cardId: string, patch: BoardCardPatch): BoardCard[] {
  return cards.map((c) => {
    if (c.cardId !== cardId) return c;
    const next: BoardCard = { ...c };
    if (patch.status) {
      next.status = patch.status;
      if (patch.status === 'done') next.doneAt = c.doneAt ?? Date.now();
      else delete next.doneAt;
    }
    if (patch.attention) {
      next.attention = patch.attention;
      if (patch.attention === 'none') delete next.attentionNote;
    }
    if (patch.title) next.title = patch.title;
    if (patch.status || patch.attention || patch.title) next.manualOverride = true;
    return next;
  });
}

export function attentionText(a: BoardAttention): string | null {
  if (a === 'question') return 'нужен ответ';
  if (a === 'blocked') return 'стоп';
  return null;
}

export interface EvidenceMark {
  key: 'commits' | 'deployed' | 'verified';
  on: boolean;
  label: string;
  title: string;
}

/** Three squares under a card: filled = happened, hollow = not yet. */
export function evidenceMarks(card: BoardCard): EvidenceMark[] {
  const e = card.evidence;
  return [
    {
      key: 'commits',
      on: e.commits > 0,
      label: e.commits > 1 ? `коммит ×${e.commits}` : 'коммит',
      title: e.commits > 0 ? `${e.commits} ${pluralRu(e.commits, ['коммит', 'коммита', 'коммитов'])}` : 'коммитов не было',
    },
    { key: 'deployed', on: e.deployed, label: 'выкат', title: e.deployed ? 'выложено' : 'не выкладывалось' },
    { key: 'verified', on: e.verified, label: 'проверено', title: e.verified ? 'проверено после коммита' : 'не проверялось' },
  ];
}

export const STATUS_LABEL: Record<BoardStatus, string> = Object.fromEntries(
  SESSION_STAGES.map((s) => [s.id, s.label]),
) as Record<BoardStatus, string>;
