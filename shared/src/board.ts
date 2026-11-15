import { z } from 'zod';
import { SessionStage } from './stages.js';

/**
 * The task board («Доска», `/w/board`). A CARD is a task as a non-technical
 * reader sees it — «что изменилось для пользователя» — assembled from session
 * transcripts by `deploy/board-assemble.py` on the hub box and served by the
 * hub over `GET /api/board`. A card is not a session: one mixed session yields
 * several cards, and one task that ran across several sessions is one card.
 *
 * Columns reuse the kanban stages of `stages.ts` so the board and the
 * per-session `stage` never disagree on what a column is called. `attention`
 * is orthogonal: a card in any column may be waiting on a person.
 *
 * Wire rule (CLAUDE.md #3): `optional` means absent, never `null`. The hub
 * omits `owner`, `doneAt`, `area`… when it has nothing to say.
 */
export const BoardStatus = SessionStage;
export type BoardStatus = z.infer<typeof BoardStatus>;

export const BoardAttention = z.enum(['none', 'question', 'blocked']);
export type BoardAttention = z.infer<typeof BoardAttention>;

/** Periods the board offers; the default (14) is omitted from the URL. */
export const BOARD_SINCE_DAYS = [7, 14, 30] as const;
export type BoardSinceDays = (typeof BOARD_SINCE_DAYS)[number];
export const BOARD_SINCE_DEFAULT: BoardSinceDays = 14;

export const BoardPerson = z.object({
  userId: z.string(),
  /** Short display name: first name or the email's local part. */
  label: z.string(),
  email: z.string().optional(),
  fullName: z.string().optional(),
});
export type BoardPerson = z.infer<typeof BoardPerson>;

export const BoardMachine = z.object({ machineId: z.string(), name: z.string() });
export type BoardMachine = z.infer<typeof BoardMachine>;

/** Facts the assembler COUNTED from the transcript, not what the model said. */
export const BoardEvidence = z.object({
  commits: z.number().int().nonnegative(),
  lastCommitAt: z.number().optional(),
  pushed: z.boolean(),
  deployed: z.boolean(),
  verified: z.boolean(),
  editedFiles: z.number().int().nonnegative(),
  humanTurns: z.number().int().nonnegative(),
});
export type BoardEvidence = z.infer<typeof BoardEvidence>;

export const BoardCardSession = z.object({
  machineId: z.string(),
  source: z.enum(['claude', 'codex']).optional(),
  sessionId: z.string(),
  title: z.string(),
  lastModified: z.number(),
  /** `origin` fed the card first; `continuation` was linked to it later. */
  role: z.enum(['origin', 'continuation']),
});
export type BoardCardSession = z.infer<typeof BoardCardSession>;

export const BoardEventKind = z.enum([
  'created',
  'status',
  'attention',
  'title',
  'summary',
  'link',
  'reopen',
  'manual',
  'archive',
]);
export const BoardCardEvent = z.object({
  at: z.number(),
  /** `assembler`, or the user id of the person who edited by hand. */
  actor: z.string(),
  kind: BoardEventKind,
  from: z.string().optional(),
  to: z.string().optional(),
  reason: z.string(),
});
export type BoardCardEvent = z.infer<typeof BoardCardEvent>;

export const BoardCard = z.object({
  cardId: z.string(),
  /** ≤ 60 chars, plain Russian, readable without context. */
  title: z.string(),
  /** 2–4 sentences: what was wanted, what is done, what remains. */
  summary: z.string(),
  status: BoardStatus,
  attention: BoardAttention,
  /** The question or the blocker, one sentence. */
  attentionNote: z.string().optional(),
  project: z.string(),
  /** Roadmap group id (server-side `RoadmapConfig`); absent = unassigned. */
  area: z.string().optional(),
  owner: BoardPerson.optional(),
  machines: z.array(BoardMachine),
  firstSeen: z.number(),
  lastActivity: z.number(),
  doneAt: z.number().optional(),
  /** `in_progress`/`testing` with no activity for 72 h — hub-computed. */
  stale: z.boolean(),
  /** For open cards: the observable sign that would make this done. */
  doneWhen: z.string().optional(),
  evidence: BoardEvidence,
  /** The assembler's confidence in status AND task boundaries, 0..1. */
  confidence: z.number().min(0).max(1),
  /** A person changed status/attention/title; the assembler leaves those alone. */
  manualOverride: z.boolean(),
  sessions: z.array(BoardCardSession),
  /** The last few changes, newest first. */
  events: z.array(BoardCardEvent),
});
export type BoardCard = z.infer<typeof BoardCard>;

export const BoardArea = z.object({
  id: z.string(),
  name: z.string(),
  blurb: z.string(),
  projects: z.array(z.string()),
});
export type BoardArea = z.infer<typeof BoardArea>;

export const BoardOwnerCount = BoardPerson.extend({ cards: z.number().int().nonnegative() });
export type BoardOwnerCount = z.infer<typeof BoardOwnerCount>;

export const BoardRun = z.object({
  runId: z.string(),
  mode: z.string(),
  finishedAt: z.number().optional(),
  llmCalls: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type BoardRun = z.infer<typeof BoardRun>;

/** `GET /api/board` */
export const BoardResponse = z.object({
  generatedAt: z.number(),
  lastRun: BoardRun.optional(),
  areas: z.array(BoardArea),
  owners: z.array(BoardOwnerCount),
  cards: z.array(BoardCard),
});
export type BoardResponse = z.infer<typeof BoardResponse>;

/** `POST /api/board/cards/{cardId}` — a hand edit. Any of status / attention /
 *  title sets `manualOverride`. `note` lands in the card's history. */
export const BoardCardPatch = z
  .object({
    status: BoardStatus.optional(),
    attention: BoardAttention.optional(),
    title: z.string().min(1).max(120).optional(),
    archived: z.boolean().optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
export type BoardCardPatch = z.infer<typeof BoardCardPatch>;
