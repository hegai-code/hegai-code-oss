import { useRef, type ReactNode } from 'react';

/** Horizontal chip row that also pans on desktop: mouse-drag scrolls it (with a
 *  5px threshold so chip clicks still land) and a vertical wheel translates to
 *  horizontal scroll. Touch devices keep native overflow scrolling. */
export function DragScrollRow({
  className,
  label,
  children,
}: {
  className: string;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const st = useRef({ down: false, moved: false, x: 0, left: 0 });
  return (
    <div
      ref={ref}
      className={className}
      role="tablist"
      aria-label={label}
      onWheel={(e) => {
        const el = ref.current;
        if (el) el.scrollLeft += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        st.current = { down: true, moved: false, x: e.clientX, left: ref.current?.scrollLeft ?? 0 };
      }}
      onPointerMove={(e) => {
        const s = st.current;
        const el = ref.current;
        if (!s.down || !el) return;
        const dx = e.clientX - s.x;
        if (!s.moved && Math.abs(dx) < 5) return;
        if (!s.moved) {
          s.moved = true;
          el.classList.add('dragging');
          el.setPointerCapture(e.pointerId);
        }
        el.scrollLeft = s.left - dx;
      }}
      onPointerUp={() => {
        st.current.down = false;
        ref.current?.classList.remove('dragging');
      }}
      onPointerCancel={() => {
        st.current.down = false;
        ref.current?.classList.remove('dragging');
      }}
      onClickCapture={(e) => {
        // a drag must not count as a chip click
        if (st.current.moved) {
          st.current.moved = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {children}
    </div>
  );
}
