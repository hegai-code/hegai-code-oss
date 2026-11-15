// In-page replacements for window.confirm / prompt / alert.
//
// The Mac shell is a wry WKWebView that does not implement the WKUIDelegate
// JavaScript panels: there `confirm()` silently returns false, `prompt()`
// returns null and `alert()` shows nothing, so every action guarded by one
// was dead. These are imperative and promise-based so call sites keep their
// shape: `if (!(await askConfirm('…'))) return;`.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

export interface ConfirmOptions { confirmLabel?: string; danger?: boolean }

type Spec =
  | { kind: 'confirm'; message: string; confirmLabel: string; danger: boolean }
  | { kind: 'text'; message: string; initial: string }
  | { kind: 'notice'; message: string };

type Result = boolean | string | null | void;

/** What a key does inside a dialog: Esc cancels, Enter submits (not on a
 *  button, which handles its own Enter, and not with IME composition). */
export function dialogKeyAction(key: string, opts: { onButton?: boolean; composing?: boolean }): 'cancel' | 'submit' | null {
  if (key === 'Escape') return 'cancel';
  if (key === 'Enter' && !opts.onButton && !opts.composing) return 'submit';
  return null;
}

let seq = 0;

export function DialogView({ spec, id, onClose }: { spec: Spec; id?: string; onClose: (r: Result) => void }): ReactElement {
  const dialogId = id ?? 'dlg-0';
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(spec.kind === 'text' ? spec.initial : '');
  const cancelValue: Result = spec.kind === 'confirm' ? false : spec.kind === 'text' ? null : undefined;
  const submitValue = (): Result => (spec.kind === 'confirm' ? true : spec.kind === 'text' ? text : undefined);

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); } else primaryRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The dialog owns the keyboard: nothing typed here may reach the window's
    // shortcuts (⌘K would mount the palette UNDER the dialog and steal focus;
    // Esc would close the sheet beneath). Default actions — typing, copy,
    // paste — are untouched by stopping propagation.
    e.stopPropagation();
    const onButton = (e.target as HTMLElement).tagName === 'BUTTON';
    const act = dialogKeyAction(e.key, { onButton, composing: e.nativeEvent.isComposing || e.keyCode === 229 });
    if (act === 'cancel') { e.preventDefault(); e.stopPropagation(); onClose(cancelValue); return; }
    if (act === 'submit') { e.preventDefault(); e.stopPropagation(); onClose(submitValue()); return; }
    if (e.key === 'Tab') {
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button, input') ?? []);
      if (!items.length) return;
      const first = items[0]!; const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  const confirmLabel = spec.kind === 'confirm' ? spec.confirmLabel : spec.kind === 'text' ? 'Сохранить' : 'OK';
  const danger = spec.kind === 'confirm' && spec.danger;

  return (
    <div className={`modal-backdrop dialog-backdrop${spec.kind === 'text' ? ' dialog-backdrop-text' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(cancelValue); }} onKeyDown={onKeyDown}>
      <div
        ref={rootRef}
        className="modal dialog-modal"
        tabIndex={-1}
        role={spec.kind === 'text' ? 'dialog' : 'alertdialog'}
        aria-modal="true"
        aria-labelledby={`${dialogId}-msg`}
      >
        <div id={`${dialogId}-msg`} className="dialog-message">{spec.message}</div>
        {spec.kind === 'text' && (
          <input
            ref={inputRef}
            className="dialog-input"
            type="text"
            value={text}
            aria-label={spec.message.split('\n')[0]}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <div className="modal-actions">
          {spec.kind !== 'notice' && <button type="button" className="btn" onClick={() => onClose(cancelValue)}>Отмена</button>}
          <button ref={primaryRef} type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => onClose(submitValue())}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function open<T extends Result>(spec: Spec): Promise<T> {
  return new Promise<T>((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const previous = document.activeElement as HTMLElement | null;
    const id = `dlg-${++seq}`;
    let done = false;
    const close = (r: Result) => {
      if (done) return;
      done = true;
      root.unmount();
      host.remove();
      try { previous?.focus?.(); } catch { /* element is gone */ }
      resolve(r as T);
    };
    root.render(<DialogView spec={spec} id={id} onClose={close} />);
  });
}

export function askConfirm(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return open<boolean>({ kind: 'confirm', message, confirmLabel: opts.confirmLabel ?? 'OK', danger: !!opts.danger });
}

export function askText(message: string, initial = ''): Promise<string | null> {
  return open<string | null>({ kind: 'text', message, initial });
}

export function showNotice(message: string): Promise<void> {
  return open<void>({ kind: 'notice', message });
}
