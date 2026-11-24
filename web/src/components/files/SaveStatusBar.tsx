import { X } from '../../icons.js';
import { type SaveState, saveStatusText } from '../../useFileSave.js';

/** The download line of the Files panel: progress, «Сохранить», or the error. */
export function SaveStatusBar({
  state,
  onSave,
  onDismiss,
}: {
  state: NonNullable<SaveState>;
  onSave: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={state.phase === 'error' ? 'files-err files-dl' : 'files-note files-dl'} role="status">
      <span>{saveStatusText(state)}</span>
      {state.phase === 'ready' ? (
        <button type="button" className="btn primary" onClick={onSave}>
          Сохранить
        </button>
      ) : null}
      {state.phase !== 'loading' ? (
        <button type="button" className="iconbtn" onClick={onDismiss} aria-label="Скрыть">
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}
