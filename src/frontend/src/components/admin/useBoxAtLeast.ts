import { useCallback, useState } from "react";

/**
 * Whether an element's own box is at least `rem` wide — the JavaScript twin of a container query,
 * for the one decision CSS cannot make: whether a detail opens as a MODAL sheet or fills a panel
 * the page already draws (R4 form factor; `WithAside placement="sheet"` draws that panel from the
 * same width). Rem, like the container query, so 200 % text keeps the sheet.
 *
 * <p>
 * A callback ref, so it follows the element across remounts. With no `ResizeObserver` (jsdom) it
 * answers `false` — the small screen, which is the mobile-first default every caller is built from.
 * </p>
 */
export function useBoxAtLeast(rem: number): [(el: HTMLElement | null) => void, boolean] {
  const [wide, setWide] = useState(false);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setWide(el.getBoundingClientRect().width >= rem * root - 0.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // React 19 runs a callback ref's returned function on detach.
    return () => observer.disconnect();
  }, [rem]);
  return [ref, wide];
}
