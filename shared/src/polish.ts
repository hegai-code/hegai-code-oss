import { z } from 'zod';

/**
 * `POST /polish` — dictation clean-up (server-rs/src/polish.rs).
 *
 * The web sends what whisper wrote plus a little context it is looking at, and
 * gets back what the person meant to type: misheard terms fixed against the
 * project, punctuation, paragraphs, lists, filler gone. `polished: false` means
 * the hub handed the text back untouched (gateway slow or the rewrite looked
 * like an answer) — the client inserts it as is.
 *
 * `POLISH_MAX_TEXT` is also `polish::MAX_TEXT` on the hub; a test there reads
 * this file and fails when the two disagree.
 */
export const POLISH_MAX_TEXT = 12_000;
/** How much of the conversation's tail rides along, for vocabulary. */
export const POLISH_MAX_RECENT = 4_000;

export const PolishRequest = z.object({
  text: z.string().min(1).max(POLISH_MAX_TEXT),
  /** Project label (last cwd segment). */
  project: z.string().max(200).optional(),
  /** Session title. */
  title: z.string().max(200).optional(),
  /** The end of the conversation, `role: text` lines — names and identifiers
   *  the person is likely to say. Context only; the hub never follows it. */
  recent: z.string().max(POLISH_MAX_RECENT).optional(),
});
export type PolishRequest = z.infer<typeof PolishRequest>;

export const PolishResponse = z.object({
  text: z.string(),
  polished: z.boolean(),
});
export type PolishResponse = z.infer<typeof PolishResponse>;
