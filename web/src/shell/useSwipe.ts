import { useEffect, useRef, type RefObject } from 'react';
import { PHONE } from './usePhone.js';
import { CLAIM, isHorizontal } from './shellSwipe.js';

/**
 * Does this touch belong to something that scrolls sideways?
 *
 * A transcript is full of them — code blocks, tables, the machine chips, the
 * lens tabs — and a horizontal drag inside one of those is the reader moving
 * that box, not a gesture aimed at the shell. Stealing it would make wide code
 * unreadable on the one device where it is hardest to read already.
 *
 * `overflow-y: auto` promotes `overflow-x` to `auto` per spec, so "is x
 * scrollable" is not enough — the transcript itself would match. The
 * discriminator is whether the box is actually WIDER than its frame.
 *
 * Это спрашивается ПЕРВЫМ, до всякой арифметики, и так же устроено в
 * `SwipeGuard` на телефоне.
 */
function inSidewaysScroller(start: Element | null): boolean {
  for (let el: Element | null = start; el && el !== document.body; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const ox = getComputedStyle(el).overflowX;
    if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 2) return true;
  }
  return false;
}

/**
 * A horizontal swipe on a phone, by DIRECTION rather than by screen edge —
 * **и ЗА ПАЛЬЦЕМ**.
 *
 * The edge is not available. iOS reserves the left edge for its own back
 * gesture — in Safari and in an installed PWA alike — so an edge-anchored
 * drawer either never opens or fights the system for every attempt. Reading the
 * direction of a drag that may START ANYWHERE sidesteps that entirely, and it
 * has the useful property of not caring which side of the screen your thumb
 * happens to be on.
 *
 * Nothing is `preventDefault`ed: vertical scrolling has to keep working through
 * the same listener. Раньше из этого следовало, что решение принимается только
 * в `touchend` — и это было неверно: направление жеста известно уже на шестом
 * пикселе, а `preventDefault` для того, чтобы ВЕСТИ шторку, не нужен вовсе.
 * Геометрию держит вызывающий (`useDrawerDrag`): он один знает ширину шторки и
 * он один отвечает за то, чтобы карточка и шторка ехали на одно и то же число
 * пикселей.
 *
 * Отсюда же `touch-action` не трогается: тяга ничего не отменяет, а прокрутка
 * и так остаётся у того, кто её начал вертикально.
 */
