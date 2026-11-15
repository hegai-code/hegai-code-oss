import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** One row of a context menu. `danger` paints the destructive one red. */
export interface MenuAction<T> {
  label: string;
  run: (target: T) => void;
  /** Hide the row for targets it does not apply to. */
  when?: (target: T) => boolean;
  /** Draw it, but refuse it — with a reason on hover. A missing row raises
   *  "where did it go"; a disabled one answers it. */
  disabled?: (target: T) => string | false | undefined;
  danger?: boolean;
  /** A hairline above this row. Destructive actions do not sit flush against
   *  the ones you press by habit. */
  separated?: boolean;
  /** A 16px glyph before the label — the project menu draws them, ChatGPT-style. */
  icon?: ReactNode;
}

/** Where a menu was summoned, and on what. */
export interface MenuAt<T> {
  target: T;
  x: number;
  y: number;
}

/**
 * The right-click menu, once.
 *
 * It was written by hand twice inside the file manager — the list view owned
 * one (`FileList`) and the icon view raised coordinates for the parent to draw
 * another (`Files`) — and the session list was about to be the third. All three
 * want the same four behaviours and get them wrong in different orders: close
 * on an outside click, close on Escape, close when the thing underneath
 * changes, and do not open past the edge of the window.
 *
 * That last one is why this is a component and not a style. A menu summoned
 * near the bottom of the screen has to flip ABOVE the pointer, and knowing
 * whether it must means measuring it after it is in the DOM — the layout effect
 * below. Both hand-rolled copies simply ran off-screen, which on the session
 * list (rows go all the way down a 900px column) would be the common case
 * rather than the corner one.
 *
 * It reuses `.ws-more-pop` / `.ws-more-item`, the popover styling the `<details>`
 * menus already use, so it is not a new visual language either.
 */
export function ContextMenu<T>({
  at,
  actions,
  onClose,
  label,
}: {
  at: MenuAt<T> | null;
  actions: MenuAction<T>[];
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure, then place. Rendered at the raw coordinates for one frame with
  // `visibility: hidden` (`.ctxmenu-measuring`), so nothing is ever painted in
  // the wrong spot.
  useLayoutEffect(() => {
    if (!at) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(at.x, window.innerWidth - width - pad));
    // Flip above the pointer rather than merely clamping: a menu pinned to the
    // bottom edge covers the row you right-clicked, and the first item lands
    // under the pointer where a stray click hits it.
    const top = at.y + height + pad > window.innerHeight
      ? Math.max(pad, at.y - height)
      : at.y;
    setPos({ left, top });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    // A menu anchored to viewport coordinates lies the moment anything scrolls
    // under it. `capture` because the scroller is a div, not the window.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [at, onClose]);

  if (!at) return null;
  const rows = actions.filter((a) => !a.when || a.when(at.target));
  if (!rows.length) return null;

  return (
    <div
      ref={ref}
      className={`ws-more-pop fl-ctx ctxmenu ${pos ? '' : 'ctxmenu-measuring'}`}
      style={{ left: pos?.left ?? at.x, top: pos?.top ?? at.y }}
      role="menu"
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((a) => {
        const why = a.disabled?.(at.target);
        return (
          <button
            key={a.label}
            type="button"
            role="menuitem"
            className={`ws-more-item${a.danger ? ' danger' : ''}${a.separated ? ' sep' : ''}`}
            disabled={!!why}
            title={why || undefined}
            onClick={() => {
              onClose();
              a.run(at.target);
            }}
          >
            {a.icon && <span className="ctx-ico" aria-hidden="true">{a.icon}</span>}
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Long-press → the same menu, for touch.
 *
 * A phone has no right button, and the session rows in the drawer are the one
 * place these actions were unreachable without opening the session first.
 * 500ms is the platform convention; the 10px slop is what stops a scroll-flick
 * from being read as a press — the drawer's list is the most-flicked surface in
 * the app, so without it every scroll would end in a menu.
 *
 * A plain function, not a hook, because the callers are row RENDERERS inside a
 * `.map()` — `sessionRow()` and `cardRow()` in ProjectList — and a hook there
 * would be called a different number of times per render. One press exists at a
 * time, so the timer can be module state.
 */
let pressTimer = 0;
let pressFrom: { x: number; y: number } | null = null;

function cancelPress() {
  window.clearTimeout(pressTimer);
  pressFrom = null;
}

export function longPressProps(onLongPress: (x: number, y: number) => void) {
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const { clientX: x, clientY: y } = t;
      pressFrom = { x, y };
      pressTimer = window.setTimeout(() => onLongPress(x, y), 500);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t || !pressFrom) return;
      if (Math.abs(t.clientX - pressFrom.x) > 10 || Math.abs(t.clientY - pressFrom.y) > 10) cancelPress();
    },
    onTouchEnd: cancelPress,
    onTouchCancel: cancelPress,
  };
}
