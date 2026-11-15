/**
 * The interactive planning tools, answered from a phone.
 *
 * `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` arrive through the
 * ordinary approval path (`tool_request`) and the answer travels back as
 * `tool_decision.updatedInput` — the SDK's `PermissionResult.updatedInput`.
 * The shapes are the web's, deliberately: both import `AskQuestion` from
 * `@cc-remote/shared`, because a divergence here means the agent silently gets
 * an answer it cannot read.
 *
 * The tool input crosses the wire as arbitrary JSON, so it is validated rather
 * than cast — a missing `question` would otherwise take the bot down mid-run.
 */

import { parseAskQuestions, type AskOption, type AskQuestion } from '@cc-remote/shared';

export type { AskOption, AskQuestion };

/** Lenient on purpose — see `parseAskQuestions` in shared for the contract. */
export const normalizeQuestions = parseAskQuestions;

/**
 * Claude keys answers by question TEXT; Codex supplies stable question ids.
 * Sending the wrong key is not an error the agent reports — it just answers a
 * question nobody asked.
 */
export function answerKey(question: AskQuestion): string {
  return question.id ?? question.question;
}
