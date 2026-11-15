/** One note a reviewer left on a diff line. */
export interface ReviewComment {
  id: string;
  path: string;
  /** The line the note hangs on: the new-side number, or the old-side one for a removed line. */
  line: number;
  /** Removed line: the number is on the old side. */
  removed?: boolean;
  /** The line's text, so the agent can find it after the file moved on. */
  code: string;
  text: string;
}

/**
 * The ONE user turn a review becomes. Plain text on purpose: it goes through the
 * same path as anything typed in the composer, so the agent, the transcript on
 * every device and the history all see an ordinary message.
 */
export function buildReviewMessage(branch: string | undefined, comments: ReviewComment[]): string {
  const head = `Ревью изменений${branch ? ` (${branch})` : ''}:`;
  const rows = comments.map((c) => {
    const code = c.code.trim().replace(/`/g, "'").slice(0, 160);
    const where = `${c.path}:${c.line}${c.removed ? ' (удалённая строка)' : ''}`;
    // A multi-line note keeps its lines, indented under the bullet.
    const note = c.text.trim().replace(/\n+/g, '\n  ');
    return `- ${where} — \`${code}\` — ${note}`;
  });
  return [head, ...rows].join('\n');
}
