import type { HistoryMessage } from '@cc-remote/shared';

/** Time constant of the placeholder's bar. No percentage exists upstream (the
 *  generator reports nothing until the picture is whole), so the bar is the
 *  client's own clock: fast at first, never quite full. Same curve on iOS. */
export const GEN_TAU_MS = 28_000;
const GEN_CEILING = 0.92;

/** 0…0.92 — a bar that keeps moving for as long as the picture takes and
 *  never promises «done» before the event says so. */
export function genProgress(elapsedMs: number): number {
  const e = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return GEN_CEILING * (1 - Math.exp(-e / GEN_TAU_MS));
}

/** `m:ss`, the label's clock. */
export function genClock(elapsedMs: number): string {
  const secs = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** A download name from the prompt: its first words, lower-cased, `-`-joined;
 *  `image.png` when there is nothing to make a word of. */
export function genFileName(prompt?: string): string {
  const words = (prompt ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  let slug = '';
  for (const w of words.slice(0, 6)) {
    if ((slug ? `${slug}-${w}` : w).length > 40) break;
    slug = slug ? `${slug}-${w}` : w;
  }
  return `${slug || 'image'}.png`;
}

const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Decode a `data:` URL into a Blob, synchronously — a new tab has to be opened
 *  inside the click that asked for it, and `fetch(dataUrl)` would not be.
 *  Raster types only: a Blob URL inherits this app's origin, and the media type
 *  comes from a transcript, so an `image/svg+xml` or `text/html` one opened in a
 *  tab would run script as the viewer. Anything else → null (no button). */
export function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const type = (m[1] || 'image/png').toLowerCase();
  if (!RASTER_TYPES.has(type)) return null;
  try {
    const raw = m[2] ? atob(m[3]!) : decodeURIComponent(m[3]!);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}

/** The refs of every generated picture the loaded history already carries. */
export function generatedRefs(history: HistoryMessage[]): Set<string> {
  const refs = new Set<string>();
  for (const m of history)
    for (const b of m.blocks) if (b.kind === 'image' && b.generated && b.ref) refs.add(b.ref);
  return refs;
}

/**
 * Has the transcript an assistant reply after its last user message? A synthetic
 * message made only of generated pictures (the `hegai-image` ledger's) is NOT a
 * reply: counting it would let a reload decide the turn is on disk and drop the
 * live final answer that has not been written yet.
 */
export function hasAssistantReplyAfterLastUser(messages: HistoryMessage[]): boolean {
  const lastUser = messages.map((m) => m.type).lastIndexOf('user');
  return messages
    .slice(lastUser + 1)
    .some((m) => m.type === 'assistant' && !(m.blocks.length > 0 && m.blocks.every((b) => b.kind === 'image' && b.generated)));
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Does this page of the transcript hold the answer the screen is showing live?
 *
 * `hasAssistantReplyAfterLastUser` cannot tell a finished turn from a snapshot
 * taken in the middle of it: a turn with tools is assistant → tool result →
 * assistant…, so any mid-turn copy already has "an assistant message after the
 * last user one". The hub serves exactly such a copy for the first moments
 * after a turn ends — its replica counts as current until the agent publishes
 * the file's new mtime — and accepting it replaced the page with the turn as
 * it stood twenty seconds earlier and cleared the streamed answer (21.11.2026:
 * «Готово», 16 steps of 18, no answer until a reload).
 *
 * So the read is only as new as the screen if the last thing the agent SAID
 * live is in it. No live answer to look for (a turn that ended on a tool, a
 * viewer who attached late) — nothing to check, the older test decides alone.
 */
export function historyHoldsLiveAnswer(
  messages: HistoryMessage[],
  lines: ReadonlyArray<{ kind: string; text?: string }>,
): boolean {
  let answer = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.kind === 'user') break;
    if (l.kind === 'assistant' && squash(l.text ?? '')) {
      answer = squash(l.text ?? '');
      break;
    }
  }
  if (!answer) return true;
  // Only what follows the person's last words — an identical short answer
  // («Готово.») from an earlier turn is not this one. The person's turn is any
  // user message that is not a tool result: a picture with no words is one.
  let from = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === 'user' && !m.blocks.some((b) => b.kind === 'tool_result')) {
      from = i + 1;
      break;
    }
  }
  // The file's block IS what was shown: the final `assistant` event replaces
  // the streamed partial with the block's full text, so a turn that ended
  // normally matches exactly. Not `includes`/`startsWith` — a short «Готово.»
  // opens many a mid-turn «Готово. Теперь гоняю тесты…». A line frozen
  // mid-stream (a reconnect) never matches, and that is the safe side: the
  // read still lands after the polls run out, the live lines stay.
  // Known gaps, judged rare enough after three review rounds (21.11.2026): the
  // same words said twice in one turn, or an earlier turn ending in the same
  // words as this one seen by a pane that attached mid-turn.
  return messages
    .slice(from)
    .some((m) => m.type === 'assistant' && m.blocks.some((b) => b.kind === 'text' && squash(b.text) === answer));
}
