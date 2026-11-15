import { useSyncExternalStore } from 'react';
import { storageGet, storageRemove, storageSet } from './storage.js';

/**
 * Text size, per browser (29.09.2026, by request): «+» and «−» in Настройки →
 * Вид and in the account popover, and ⌘/Ctrl «+», «−», «0» anywhere — the
 * editor's own zoom keys, taken from the browser's page zoom on purpose.
 *
 * It scales the TYPE only — the `--size-*` ladder every text rule reads — not
 * the layout: panes, paddings and targets keep their size, so a bigger font
 * does not shrink how much fits beside it. The few px sizes left in the
 * stylesheet are initials inside fixed avatars and the public landing, which
 * should not grow anyway.
 *
 * The ladder differs per theme (VS Code has its own) and per pointer (touch
 * reads 16px body), so the scaled values cannot live in CSS: they are
 * computed from whatever the stylesheet says right now and written inline on
 * <html>, and recomputed when the theme or the pointer changes.
 */

const KEY = 'cc-font-scale';
export const FONT_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

const TOKENS = [
  '--size-screen',
  '--size-page',
  '--size-title',
  '--size-lead',
  '--size-card',
  '--size-body',
  '--size-small',
  '--size-nav',
  '--size-meta',
  '--size-micro',
  '--size-nano',
] as const;

const DOM = typeof window !== 'undefined' && typeof document !== 'undefined';

function read(): number {
  const v = Number(storageGet(KEY));
  return FONT_STEPS.includes(v as (typeof FONT_STEPS)[number]) ? v : 1;
}

let scale = DOM ? read() : 1;
const subs = new Set<() => void>();

function paint() {
  if (!DOM) return;
  const root = document.documentElement;
  // Clear first, so what is read back is the stylesheet's own ladder.
  for (const t of TOKENS) root.style.removeProperty(t);
  if (scale === 1) return;
  const cs = getComputedStyle(root);
  for (const t of TOKENS) {
    const px = parseFloat(cs.getPropertyValue(t));
    if (px > 0) root.style.setProperty(t, `${Math.round(px * scale * 10) / 10}px`);
  }
}

export function getFontScale(): number {
  return scale;
}

export function setFontScale(next: number) {
  const v = FONT_STEPS.reduce((best, s) => (Math.abs(s - next) < Math.abs(best - next) ? s : best), 1 as number);
  if (v === scale) return;
  scale = v;
  // Storage unavailable — the size still holds for this page.
  if (v === 1) storageRemove(KEY);
  else storageSet(KEY, String(v));
  paint();
  for (const fn of subs) fn();
}

/** One step up or down the ladder; 0 = back to 100%. */
export function stepFontScale(dir: -1 | 0 | 1) {
  if (dir === 0) return setFontScale(1);
  const i = FONT_STEPS.indexOf(scale as (typeof FONT_STEPS)[number]);
  const j = Math.max(0, Math.min(FONT_STEPS.length - 1, (i < 0 ? 2 : i) + dir));
  setFontScale(FONT_STEPS[j]!);
}

export function useFontScale(): number {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    getFontScale,
    getFontScale,
  );
}

if (DOM) {
  paint();
  // In dev the stylesheet is injected by a later import than this module's;
  // paint again once it is surely there (a no-op at 100%).
  requestAnimationFrame(paint);
  // The ladder under the scale changes with the theme and the pointer.
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(pointer: coarse)').addEventListener?.('change', paint);
  // ⌘/Ctrl «+» «−» «0». `=` is the unshifted «+» key; `Equal`/`Minus`/`Digit0`
  // codes cover layouts where the key's character is something else.
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const up = e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd';
    const down = e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract';
    const reset = e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0';
    if (!up && !down && !reset) return;
    e.preventDefault();
    stepFontScale(up ? 1 : down ? -1 : 0);
  });
}
