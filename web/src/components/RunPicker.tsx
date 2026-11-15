import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretRight, CaretLeft, Lightning } from '../icons.js';
import { EFFORT_SHORT, effortTrack } from './run-settings.js';

/** The breath between the trigger and the panel — the same 6px the CSS opens
 *  with, repeated here because the desk placement writes the offset itself. */
const GAP = 6;
/** Never flush against the edge that would cut it. */
const EDGE = 8;
/** Below this a panel is not a menu, it is a slot — if neither side offers even
 *  this much, take the roomier one anyway and let it scroll. */
const MIN_PANEL = 140;

/**
 * Model and reasoning effort as ONE control — «Sonnet 4.6 · Среднее ›».
 *
 * They were two `<select>`s side by side, and that cost more than the width.
 * A focused `<select>` under 16px makes iOS Safari zoom the page and never zoom
 * back, so the composer's controls had to be set at 16px on a phone — which is
 * larger than the message text above them, for two settings that are a footnote
 * to it. A button has no such rule: it can be small because nothing focuses it
 * for text entry. So the pair became one button and a sheet, which is also what
 * the reference composer does.
 *
 * The two settings stay one control because they are one decision — «как
 * думать над этим сообщением» — and reading them together is the point: the
 * effort levels mean different things per model, and an effort the model cannot
 * take is not offered at all (`effortOff`).
 */
