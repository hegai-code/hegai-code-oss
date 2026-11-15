import { useEffect, useRef, type ReactNode } from 'react';
import { X } from '../icons.js';

/**
 * A sheet that slides in from the right over a scrim («шторка»): the
 * sub-agent's transcript (`SubagentTranscript`) and the cloud browser
 * (`BrowserSheet`). One markup so the two read as the same kind of thing:
 * head with the title, an optional quiet word, extras and ✕; the scrim and ✕
 * close it, and so does Escape unless the content needs that key.
 *
 * `wide` is for content that is a screen rather than a column of text — the
 * browser's 1440×900 picture is unreadable at the transcript's 760px measure.
 * On a phone (≤860px) both are full width.
 */
export function SideSheet({
  title,
  badge,
  onClose,
  wide = false,
  closeOnEscape = true,
  headExtra,
  bodyClassName = 'sa-sheet-body',
  children,
}: {
  title: string;
  /** A quiet word after the title («работает»). */
  badge?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /** A function is asked at the moment Escape is pressed — the browser says
   *  no while focus is in its remote screen, where Esc belongs to the page. */
  closeOnEscape?: boolean | (() => boolean);
  /** Controls between the title and ✕ (the browser's profile picker). */
  headExtra?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  // Read at keypress time: the handler is bound once, the answer is not.
  const escape = useRef(closeOnEscape);
  escape.current = closeOnEscape;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const allow = escape.current;
      if (typeof allow === 'function' ? allow() : allow) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sa-sheet-scrim" onClick={onClose}>
      <div
        className={`sa-sheet${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sa-sheet-head">
          <span className="sa-sheet-title">{title}</span>
          {badge != null && badge !== false && <span className="sa-word">{badge}</span>}
          {headExtra}
          <button type="button" className="sa-close" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>
        <div className={bodyClassName}>{children}</div>
      </div>
    </div>
  );
}
