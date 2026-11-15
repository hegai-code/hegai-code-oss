import { THEME_CHOICES, type ThemePref } from '../useTheme.js';

/** The theme radiogroup — the account popover and the settings «Вид» tab show
 *  the same four picks from the same list. */
export function ThemePicker({ value, onChoose }: { value: ThemePref; onChoose: (v: ThemePref) => void }) {
  return (
    <div className="sp-theme" role="radiogroup" aria-label="Тема">
      {THEME_CHOICES.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? 'on' : ''}
          onClick={() => onChoose(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