export function RunPicker({
  modelLabel,
  models,
  model,
  accountLabel,
  noAccountRow,
  effort,
  activeEffort,
  efforts,
  effortLabel,
  effortOff,
  allowUltracode,
  onModel,
  onEffort,
  plan,
}: {
  /** What the run reports it is on right now — the button's first half. */
  modelLabel: string;
  models: { id: string; name?: string }[];
  /** `''` means "not pinned on this session" — the account decides. */
  model: string;
  accountLabel: string;
  /** OpenCode has no account default to hand the choice back to. */
  noAccountRow?: boolean;
  effort: string;
  /** The level the run reports it is really using, when nothing was pinned.
   *  See `activeEffort` in shared/src/protocol.ts. */
  activeEffort?: string;
  efforts: readonly string[];
  effortLabel: Record<string, string>;
  /** This model takes no reasoning effort; the section is shown disabled
   *  rather than hidden, so its absence is explained rather than mysterious. */
  effortOff: boolean;
  allowUltracode: boolean;
  /* No permission mode here (27.09.2026, by request): this control is the
     model and the effort, nothing else. The mode had crept in as a third
     section and a third word on the button — «Opus 5.5 High No prompts» on
     every session, since every session runs without approvals — and said
     nothing a person was choosing. It lives in the session info panel
     (PermissionModePicker). */
  onModel: (v: string) => void;
  onEffort: (v: string) => void;
  /** «Режим планирования» as one switch (27.09.2026). The full mode list left
   *  this menu by request — only model and effort — and took plan mode with
   *  it, which was the one mode people reach for here. Omitted where the
   *  machine does not offer `plan`. */
  plan?: { on: boolean; onToggle: (on: boolean) => void };
}) {
  const [open, setOpen] = useState(false);
  /** The popover has two faces: the compact one, and the model list behind it. */
  const [page, setPage] = useState<'main' | 'models'>('main');
  /**
   * Where the thumb is WHILE it is being dragged.
   *
   * The committed value lives in the run, and a range input fires on every
   * pixel — sending `set_effort` per pixel would put a burst of frames on the
   * socket for one gesture. So the drag is local and the commit happens on
   * release; this clears itself once the run echoes the value back.
   */
  const [drag, setDrag] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  /** The desk popover. Placed from JS for the same reason the phone modal is:
   *  CSS can anchor a box, it cannot ask whether the box will be seen. */
  const pop = useRef<HTMLDivElement>(null);
  /**
   * Phone = a bottom SHEET, desk = the anchored popover.
   *
   * Read in JS rather than expressed in CSS because the two are not the same
   * box in the same place: the sheet has to be `position: fixed` against the
   * VIEWPORT, and `.chat` carries `container-type: inline-size`, which brings
   * layout containment — a fixed descendant would be positioned against that
   * container instead. So the sheet is rendered through a portal to `body`,
   * and a portal is a different tree, not a different rule.
   */
  const [phone, setPhone] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(max-width: 860px)');
    const sync = () => setPhone(mq.matches);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  /**
   * THE KEYBOARD MUST SURVIVE THIS CONTROL.
   *
   * On a phone this opens from the composer, which means it opens out of a
   * half-typed message with the keyboard up. A `<button>` takes focus when it
   * is tapped, the textarea loses it, and iOS closes the keyboard — so picking
   * an effort level threw away the typing position and left the message
   * stranded behind a dismissed keyboard. Two halves, and both are needed:
   *
   *   `holdFocus` — mousedown, not click. The default action of mousedown is
   *   the focus change itself, so cancelling it means focus never leaves the
   *   textarea and the keyboard never goes anywhere. Only on a phone, and only
   *   for the buttons: the effort SLIDER needs its default to drag at all.
   *
   *   `close` — the belt to that braces. iOS reopens a keyboard from
   *   `.focus()` only inside the user gesture that asked for it, so this is
   *   called straight from the click handlers and never from an effect
   *   reacting to `open`. If the mousedown trick ever stops holding, the field
   *   still comes back the moment the picker closes.
   *
   * Only a text entry is ever remembered. Anything else and we would be
   * restoring focus to our own trigger, which is where it already was.
   */
  const restore = useRef<HTMLElement | null>(null);
  const holdFocus = (e: React.MouseEvent) => {
    if (!phone) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) restore.current = el;
    e.preventDefault();
  };
  const close = useCallback(() => {
    setOpen(false);
    const el = restore.current;
    restore.current = null;
    // `isConnected`: the composer can fold, or the run can end, while this is
    // open. Focusing a node React has already unmounted throws away the focus
    // instead of restoring it.
    if (!phone || !el?.isConnected) return;
    el.focus({ preventScroll: true });
  }, [phone]);

  /**
   * CENTRE IT IN WHAT CAN BE SEEN, not in the viewport.
   *
   * This opens from the composer, which on a phone means the keyboard is up —
   * and a keyboard does not shrink the LAYOUT viewport, it overlays the VISUAL
   * one. `position: fixed` resolves against the layout viewport and `dvh`
   * against a viewport that iOS reports without asking the keyboard, so
   * `top: 50%` put the box's centre somewhere behind the keys: it floated up
   * the screen, clipped at the top edge, with the rows that mattered outside
   * the visible strip entirely. Shipped that way because it was designed on a
   * desk, where there is no keyboard to get it wrong.
   *
   * `visualViewport` is the only thing that knows where the visible strip
   * actually is. `offsetTop + height / 2` is that strip's centre expressed in
   * layout-viewport coordinates, which is exactly the space a fixed box is
   * positioned in. Its height also caps the modal, so a list too long for the
   * gap scrolls inside itself instead of growing out through the top.
   *
   * NOT the same thing as `useVisualViewport` in appHooks.ts, which is
   * reverted: that one resized the whole SHELL and collapsed it. This moves one
   * box that is already `position: fixed` and touches nothing else.
   */
  useEffect(() => {
    if (!open || !phone) return;
    const el = sheet.current;
    if (!el) return;
    const vv = window.visualViewport;
    const place = () => {
      const h = vv?.height ?? window.innerHeight;
      const top = (vv?.offsetTop ?? 0) + h / 2;
      el.style.top = `${Math.round(top)}px`;
      // 24 of breathing room, so the box never sits edge to edge with either
      // the clock above it or the keyboard below.
      el.style.maxHeight = `${Math.max(180, Math.round(h - 24))}px`;
    };
    place();
    if (!vv) return;
    // `scroll` as well as `resize`: iOS moves the visual viewport WITHOUT
    // resizing it when a focused field is scrolled into view above the
    // keyboard, and a box placed only on resize is left behind by that.
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    return () => {
      vv.removeEventListener('resize', place);
      vv.removeEventListener('scroll', place);
    };
  }, [open, phone]);

  /**
   * DESK: UPWARD IS A PREFERENCE, NOT A GUARANTEE.
   *
   * `.run-pick-pop` is anchored `bottom: 100%` — it grows up out of the
   * composer, which is right for both the session and the docked START screen.
   * The placement still measures real room: this same composer used to sit
   * near the TOP of the start scroller, where the panel landed 85px past its
   * clipping edge and lost the model row and effort ladder. Keeping the
   * measurement makes the picker safe in short windows and split panes too.
   *
   * `max-height: 60vh` did not save it, because a fraction of the viewport is
   * not the room above a trigger: the panel fits 60vh happily while sitting
   * half outside the box it is allowed to be seen in. So the room is measured.
   * Against every CLIPPING ancestor and not just the window — the start
   * screen's own scroller is the edge that cuts here, and its top is under the
   * top bar rather than at y=0.
   *
   * The panel then opens up when it fits up (or when up is the roomier side),
   * and flips down when it does not. Either way it is capped by the room on
   * the side it took, so a list too long for the gap scrolls inside itself
   * instead of growing out through an edge.
   *
   * A LAYOUT effect, not `useEffect`: it runs before paint, so the panel is
   * never shown in the wrong place first and corrected after.
   */
  useLayoutEffect(() => {
    if (!open || phone) return;
    const el = pop.current;
    const anchor = wrap.current;
    if (!el || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      // The box this panel may be SEEN in: the window, narrowed by every
      // ancestor that clips what overflows it.
      let top = 0;
      let bottom = window.innerHeight;
      for (let n = anchor.parentElement; n; n = n.parentElement) {
        // A computed `visible` is the only value that does not clip; when one
        // axis is hidden the other computes to `auto`, so this reading is
        // already the honest one.
        if (getComputedStyle(n).overflowY === 'visible') continue;
        const r = n.getBoundingClientRect();
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
      }
      // The TRIGGER itself can leave: the start screen scrolls under a fixed
      // top bar, and a panel still anchored to a control that has gone behind
      // it is a menu floating on its own, half cut by the same edge. A menu
      // whose control is gone has nothing to say — close it.
      if (a.bottom <= top || a.top >= bottom) {
        close();
        return;
      }
      const above = a.top - top - GAP - EDGE;
      const below = bottom - a.bottom - GAP - EDGE;
      const up = el.scrollHeight <= above || above >= below;
      el.style.maxHeight = `${Math.round(Math.max(MIN_PANEL, up ? above : below))}px`;
      el.style.bottom = up ? `calc(100% + ${GAP}px)` : 'auto';
      el.style.top = up ? 'auto' : `calc(100% + ${GAP}px)`;
    };
    place();
    window.addEventListener('resize', place);
    // Capture, because what moves this trigger is usually an ANCESTOR
    // scrolling — the start screen is its own scroller — and a scroll on an
    // element does not bubble to the window.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
    // `page` is a dependency because the model list is the TALLER face: a panel
    // that fitted above as the compact one may not fit as the list.
  }, [open, phone, page, close]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // BOTH boxes. The sheet lives in a portal, so it is not inside `wrap` —
      // testing only `wrap` would read every tap on a row as "outside", close
      // the sheet on mousedown, and destroy the row before its click could
      // land. That is the same failure that made this control untappable once
      // already; it is not getting a second go.
      if (wrap.current?.contains(e.target as Node)) return;
      if (sheet.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Unset effort names the CONTROL, never "default": the runtime only reports
  // `effort` once somebody sets it, so "default" would be neither a level nor
  // an answer.
  /**
   * The TRIGGER gets the short name; the list keeps the full one.
   *
   * Model names carry a parenthetical that matters when you are choosing —
   * «Opus (1M context)» — and is pure width once you have chosen. On the
   * button that parenthesis was most of the control, pushing the row it sits
   * in toward the mic and leaving «Opus (1M cont…» as the part you can read.
   * Dropped here rather than upstream so `models` rows still say it in full,
   * which is the one place the distinction is a decision.
   */
  const shortModel = modelLabel.replace(/\s*\([^)]*\)\s*$/, '').trim() || modelLabel;
  // Unset effort shows NOTHING. It used to print the bare noun «усилие», which
  // is a label for an empty value — a word that costs width to say that there
  // is nothing to say.
  /** The closed button names the level the session is ON, pinned or not —
   *  «показывать как сейчас». Provenance is not the question a glance asks. */
  const effortText = (() => {
    const level = effort || activeEffort || '';
    return level ? (effortLabel[level] ?? level) : '';
  })();
  /** The same level in a narrow pane: «высокое», «оч. выс.» — short enough
   *  to keep beside the model in a ~380px column instead of dropping it. */
  const effortShort = (() => {
    const level = effort || activeEffort || '';
    return level ? (EFFORT_SHORT[level] ?? effortText) : '';
  })();

  /**
   * The ladder is LEVELS ONLY. «По аккаунту» used to be stop zero and that was
   * a category error: it is a PROVENANCE — who chose — and the track measures
   * a magnitude. Sitting on the scale it answered "how much effort?" with
   * "someone else decided", which is not a point on any scale and told the
   * reader nothing about what the session is doing.
   *
   * The level in force when nobody pinned one now arrives as `activeEffort`,
   * beside `activeModel`: the runtime reports the level of the turn it is
   * running (after any silent downgrade for the model), read off the PreToolUse
   * hook. So the control names a level in both cases and never asks the reader
   * to care who chose it.
   *
   * NOTHING is asserted only in the one window where the level is genuinely
   * unknown — a run that has not reached its first tool call yet. There the
   * head row names just the model and the track renders muted.
   */
  const stops = efforts;
  // Pinned first, then what the run says it is really doing, and whether either
  // is knowable at all — see `effortTrack`, where the reasoning lives.
  const { effective, offScale, unset, pending, unknown, shown } = effortTrack({
    stops,
    effort,
    activeEffort,
    drag,
  });
  const stopLabel = (v: string) => effortLabel[v] ?? v;
  useEffect(() => {
    if (!open) setPage('main');
  }, [open]);
  // The run echoed back what the release asked for — hand control of the thumb
  // back to the props.
  useEffect(() => {
    if (drag !== null && stops[drag] === (effort ?? '')) setDrag(null);
  }, [effort, drag, stops]);
  const commit = () => {
    if (drag === null) return;
    onEffort(stops[drag] ?? '');
  };

  /**
   * Picking a model ENDS the visit on a phone, and returns to the compact face
   * on a desk. The same control, two costs:
   *
   * On a desk the popover is anchored beside the trigger and reopening it is
   * one click away from where the pointer already is — so landing back on the
   * face is a convenience, letting you set the effort for the model you just
   * chose without a second trip.
   *
   * On a phone that same return leaves a modal sitting over the message you
   * were writing, and the only ways out of it are a scrim tap or the trigger
   * again. You came for a model, you named one; there is nothing left to
   * confirm. So it closes, and `close()` hands the field back with the caret
   * where you left it — see the note by `holdFocus`.
   */
  const pickModel = (id: string) => {
    onModel(id);
    if (phone) close();
    else setPage('main');
  };

  const modelList = (
    <>
      <button type="button" className="rp-back" onMouseDown={holdFocus} onClick={() => setPage('main')}>
        <CaretLeft size={12} /> Модель
      </button>
      {!noAccountRow && (
        <button
          type="button"
          className={`rp-row ${model === '' ? 'on' : ''}`}
          onMouseDown={holdFocus}
          onClick={() => pickModel('')}
        >
          {accountLabel}
          <span className="rp-note">по аккаунту</span>
        </button>
      )}
      {models.map((m) => (
        <button
          type="button"
          key={m.id}
          className={`rp-row ${model === m.id ? 'on' : ''}`}
          onMouseDown={holdFocus}
          onClick={() => pickModel(m.id)}
        >
          {m.name ?? m.id}
        </button>
      ))}
    </>
  );

  /**
   * The compact face: what is set, and one gesture to change the part of it you
   * came for. It replaces two stacked lists — ten rows for a decision that is
   * one noun and one magnitude.
   *
   * The model is a DRILL rather than a list in place: a phone's model list is
   * the tall half of this control, and showing it permanently pushed the effort
   * off the bottom of the sheet.
   */
  const main = (
    <>
      <button type="button" className="rp-head" onMouseDown={holdFocus} onClick={() => setPage('models')}>
        <Lightning size={13} />
        <span className="rp-head-model">{modelLabel}</span>
        {/* While a drag is in flight the head names the level under the finger,
            even on a slider that was blank when it started — otherwise the one
            moment the reader is actively choosing is the one moment the control
            refuses to say what they are choosing. */}
        {!effortOff && !(unset && !pending) && (
          <span className="rp-head-effort">
            {offScale && !pending ? stopLabel(effective) : stopLabel(stops[shown] ?? '')}
          </span>
        )}
        <CaretRight size={12} />
      </button>
      {effortOff ? (
        <div className="rp-empty">Эта модель не принимает усилие рассуждения.</div>
      ) : (
        <div className={`rp-slider ${unset || offScale ? 'unset' : ''} ${unknown ? 'unknown' : ''}`}>
          <input
            type="range"
            min={0}
            max={stops.length - 1}
            step={1}
            value={shown}
            aria-label="Усилие рассуждения"
            // A screen reader was told «Low» for a level nobody knows — the same
            // lie as the parked thumb, in the channel where it cannot be seen
            // and corrected.
            aria-valuetext={unknown ? 'не задано' : stopLabel(stops[shown] ?? '')}
            onChange={(e) => setDrag(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
          {/* EVERY stop, short, with the current one marked.
              Two end labels were not enough to read a CHANGE: the track has no
              ticks, so after a drag the only thing that moved was a thumb
              between two unnamed positions, and «did that register?» is a fair
              question to ask of a control that answers it nowhere. Now the
              stop you are on is named and marked, so a drag is visibly a
              change. Short forms, because four full names do not fit 260px. */}
          <div className="rp-scale">
            {stops.map((stop, i) => (
              <span key={stop} className={!unknown && i === shown ? 'on' : ''}>
                {EFFORT_SHORT[stop] ?? stop}
              </span>
            ))}
          </div>
        </div>
      )}
      {/* ABOVE the ladder, not beside it: ultracode is xhigh PLUS standing
          orchestration, so a scale that ends at «очень высокое» with this row
          under it reads as if the row were a lesser option. It is the step
          past the end, and saying so is cheaper than re-teaching the reader. */}
      {allowUltracode && <div className="rp-beyond">сверх шкалы</div>}
      {allowUltracode && (
        <button
          type="button"
          className={`rp-row ${effort === 'ultracode' ? 'on' : ''}`}
          onMouseDown={holdFocus}
          onClick={() => {
            onEffort('ultracode');
            close();
          }}
        >
          ultracode
          <span className="rp-note">xhigh + оркестрация</span>
        </button>
      )}
    </>
  );

  const panel =
    page === 'models' ? (
      modelList
    ) : (
      <>
        {main}
        {plan && (
          <>
            <div className="rp-section">Режим</div>
            <button
              type="button"
              role="switch"
              aria-checked={plan.on}
              className={`rp-row rp-switch ${plan.on ? 'on' : ''}`}
              onMouseDown={holdFocus}
              onClick={() => plan.onToggle(!plan.on)}
            >
              Режим планирования
              <span className="rp-knob" aria-hidden />
            </button>
          </>
        )}
      </>
    );

  return (
    <div className="run-pick-wrap" ref={wrap}>
      <button
        type="button"
        className={`run-pick ${open ? 'on' : ''}`}
        /* Hold the caret where it is. This control lives inside the composer,
           and on a phone the composer is EXPANDED only while it has focus (see
           `.composer-box.cg.idle` in styles.css) — so a tap that moved focus to
           this button collapsed the row out from under the finger that was
           reaching for it, taking the menu with it. Same reason send needed it,
           one row over: a button that steals focus from a field is a button
           that moves the ground it stands on.
           This paragraph described a handler that was NOT HERE — the line it
           talks about had gone, and the comment stayed to vouch for it. What
           the missing line actually cost was the keyboard: opening this picker
           mid-message dismissed it and lost the caret. See `holdFocus`. */
        onMouseDown={holdFocus}
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        title="Модель и усилие рассуждения"
      >
        {/* The lightning and the short level are gone, and so is the folded
            phone row they existed for: the whole control now sits out that
            row and returns, whole, on the first tap into the field. What
            actually shipped under the old arrangement was the bolt ALONE —
            CSS hid `.rp-effort-short` along with the model name — so a
            comment here promising «the LEVEL stays visible» described
            something nobody ever saw, in forty pixels of the narrowest row in
            the product. */}
        <span className="rp-model">{shortModel}</span>
        {!effortOff && effortText && <span className="rp-effort">{effortText}</span>}
        {!effortOff && effortShort && <span className="rp-effort-short">{effortShort}</span>}
        <CaretRight size={11} />
      </button>

      {/* Desk: anchored to the trigger, where the pointer already is. */}
      {open && !phone && (
        <div className="run-pick-pop" role="dialog" aria-label="Модель и усилие" ref={pop}>
          {panel}
        </div>
      )}
      {/* Phone: a small CENTRED modal, not a sheet off the bottom edge.
          Still a portal to `body` for the original reason, and that reason has
          not changed: an anchored popover would have to hang off a control the
          folding composer can move or remove, while a fixed box does not care
          what happens underneath it.
          What changed is the shape. A bottom sheet is the right form for a long
          or open-ended list; this is a dozen fixed rows in two short sections,
          and full-bleed it read as a much bigger decision than picking an
          effort level. It also put the rows at the very bottom of the screen,
          under the thumb that had just tapped a control near the composer — so
          the hand covered the thing it came to read.
          No grip: a grip promises a drag-to-dismiss that was never implemented.
          Dismissal is the scrim, and it always was. */}
      {open && phone &&
        createPortal(
          <>
            {/* The scrim closes WITHOUT choosing, and the field still comes
                back: you were typing before you opened this, and tapping away
                from a menu is not a reason to be put out of the message. */}
            <div className="rp-modal-scrim" onMouseDown={holdFocus} onClick={close} />
            <div className="rp-modal" role="dialog" aria-modal="true" aria-label="Модель и усилие" ref={sheet}>
              <div className="rp-modal-body">{panel}</div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
