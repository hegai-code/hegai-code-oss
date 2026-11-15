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
