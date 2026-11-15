import type { Enrichment } from '@cc-remote/shared';
import { Lightbulb } from '../icons.js';

/** One line above the buttons: is the agent done, or waiting on you? Buttons
 *  alone did not say, and «Сделай оба» under a finished report read as
 *  unfinished work (10.10.2026). A status, not a summary — see below. */
/** The hub returns at most this many; a longer (older cached) list is cut here. */
const MAX_REPLIES = 3;

const HANDOFF_HEAD: Record<NonNullable<Enrichment['handoff']>, string> = {
  done: 'Готово. Дальше — по желанию:',
  question: 'Ждёт вашего ответа:',
  blocked: 'Без тебя не продолжит:',
};

/**
 * The strip under the transcript's tail turn: one tap that moves the session.
 *
 * It used to open with the turn's takeaways under a mono «итог» kicker. That
 * was a summary of the paragraph directly above it, on the screen where the
 * paragraph is already being read — it cost vertical space on a phone and told
 * nobody anything. The buttons were always the part that earned the strip.
 *
 * Two rows, because the buttons are not one kind of thing. `answer` and `next`
 * continue the thread — the reply to the question just asked, the step this
 * work implies. `idea` proposes something nobody asked for; it sits in its own
 * row and a tap only DROPS ITS TEXT INTO THE COMPOSER (since 13.10.2026) —
 * the person reads, edits and sends it. Starting a tangent in one tap is how
 * somebody fires work meaning to agree.
 *
 * Pure view — deciding WHEN it shows and where a tap sends belongs to the panel
 * that mounts it (Chat sends into the run/resume; Mirror force-takes over).
 */
export function EnrichStrip({
  enrichment,
  onReply,
  onDraft,
  replyTitle,
}: {
  enrichment: Enrichment;
  onReply: (send: string) => void;
  /** Where an `idea` goes: into the composer draft, NOT to the agent. Absent =
   *  the panel has no composer to put it in (the mirror), so ideas are not
   *  rendered at all — a tap there force-takes the session, a heavy price for
   *  a tangent. */
  onDraft?: (text: string) => void;
  /** Tooltip for a reply button — the mirror warns about the force-take here. */
  replyTitle?: (send: string) => string;
}) {
  // The button shows what it sends. The hub guarantees label === send; this is
  // the belt for annotations cached before it did — showing `label` while
  // sending `send` is what made the old strip scary to tap. At most three.
  const all = (enrichment.quickReplies ?? [])
    .filter((r) => r.label && r.send)
    .slice(0, MAX_REPLIES)
    // The button shows `send` exactly as it will go — trimmed, nothing else.
    // The hub already undressed it; peeling quotes here as well cut the closing
    // half of «Скрыть» off a message that legitimately ended with it.
    .map((r) => ({ kind: r.kind, text: r.send.trim() }))
    .filter((r) => r.text);
  // Absent `kind` means `answer` — see the protocol note. That default is what
  // keeps a hub that predates the field rendering exactly as it used to.
  const ideas = onDraft ? all.filter((r) => r.kind === 'idea') : [];
  const moves = all.filter((r) => r.kind !== 'idea');
  if (!moves.length && !ideas.length) return null;
  const head = enrichment.handoff ? HANDOFF_HEAD[enrichment.handoff] : undefined;
  return (
    <div className="enrich-strip">
      {head && <div className="enrich-head">{head}</div>}
      {moves.length > 0 && (
        <div className="enrich-replies">
          {moves.map((r, i) => (
            <button
              key={i}
              className={`qr-btn ${i === 0 ? 'primary' : 'quiet'}`}
              onClick={() => onReply(r.text)}
              title={replyTitle ? replyTitle(r.text) : r.text}
            >
              {r.text}
            </button>
          ))}
        </div>
      )}
      {ideas.length > 0 && (
        <div className="enrich-ideas">
          <Lightbulb size={13} className="ei-mark" aria-hidden />
          {ideas.map((r, i) => (
            <button
              key={i}
              className="qr-btn idea"
              onClick={() => onDraft?.(r.text)}
              title="Добавить в поле ввода — не отправляется"
            >
              {r.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
