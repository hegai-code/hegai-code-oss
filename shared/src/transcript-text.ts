/**
 * Harness plumbing the CLI injects into a turn's text — background-task
 * notifications, system reminders, the slash-command envelope. Agents strip it
 * at the source now (`agent/src/history.ts`), but the hub already persisted
 * months of transcripts with it inline, so every reader (the web, the Telegram
 * bot) still needs this guard. One definition: the two readers used to carry
 * byte-identical copies.
 *
 * Global regex — use it with `String.replace`, which resets `lastIndex`;
 * `.test`/`.exec` on a shared `/g` regex would carry state between calls.
 */
export const HARNESS_NOISE_RE =
  /<(task-notification|system-reminder|local-command-stdout|local-command-caveat|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

/** Drop the injected envelope; text with no `<` is returned untouched (not trimmed). */
export function stripHarnessNoise(text: string): string {
  return text.includes('<') ? text.replace(HARNESS_NOISE_RE, '').trim() : text;
}
