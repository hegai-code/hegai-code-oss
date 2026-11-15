import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OWN_WINDOW_FLAG, goBack, goForward, linkProps, navigate, pathFor, useHistoryEnds, type Route } from '../router.js';
import { THEME_CHOICES, type ThemePref } from '../useTheme.js';
import { stepFontScale } from '../fontScale.js';
import { DESTINATIONS } from './navModel.js';
import { ownWindowsSafe } from './useSessionMenu.js';
import { windowsShell } from './WindowChrome.js';

/** What the Windows shell 0.1.27+ lets the menu ask of it (`APP_BRIDGE` in
 *  windows/src-tauri/src/main.rs, `appmenu.rs`). Absent in older shells, which
 *  then simply get no «Выход» and no «Справка». */
interface AppShell {
  version: string;
  quit: () => Promise<unknown>;
  updateRow: () => Promise<{ label: string; enabled: boolean }>;
  update: () => Promise<unknown>;
}

type EditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

/**
 * «Правка», done by the page itself on whatever has focus — which is still the
 * composer, since a menu press never takes focus. Chromium honours these
 * commands on text fields; cut and copy ride the click's user activation.
 * «Вставить» reads the clipboard through the clipboard API, so WebView2 asks
 * the person before the page may read it: the shell deliberately does NOT
 * press Ctrl+V for the page (review, 13.10.2026) — a page that can trigger a
 * paste into a field of its own reads the clipboard whenever it likes.
 */
function runEdit(action: EditAction) {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (action !== 'paste') {
    document.execCommand(action);
    return;
  }
  void navigator.clipboard
    ?.readText()
    .then((text) => {
      // A permission prompt can move focus; put it back where the caret was.
      if (target && document.activeElement !== target) target.focus();
      document.execCommand('insertText', false, text);
    })
    .catch(() => {});
}

function appShell(): AppShell | null {
  if (typeof window === 'undefined') return null;
  return (window as { __HEGAI_APP__?: AppShell }).__HEGAI_APP__ ?? null;
}

/**
 * «Файл · Правка · Вид · Перейти · Справка» — the menu bar of the Windows app
 * (13.10.2026, by request: the frameless title bar read as a web page, not as
 * a program).
 *
 * Drawn only inside the Windows shell, where the page owns the whole frame. A
 * browser has its own menus, and on the Mac the system menu bar is the place.
 *
 * Every row calls something the app already does — the menu adds no ability,
 * only the place a Windows user looks for it. The two rows the page cannot
 * honour on its own — «Выход» and the update row — go through the shell's
 * own bridge (`__HEGAI_APP__`, 0.1.27+), and are absent rather than broken in
 * an older shell, which then has no «Выход» and no «Справка».
 *
 * Behaves like a native menu bar: a press does NOT take focus from the
 * composer (`mousedown` is prevented), hovering moves between open menus, the
 * arrows walk rows and menus, Enter runs, Esc and a press outside close, and
 * Alt or F10 alone opens the first menu.
 */

type Row =
  | { kind: 'item'; label: string; hint?: string; run: () => void; disabled?: boolean; checked?: boolean; radio?: boolean; route?: Route }
  | { kind: 'head'; label: string }
  | { kind: 'sep' };

interface Menu {
  label: string;
  rows: Row[];
}

