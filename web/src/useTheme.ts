import { useCallback, useEffect, useState } from 'react';
import { storageGet, storageSet } from './storage.js';

/** What the user picked. `system` follows the OS live. */
export type ThemePref = 'light' | 'dark' | 'system' | 'vscode';
/** What actually gets applied to <html data-theme>. `vscode` is a light skin
 *  of its own (Solarized Light, VS Code type and radii) — see the
 *  `[data-theme="vscode"]` block at the end of styles.css. */
export type Theme = 'light' | 'dark' | 'vscode';

/** Every pick, in the order a picker shows them. One list so the account
 *  popover, the settings tab and the phone drawer cannot disagree. */
export const THEME_CHOICES: readonly (readonly [ThemePref, string])[] = [
  ['light', 'Светлая'],
  ['dark', 'Тёмная'],
  // «Системная», not «Как в системе»: four labels share a 300px popover, and
  // the long one was clipped mid-word (29.09.2026). The phone drawer already
  // said «Системная».
  ['system', 'Системная'],
  ['vscode', 'VS Code'],
];

const KEY = 'cc-theme';
/** Must track `--bg` in each theme: this paints the browser/OS chrome around the
 *  app (the mobile address bar, the PWA title bar), and a mismatch reads as a
 *  seam across the top of the window. Light came off the ivory with the rest of
 *  the canvas — see the `--paper` ramp in styles.css. */
const META = { light: '#f6f7f6', dark: '#181a1b', vscode: '#fdf6e3' } as const;

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function readPref(): ThemePref {
  const v = storageGet(KEY);
  return v === 'dark' || v === 'system' || v === 'vscode' ? v : 'light';
}
function resolve(pref: ThemePref): Theme {
  return pref === 'system' ? systemTheme() : pref;
}
function paint(resolved: Theme) {
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[resolved]);
}

/** Light / dark / system theme with a persisted 3-way toggle and a brief
 *  cross-fade on change. Default is light; `system` follows the OS live. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const [theme, setTheme] = useState<Theme>(() => resolve(readPref()));

  // In `system` mode, follow OS theme changes while the tab is open.
  useEffect(() => {
    const r = resolve(pref);
    setTheme(r);
    paint(r);
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const next = systemTheme();
      setTheme(next);
      paint(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const cycle = useCallback(() => {
    // brief color cross-fade: a temporary class widens transitions for ~260ms
    const root = document.documentElement;
    root.classList.add('theme-transition');
    window.setTimeout(() => root.classList.remove('theme-transition'), 260);
    // A FLIP of what is on screen, not a walk round light → dark → system.
    // The walk had a dead step: whenever the next stop resolved to the theme
    // already showing (system → light on a light OS), a press changed nothing
    // and it took a second one to see anything (25.09.2026). One press, the
    // other theme — the choice is then explicit and survives an OS change.
    // With the VS Code skin it is a walk over what is SHOWN: light → dark →
    // vscode → light, so every press still changes the screen.
    setPref((prev) => {
      const shown = resolve(prev);
      const next: ThemePref = shown === 'light' ? 'dark' : shown === 'dark' ? 'vscode' : 'light';
      storageSet(KEY, next);
      return next;
    });
  }, []);

  /** An explicit pick from Настройки — light, dark or «как в системе». */
  const choose = useCallback((next: ThemePref) => {
    const root = document.documentElement;
    root.classList.add('theme-transition');
    window.setTimeout(() => root.classList.remove('theme-transition'), 260);
    storageSet(KEY, next);
    setPref(next);
  }, []);

  return { pref, theme, cycle, choose };
}