export function useSwipe(
  ref: RefObject<HTMLElement | null>,
  {
    onMove,
    onEnd,
  }: {
    /** Палец сдвинулся — вот на сколько пикселей от начала тяги. */
    onMove?: (dx: number) => void;
    /** Палец отпущен: пройденное расстояние и скорость на отрыве (px/с). */
    onEnd?: (dx: number, velocity: number) => void;
  },
) {
  // The handlers are read through a ref so that re-rendering does not re-arm
  // the listener MID-GESTURE.
  //
  // Every caller passes an inline arrow, so the callbacks are new identities on
  // every render. With them in the dep list the effect tore down and
  // re-registered constantly — and the gesture locals are effect-closure
  // locals, so they reset with it. `touchstart` set the claim in one closure;
  // any render before `touchend` installed a fresh closure where it was unset,
  // and the gesture was silently dropped.
  //
  // That made the failure look like nonsense: swiping worked on a quiet
  // session and not on a busy one. A working run re-renders App on every
  // `stream` event and every snapshot, which is several renders inside the
  // ~300ms a swipe takes — so the gesture failed exactly when the drawer was
  // most wanted, and worked whenever it was idle enough to test. Теперь это
  // тем более важно: кадров внутри жеста стало много, а не один.
  const cb = useRef({ onMove, onEnd });
  cb.current = { onMove, onEnd };

  useEffect(() => {
    // Слушатели висят на ДОКУМЕНТЕ, а элемент из `ref` проверяется в момент
    // СОБЫТИЯ, а не в момент подписки. Это не стилистика — иначе жеста нет
    // вообще, и именно так он был потерян.
    //
    // `App` до готовности сессии возвращает экран загрузки, в котором `.app`
    // нет. Значит первый коммит — без него, эффект отрабатывает с
    // `ref.current === null` и молча выходит; список зависимостей — `[ref]`, а
    // объект ref стабилен, поэтому эффект больше не повторяется НИКОГДА.
    // Дальше `.app` появляется, выглядит совершенно нормально, и ни одного
    // обработчика на нём нет. Симптом — «свайп не работает», без ошибок в
    // консоли и без единого места, где что-то падает.
    //
    // Побочно это чинит и отрыв за краем: `touchend` после того, как палец
    // ушёл с элемента, документ всё равно получит.
    let x0 = 0;
    let y0 = 0;
    /**
     * Что жест решил про себя на первом различимом сдвиге.
     *
     * Решается ОДИН раз за тягу и не пересматривается. Иначе жест, начатый
     * горизонтально и продолженный по дуге, посреди движения переставал бы
     * быть нашим — а шторка в этот момент уже уехала за пальцем и замирала бы
     * на полпути.
     */
    let claim: 'none' | 'undecided' | 'ours' | 'theirs' = 'none';
    // Для скорости на отрыве: `touchend` её не сообщает, считаем по последнему
    // различимому отрезку. Один отрезок, а не среднее за жест: бросок в конце
    // длинной медленной тяги — это бросок.
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;

    const reset = () => {
      claim = 'none';
      velocity = 0;
    };

    const start = (e: TouchEvent) => {
      // Two fingers is a pinch or a scroll, never this. Коробка, которая едет
      // вбок сама, гасит жест ДО всякой арифметики. Принадлежность шеллу
      // спрашивается здесь же — см. заметку про документ выше.
      const host = ref.current;
      const mine =
        e.touches.length === 1 &&
        matchMedia(PHONE).matches &&
        !!host &&
        host.contains(e.target as Node) &&
        !inSidewaysScroller(e.target as Element);
      if (!mine) {
        claim = 'none';
        return;
      }
      const t = e.touches[0]!;
      x0 = t.clientX;
      y0 = t.clientY;
      lastX = t.clientX;
      lastT = e.timeStamp;
      velocity = 0;
      claim = 'undecided';
    };

    const move = (e: TouchEvent) => {
      if (claim === 'none' || claim === 'theirs') return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;

      if (claim === 'undecided') {
        // Ждём первого РАЗЛИЧИМОГО сдвига: до него направление — это шум.
        if (Math.abs(dx) < CLAIM && Math.abs(dy) < CLAIM) return;
        claim = isHorizontal(dx, dy) ? 'ours' : 'theirs';
        if (claim !== 'ours') return;
      }

      const dt = e.timeStamp - lastT;
      // Пропускаем нулевой интервал: два события в один тик дали бы бесконечность.
      if (dt > 0) {
        velocity = ((t.clientX - lastX) / dt) * 1000;
        lastX = t.clientX;
        lastT = e.timeStamp;
      }
      cb.current.onMove?.(dx);
    };

    const end = (e: TouchEvent) => {
      // Сброс ПЕРВЫМ делом, до любого раннего выхода: незакрытый признак —
      // тот самый залипающий флаг, из-за которого шторка перестаёт
      // открываться НАВСЕГДА и молча (ровно та же ловушка, что `defer` в
      // `ShellSwipe.swift`).
      const was = claim;
      const v = velocity;
      reset();
      if (was !== 'ours') return;
      const t = e.changedTouches[0];
      if (!t) return;
      // Палец мог замереть перед отрывом — тогда броска не было, каким бы
      // быстрым ни был предыдущий отрезок.
      const idle = e.timeStamp - lastT;
      cb.current.onEnd?.(t.clientX - x0, idle > 100 ? 0 : v);
    };

    const cancel = () => {
      const was = claim;
      reset();
      // Отмена — это «верни как было», а не «реши по расстоянию».
      if (was === 'ours') cb.current.onEnd?.(0, 0);
    };

    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', cancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', cancel);
    };
  }, [ref]);
}
