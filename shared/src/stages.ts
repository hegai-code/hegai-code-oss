import { z } from 'zod';

/**
 * Kanban STAGE of a session/task — a MUTABLE lifecycle position, distinct from
 * `category` (see categories.ts). Category is a fixed work-TYPE chosen at
 * creation and mapped to a skill; stage is where the task sits on the board and
 * changes as work progresses. Persisted per (machine, session) by the hub and
 * shown as a column on the Flow board.
 *
 * Order matters: SESSION_STAGES is left→right board order.
 */
export const SessionStage = z.enum(['backlog', 'planning', 'in_progress', 'testing', 'done']);
export type SessionStage = z.infer<typeof SessionStage>;

export interface SessionStageInfo {
  id: SessionStage;
  /** Human label (Russian — matches the product UI). */
  label: string;
  /** CSS custom-property name for the column accent (defined in styles.css). */
  token: string;
}

export const SESSION_STAGES: ReadonlyArray<SessionStageInfo> = [
  { id: 'backlog', label: 'Бэклог', token: 'stage-backlog' },
  { id: 'planning', label: 'Планирование', token: 'stage-planning' },
  { id: 'in_progress', label: 'В работе', token: 'stage-in-progress' },
  { id: 'testing', label: 'Тестирование', token: 'stage-testing' },
  { id: 'done', label: 'Готово', token: 'stage-done' },
];
