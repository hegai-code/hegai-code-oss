import { FONT_STEPS, setFontScale, stepFontScale, useFontScale } from '../fontScale.js';

/** «−  110%  +» — the text size (fontScale.ts). The number resets to 100%. */
export function FontScalePicker() {
  const scale = useFontScale();
  const min = scale <= FONT_STEPS[0];
  const max = scale >= FONT_STEPS[FONT_STEPS.length - 1]!;
  return (
    <div className="sp-theme font-scale" role="group" aria-label="Размер шрифта">
      <button type="button" onClick={() => stepFontScale(-1)} disabled={min} aria-label="Мельче" title="Мельче (⌘/Ctrl −)">
        −
      </button>
      <button
        type="button"
        className={scale === 1 ? '' : 'on'}
        onClick={() => setFontScale(1)}
        title="Сбросить (⌘/Ctrl 0)"
        aria-label={`Размер шрифта ${Math.round(scale * 100)}%, сбросить`}
      >
        {Math.round(scale * 100)}%
      </button>
      <button type="button" onClick={() => stepFontScale(1)} disabled={max} aria-label="Крупнее" title="Крупнее (⌘/Ctrl +)">
        +
      </button>
    </div>
  );
}
