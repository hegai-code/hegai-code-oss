import { useEffect, useRef, useState, type RefObject } from 'react';

/** The plate's height plus a breath: a question starting inside this band at
 *  the top of the transcript is already in view, so no plate over it. */
const BAND = 56;

/**
 * The question you are reading the answer to, pinned over the top of the
 * transcript (28.09.2026, by request — Claude's VS Code extension does this).
 *
 * A long answer scrolls its question away; this repeats that question — two
 * lines at most — for as long as its answer fills the top of the view, and a
 * click scrolls back to it. Human turns carry their text in `data-ask`
 * (render/Blocks.tsx), so this reads the DOM rather than the transcript model:
 * it has to agree with what is on screen, including the cached page and live
 * lines, and it is a child of its own so a scroll re-renders this plate only,
 * never the whole Chat.
 */
export function StickyAsk({ logRef }: { logRef: RefObject<HTMLDivElement | null> }) {
  const [ask, setAsk] = useState<{ text: string; index: number } | null>(null);
  const cur = useRef<{ text: string; index: number } | null>(null);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top = log.getBoundingClientRect().top;
      const els = log.querySelectorAll<HTMLElement>('[data-ask]');
      // Document order is top-to-bottom order: the last turn that ends above
      // the view's top edge is the one whose answer is under it.
      let pick = -1;
      for (let i = 0; i < els.length; i++) {
        if (els[i]!.getBoundingClientRect().bottom <= top + 4) pick = i;
        else break;
      }
      const next = pick >= 0 ? els[pick + 1] : undefined;
      const show = pick >= 0 && (!next || next.getBoundingClientRect().top > top + BAND);
      const value = show ? { text: els[pick]!.dataset.ask ?? '', index: pick } : null;
      const prev = cur.current;
      if (prev?.text === value?.text && prev?.index === value?.index) return;
      cur.current = value;
      setAsk(value);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    log.addEventListener('scroll', schedule, { passive: true });
    // New lines, a history page landing, a code block unfolding — each moves
    // the turns without a scroll event.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const inner = log.querySelector(':scope > .log-inner');
    if (ro && inner) ro.observe(inner);
    schedule();
    return () => {
      log.removeEventListener('scroll', schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [logRef]);

  if (!ask?.text) return <div className="sticky-ask-wrap" aria-hidden="true" />;
  const jump = () => {
    const log = logRef.current;
    const el = log?.querySelectorAll<HTMLElement>('[data-ask]')[ask.index];
    if (!log || !el) return;
    const delta = el.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
    log.scrollTo({ top: log.scrollTop + delta, behavior: 'smooth' });
  };
  return (
    <div className="sticky-ask-wrap">
      <button type="button" className="sticky-ask" onClick={jump} title="К вопросу">
        <span className="sticky-ask-text">{ask.text}</span>
      </button>
    </div>
  );
}
