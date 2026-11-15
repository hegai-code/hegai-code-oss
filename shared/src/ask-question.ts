import { z } from 'zod';

/**
 * The `AskUserQuestion` tool input — what `tool_request.input.questions` carries
 * and what the web modal and the Telegram bot both render. The input crosses the
 * wire as arbitrary JSON, so the shape is validated rather than cast.
 *
 * The contract is LENIENT on purpose, and both clients relied on it: only a
 * string `question` is required. Everything else is sanitised instead of
 * rejected — a wrong-typed `id`/`header`/`description`/`preview` is dropped,
 * `multiSelect`/`isSecret` fall back to `false`, `options` falls back to `[]`
 * and loses its malformed entries (a dropped field is an `undefined` value, not
 * an absent key; nothing reads the difference) — because dropping a whole question over a
 * stray field leaves the agent waiting on an answer nobody can give. Tightening
 * any of this changes what a person is shown.
 */
export const AskOption = z.object({
  label: z.string(),
  description: z.string().optional().catch(undefined),
  /** Part of the Claude `AskUserQuestion` input shape; kept through parsing,
   *  rendered by neither client today. */
  preview: z.string().optional().catch(undefined),
});
export type AskOption = z.infer<typeof AskOption>;

export const AskQuestion = z.object({
  /** Codex supplies a stable id; Claude keys the answer by `question` text. */
  id: z.string().optional().catch(undefined),
  question: z.string(),
  header: z.string().optional().catch(undefined),
  options: z
    .array(z.unknown())
    .catch([])
    .transform((entries) =>
      entries.flatMap((entry) => {
        const parsed = AskOption.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  multiSelect: z.boolean().catch(false),
  isSecret: z.boolean().catch(false),
});
export type AskQuestion = z.infer<typeof AskQuestion>;

/** The questions of an `AskUserQuestion` input; entries that are not a question
 *  are skipped, anything that is not a list yields `[]`. Never throws. */
export function parseAskQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = AskQuestion.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