export function MenuBar({
  onNewChat,
  onOpenPalette,
  sidebarCollapsed,
  onToggleSidebar,
  themePref,
  onChooseTheme,
}: {
  onNewChat?: () => void;
  onOpenPalette?: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  themePref: ThemePref;
  onChooseTheme: (pref: ThemePref) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const ends = useHistoryEnds();
  const win = windowsShell();
  const app = appShell();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [updateRow, setUpdateRow] = useState<{ label: string; enabled: boolean } | null>(null);
  const edit = (action: EditAction) => () => runEdit(action);

  const item = (label: string, run: () => void, extra: Partial<Extract<Row, { kind: 'item' }>> = {}): Row => ({
    kind: 'item',
    label,
    run,
    ...extra,
  });
  const sep: Row = { kind: 'sep' };

  const menus: Menu[] = [
    {
      label: 'Файл',
      rows: [
        ...(onNewChat ? [item('Новый чат', onNewChat)] : []),
        ...(ownWindowsSafe()
          ? [item('Новый чат в новом окне', () => {
              window.open(`${pathFor({ kind: 'new' })}?${OWN_WINDOW_FLAG}=1`, '_blank', 'noopener');
            })]
          : []),
        sep,
        item('Настройки', () => navigate({ kind: 'settings', tab: 'overview' })),
        ...(win
          ? [sep, item('Свернуть', () => void win.minimize()), item('Закрыть окно', () => void win.close(), { hint: 'Alt+F4' })]
          : []),
        // Closing the window only hides it to the tray; this is the real quit.
        // The shell asks «Выйти?» in a dialog of its own; «Отмена» rejects.
        ...(app ? [sep, item('Выход', () => void app.quit().catch(() => {}))] : []),
      ],
    },
    {
          label: 'Правка',
          rows: [
            item('Отменить', edit('undo'), { hint: 'Ctrl+Z' }),
            item('Повторить', edit('redo'), { hint: 'Ctrl+Y' }),
            sep,
            item('Вырезать', edit('cut'), { hint: 'Ctrl+X' }),
            item('Копировать', edit('copy'), { hint: 'Ctrl+C' }),
            item('Вставить', edit('paste'), { hint: 'Ctrl+V' }),
            sep,
            item('Выделить всё', edit('selectAll'), { hint: 'Ctrl+A' }),
          ],
    },
    {
      label: 'Вид',
      rows: [
        item('Боковая панель', onToggleSidebar, { checked: !sidebarCollapsed }),
        sep,
        { kind: 'head', label: 'Тема' },
        ...THEME_CHOICES.map(([pref, label]) => item(label, () => onChooseTheme(pref), { checked: themePref === pref, radio: true })),
        sep,
        item('Крупнее', () => stepFontScale(1), { hint: 'Ctrl+=' }),
        item('Мельче', () => stepFontScale(-1), { hint: 'Ctrl+−' }),
        item('Обычный размер', () => stepFontScale(0), { hint: 'Ctrl+0' }),
        sep,
        item('Обновить страницу', () => location.reload()),
      ],
    },
    {
      label: 'Перейти',
      rows: [
        item('Назад', goBack, { hint: 'Alt+←', disabled: !ends.back }),
        item('Вперёд', goForward, { hint: 'Alt+→', disabled: !ends.forward }),
        ...(onOpenPalette ? [sep, item('Найти…', onOpenPalette, { hint: 'Ctrl+K' })] : []),
        sep,
        // Places are links (`linkProps`), as everywhere the DESTINATIONS are
        // drawn — modified clicks go to the shell's own link policy.
        ...DESTINATIONS.map((d) => item(d.label, () => navigate(d.route), { route: d.route })),
      ],
    },
    ...(app
      ? [{
          label: 'Справка',
          rows: [
            // The tray's update row, word for word: «Проверить обновления»,
            // «Загружаю обновление — 40 %», «Установить 0.1.28»… Read fresh
            // each time this menu opens; pressing it is the tray's press.
            item(updateRow?.label ?? 'Проверить обновления', () => void app.update().catch(() => {}), {
              disabled: updateRow ? !updateRow.enabled : false,
            }),
            sep,
            item('О программе Hegai Code', () => setAboutOpen(true)),
          ],
        } satisfies Menu]
      : []),
  ];

  // Leading/trailing/doubled separators collapse: a row that only exists in
  // some shells (new window, minimise) must not leave a stray line behind.
  for (const m of menus) {
    m.rows = m.rows.filter((r, i, all) => r.kind !== 'sep' || (i > 0 && i < all.length - 1 && all[i - 1]!.kind !== 'sep'));
  }

  const runnable = (rows: Row[]) =>
    rows.map((r, i) => (r.kind === 'item' && !r.disabled ? i : -1)).filter((i) => i >= 0);

  const close = () => {
    setOpen(null);
    setActive(-1);
  };

  const openMenu = (i: number, firstRow: boolean) => {
    const n = (i + menus.length) % menus.length;
    setOpen(n);
    setActive(firstRow ? (runnable(menus[n]!.rows)[0] ?? -1) : -1);
  };

  const run = (r: Row) => {
    if (r.kind !== 'item' || r.disabled) return;
    close();
    r.run();
  };

  const helpOpen = open !== null && menus[open]?.label === 'Справка';
  useEffect(() => {
    if (!helpOpen || !app) return;
    let alive = true;
    void app.updateRow().then((r) => alive && setUpdateRow(r)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [helpOpen, app]);

  // Alt or F10 on its own opens the menu bar, as in every Windows program.
  // «On its own» is the whole rule: Alt+Shift switches the keyboard layout in
  // half the offices this ships to, Alt+← is Back, Alt+Tab leaves — any other
  // key, a press, or the window losing focus between down and up disarms it.
  // The listener is installed once; the ref hands it this render's toggle.
  const toggleRef = useRef(() => {});
  toggleRef.current = () => {
    // Not while the bar is hidden (a narrow window drops it): a menu nobody can
    // see would still swallow every key.
    if (!rootRef.current?.offsetParent) return;
    // A modal owns the keyboard: the menu would open UNDER its backdrop (the
    // bar's stacking context is z 30) and then swallow every key blind.
    if (open === null && document.querySelector('.cmdk-backdrop, .modal-backdrop, [aria-modal="true"]')) return;
    if (open !== null) close();
    else openMenu(0, true);
  };
  useEffect(() => {
    let armed = false;
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        // A held Alt auto-repeats; that is still Alt on its own.
        if (!e.repeat) armed = !(e.shiftKey || e.ctrlKey || e.metaKey);
        return;
      }
      armed = false;
      if (e.key === 'F10' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggleRef.current();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !armed) return;
      armed = false;
      e.preventDefault();
      toggleRef.current();
    };
    const disarm = () => {
      armed = false;
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('pointerdown', disarm, true);
    window.addEventListener('blur', disarm);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('pointerdown', disarm, true);
      window.removeEventListener('blur', disarm);
    };
  }, []);

  // While a menu is open it owns the keyboard — captured before the composer
  // sees the arrows, since focus deliberately stayed there.
  useEffect(() => {
    if (open === null) return;
    const rows = menus[open]!.rows;
    const order = runnable(rows);
    const onKey = (e: KeyboardEvent) => {
      // A modal that arrived while the menu was open (an approval) owns the
      // keyboard now; a menu left under its backdrop would eat its Enter.
      if (document.querySelector('.cmdk-backdrop, .modal-backdrop, [aria-modal="true"]')) {
        close();
        return;
      }
      const step = (dir: 1 | -1) => {
        if (!order.length) return;
        const at = order.indexOf(active);
        setActive(order[at < 0 ? (dir > 0 ? 0 : order.length - 1) : (at + dir + order.length) % order.length]!);
      };
      let handled = true;
      switch (e.key) {
        case 'Escape': close(); break;
        case 'ArrowDown': step(1); break;
        case 'ArrowUp': step(-1); break;
        case 'ArrowRight': openMenu(open + 1, true); break;
        case 'ArrowLeft': openMenu(open - 1, true); break;
        case 'Home': setActive(order[0] ?? -1); break;
        case 'End': setActive(order[order.length - 1] ?? -1); break;
        case 'Enter':
        case ' ': {
          const r = rows[active];
          if (r) run(r);
          break;
        }
        case 'Tab': close(); handled = false; break;
        default: handled = e.key !== 'Alt';
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Focus stays in the composer on purpose; point assistive tech from there
    // at the highlighted row, as a combobox does.
    const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    if (focused && active >= 0) focused.setAttribute('aria-activedescendant', `menubar-row-${active}`);
    const onPress = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      focused?.removeAttribute('aria-activedescendant');
    };
  });

  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const btn = open !== null ? btnRefs.current[open] : null;
  const left = btn ? btn.offsetLeft : 0;

  return (
    <>
    {/* Into <body>: inside the bar it would live in the bar's stacking
        context (z 30) rather than the app's modal layer. */}
    {aboutOpen && app && createPortal(<AboutDialog version={app.version} onClose={() => setAboutOpen(false)} />, document.body)}
    <div className="menubar" ref={rootRef}>
      <div className="menubar-row" role="menubar" aria-label="Меню приложения">
      {menus.map((m, i) => (
        <button
          key={m.label}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          type="button"
          className={`menubar-btn ${open === i ? 'open' : ''}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === i}
          aria-controls={open === i ? `menubar-pop-${i}` : undefined}
          onMouseDown={keepFocus}
          onClick={() => (open === i ? close() : openMenu(i, false))}
          onMouseEnter={() => {
            if (open !== null && open !== i) openMenu(i, false);
          }}
        >
          {m.label}
        </button>
      ))}
      </div>
      {open !== null && (
        <div id={`menubar-pop-${open}`} className="menubar-pop" role="menu" aria-label={menus[open]!.label} style={{ left }} onMouseDown={keepFocus}>
          {menus[open]!.rows.map((r, i) =>
            r.kind === 'sep' ? (
              <div key={`s${i}`} className="menubar-sep" role="separator" />
            ) : r.kind === 'head' ? (
              <div key={`h${i}`} className="menubar-head" role="presentation">{r.label}</div>
            ) : r.route ? (
              <a
                key={`${r.label}${i}`}
                id={`menubar-row-${i}`}
                className={`menubar-item ${active === i ? 'active' : ''}`}
                role="menuitem"
                {...linkProps(r.route)}
                onMouseEnter={() => setActive(i)}
                onClick={(e) => {
                  close();
                  linkProps(r.route!).onClick(e);
                }}
              >
                <span className="menubar-check" aria-hidden />
                <span className="menubar-label">{r.label}</span>
              </a>
            ) : (
              <button
                key={`${r.label}${i}`}
                type="button"
                className={`menubar-item ${active === i ? 'active' : ''}`}
                id={`menubar-row-${i}`}
                role={r.checked === undefined ? 'menuitem' : r.radio ? 'menuitemradio' : 'menuitemcheckbox'}
                aria-checked={r.checked}
                disabled={r.disabled}
                onMouseEnter={() => setActive(r.disabled ? -1 : i)}
                onClick={() => run(r)}
              >
                <span className="menubar-check" aria-hidden>
                  {r.checked && (
                    <svg width="12" height="12" viewBox="0 0 12 12">
                      <path d="M2.5 6.2l2.4 2.4 4.6-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="menubar-label">{r.label}</span>
                {r.hint && <span className="menubar-hint">{r.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
    </>
  );
}

/** «О программе»: what this program is and which version of it is installed —
 *  the one fact a person reporting a problem is asked first. The interface
 *  itself comes from the site and is always current; only the shell has a
 *  version of its own. */
function AboutDialog({ version, onClose }: { version: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about-modal" role="dialog" aria-modal="true" aria-label="О программе" onClick={(e) => e.stopPropagation()}>
        <AppMark size={48} />
        <div className="about-name">Hegai Code</div>
        <div className="about-version">Версия приложения {version}</div>
        <p className="about-note">
          Интерфейс приходит с code.acme.test и всегда свежий. Само приложение раз в несколько часов проверяет
          обновления и предлагает их — установить можно из «Справка» или из значка в трее.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn primary" autoFocus onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

/** The product mark at the left end of the Windows title bar, where every
 *  Windows program shows its icon. Drawn inline (the favicon's own shapes) so
 *  it needs no request and never shows a broken image while the shell loads. */
export function AppMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="app-mark" width={size} height={size} viewBox="0 0 128 128" aria-hidden>
      <rect width="128" height="128" rx="30" fill="#06463d" />
      <g transform="translate(64 64) scale(0.8)" fill="#fcfaf1">
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => (
          <rect key={deg} x="-5.5" y="9" width="11" height={i % 2 ? 29 : 42} rx="5.5" transform={`rotate(${deg})`} />
        ))}
      </g>
    </svg>
  );
}
