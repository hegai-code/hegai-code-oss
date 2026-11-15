import { useEffect, useState } from 'react';

/**
 * The one width every phone rule in this app uses.
 *
 * It is spelled here rather than in each file that needs it because the number
 * is load-bearing in both directions: `styles.css` hides the rail, turns the
 * context column into the page and hides `.main-col` at exactly this width, and
 * JS has to agree — a control rendered on the wrong side of this line is not
 * merely misplaced, it is inside a `display: none` subtree, where it still
 * runs its handlers and shows nothing.
 */
export const PHONE = '(max-width: 860px)';

/**
 * Whether this is the phone layout, kept in sync with the viewport.
 *
 * Listening matters: a desktop window dragged narrow crosses this line without
 * a reload, and the components that ask are deciding WHERE a popover mounts.
 * Reading `matchMedia(...).matches` once at mount leaves the popover anchored
 * to a bar that is no longer on screen.
 */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof matchMedia === 'function' && matchMedia(PHONE).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(PHONE);
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return phone;
}
