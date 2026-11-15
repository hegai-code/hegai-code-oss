import { useState } from 'react';

/**
 * Copy-to-clipboard with a confirmation that fades.
 *
 * Extracted because three screens hand out a pasteable command — the model
 * gateway keys on `/access`, the app install page, and Settings — and each had
 * grown, or was about to grow, its own copy of the same six lines.
 *
 * `className` is a prop rather than fixed because the install page wants the
 * command's copy button to be the primary action of its card, while inside a
 * settings card it sits beside other plain buttons.
 */
export function CopyButton({
  text,
  label = 'Скопировать',
  className = 'btn',
  children,
}: {
  text: string;
  label?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return <button
    className={className}
    onClick={async () => {
      // The clipboard API rejects outside a secure context and when the
      // permission is denied — both real on a plain-http dev host. The old
      // inline copies awaited it unguarded, so that turned into an unhandled
      // rejection and a button that appeared to do nothing at all. Saying so is
      // the point: the command is right there to select by hand.
      try {
        await navigator.clipboard.writeText(text);
        setState('done');
      } catch {
        setState('failed');
      }
      window.setTimeout(() => setState('idle'), 1800);
    }}
  >
    {state === 'idle' && children}
    {state === 'done' ? 'Скопировано' : state === 'failed' ? 'Выделите и скопируйте' : label}
  </button>;
}
