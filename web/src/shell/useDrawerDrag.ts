import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { settle } from './shellSwipe.js';
import { useSwipe } from './useSwipe.js';

/**
 * Длительность шелловой кривой, в мс. Дублирует `--dur` из `styles.css`, и
 * нужна здесь ровно за одним: додержать шторку смонтированной, пока она
 * уезжает. CSS не умеет сказать React'у «я доанимировал».
 */
const DUR = 200;

/**
 * Геометрия шторки — одно число на всё.
 *
 * Зеркало `AppShell.swift` (`shown` / `t`). Смысл именно в том, что число
 * ОДНО: положение карточки, её масштаб, радиус угла, плотность скрима и
 * положение самой шторки считаются отсюда, поэтому не могут разъехаться.
 * Раньше их держала селекторная пара «шторка смонтирована / не смонтирована»,
 * то есть два положения и ничего между ними, а жест решал судьбу целиком в
 * `touchend`: палец возил по стеклу, ничего не двигалось, потом шторка
 * прилетала. Владелец нашёл это как «шторка открывается не сразу».
 *
 * Возвращает то, что нужно разметке: смонтирована ли шторка, признак «палец
 * сейчас на стекле» (по нему CSS снимает переходы) и сам `--drawer-t`.
 */
export function useDrawerDrag(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
) {
  /** Сырое смещение пальца в текущей тяге. */
  const [drag, setDrag] = useState(0);
  /**
   * Палец СЕЙЧАС на стекле. Отдельно от `drag !== 0`, потому что тяга может
   * вернуться ровно в ноль, не кончившись, — и в этот кадр переходы включать
   * нельзя: они догоняли бы палец вместо того, чтобы идти за ним.
   */
  const [dragging, setDragging] = useState(false);
  /**
   * Шторка уже закрыта по состоянию, но ещё уезжает. Без этого она пропадала
   * бы мгновенно: React снимает узел, и уезжать становится нечему.
   */
  const [closing, setClosing] = useState(false);
  /**
   * Шторка ТОЛЬКО ЧТО появилась в дереве и на этот кадр ещё закрыта.
   * Элемент, впервые отрисованный уже открытым, переходить не с чего — без
   * этого открытие с ☰ было бы мгновенным подскоком вместо выезда.
   */
  const [entering, setEntering] = useState(false);

  // Ширина шторки — `--drawer-w: min(82vw, 320px)`, один в один с CSS. Читается
  // на каждой тяге, а не запоминается: поворот телефона её меняет.
  const width = useRef(320);

  // `open` читается через ref: обработчики жеста живут в эффекте `useSwipe` и
  // не должны перевзводиться из-за смены состояния посреди тяги.
  const openRef = useRef(open);
  openRef.current = open;

  /** Жест уже привёл шторку в нужное место — входить ей неоткуда. */
  const viaGesture = useRef(false);
  const exit = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(exit.current), []);

  const onMove = useCallback((dx: number) => {
    width.current = Math.min(window.innerWidth * 0.82, 320);
    // Открывают тягой ВПРАВО, закрывают влево. Тяга не в ту сторону из
    // текущего положения не должна ни двигать карточку, ни монтировать
    // шторку: человек листает что-то своё.
    if (!openRef.current && dx <= 0) return;
    if (openRef.current && dx >= 0) return;
    clearTimeout(exit.current);
    setClosing(false);
    setEntering(false);
    setDragging(true);
    setDrag(dx);
  }, []);

  const onEnd = useCallback(
    (dx: number, velocity: number) => {
      const wasOpen = openRef.current;
      const target = settle(dx, velocity, wasOpen);
      setDragging(false);
      // Сбрасывается ВСЕГДА, в том числе когда положение не изменилось: иначе
      // шторка, дотянутая до середины и отпущенная, там бы и осталась.
      setDrag(0);
      if (target === wasOpen) return;
      viaGesture.current = true;
      setOpen(target);
    },
    [setOpen],
  );

  useSwipe(ref, { onMove, onEnd });

  // Появление и уход, когда жеста не было: ☰, скрим, Esc, выбор сессии.
  const wasOpen = useRef(open);
  useEffect(() => {
    const prev = wasOpen.current;
    wasOpen.current = open;
    if (prev === open) return;
    const gestured = viaGesture.current;
    viaGesture.current = false;

    if (!open) {
      // Додержать смонтированной, пока уезжает.
      setClosing(true);
      clearTimeout(exit.current);
      exit.current = setTimeout(() => setClosing(false), DUR);
      return;
    }
    // Жест уже довёл её почти до места — ей не «входить», а доехать.
    if (gestured) return;
    setEntering(true);
    // Два кадра, а не один: между постановкой стиля и его применением браузеру
    // нужен свой такт, иначе оба значения попадут в один пересчёт и перехода
    // опять не будет.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setEntering(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [open]);

  const shown = Math.min(Math.max((open ? width.current : 0) + drag, 0), width.current);
  const t = dragging ? (width.current > 0 ? shown / width.current : 0) : entering ? 0 : open ? 1 : 0;

  return {
    /** Есть ли шторка в дереве. Тянуть можно только то, что смонтировано. */
    mounted: open || dragging || closing,
    dragging,
    /** Ровно то, что разметка отдаёт в CSS — все пять правил геометрии. */
    style: { '--drawer-t': t } as CSSProperties,
  };
}
