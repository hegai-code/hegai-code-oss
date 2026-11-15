import { PaletteIcon } from './icons.js';
import { ThemePicker } from './components/ThemePicker.js';
import { FontScalePicker } from './components/FontScalePicker.js';
import type { ThemePref } from './useTheme.js';

/** Настройки → Вид. The same four picks as the account popover, with a word on
 *  what each one is — the popover has no room to say that VS Code is more than
 *  a colour change. Stored per browser (`cc-theme`), never on the hub. */
export function Appearance({ pref, onChoose }: { pref: ThemePref; onChoose: (v: ThemePref) => void }) {
  return (
    <div className="appearance">
      <div className="board-head">
        <PaletteIcon size={20} />
        <h2>Вид</h2>
        <span className="sub">хранится в этом браузере</span>
      </div>
      <div className="sp-row appearance-pick">
        <span className="sp-label">Тема</span>
        <ThemePicker value={pref} onChoose={onChoose} />
      </div>
      <div className="sp-row appearance-pick">
        <span className="sp-label">Размер шрифта</span>
        <FontScalePicker />
        <span className="appearance-hint">Или ⌘/Ctrl «+», «−», «0» в любом месте приложения.</span>
      </div>
      <dl className="appearance-notes">
        <dt>Светлая и тёмная</dt>
        <dd>Основная тема Hegai Code.</dd>
        <dt>Системная</dt>
        <dd>Светлая или тёмная вслед за настройкой устройства.</dd>
        <dt>VS Code</dt>
        <dd>
          Solarized Light, шрифты и размеры как в редакторе, почти квадратные углы и закладки над каждой
          колонкой.
        </dd>
      </dl>
    </div>
  );
}
