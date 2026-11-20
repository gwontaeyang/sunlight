// Keeps one row in view of its panel scroll area for a moment (review D-F1-02: a just-saved note). Rows of the area are
// drawn lazily when they come into view (useSeen), so a row brought into view can be pushed out again by rows above it
// that grow when drawn. While active, the row is brought back into view whenever the area's content changes size, until
// the user acts (pointer, wheel, touch or key anywhere), KEEP_IN_VIEW_MS pass, or the hook's tick changes. Owner D.
import { type RefObject, useEffect } from 'react';
import { scrollIntoViewSafe } from './structureNotice';

/** Attribute of a panel scroll area whose content keepInView watches. */
export const SCROLL_AREA_ATTR = 'data-pn-scroll-area';
export const KEEP_IN_VIEW_MS = 3_000;
const USER_EVENTS = ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const;

/** tick > 0: scroll the element into view now and keep it there (see above); each new tick starts again. */
export function useKeepInView(ref: RefObject<Element | null>, tick: number) {
  useEffect(() => {
    const el = ref.current;
    if (tick <= 0 || !el) return;
    scrollIntoViewSafe(el);
    const area = el.closest(`[${SCROLL_AREA_ATTR}]`);
    if (!area || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => scrollIntoViewSafe(el));
    for (const child of Array.from(area.children)) ro.observe(child);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      ro.disconnect();
      clearTimeout(timer);
      for (const t of USER_EVENTS) document.removeEventListener(t, stop, true);
    };
    const timer = setTimeout(stop, KEEP_IN_VIEW_MS);
    for (const t of USER_EVENTS) document.addEventListener(t, stop, { capture: true, passive: true });
    return stop;
  }, [tick]);
}
