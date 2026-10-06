import { useEffect } from "react";

/**
 * R18 L18-2 — a sheet's refusal is taken to the reader (L17-6's rule, for the sheets). At 320 px /
 * 200 % text the refusal rendered below the fold of the sheet's body — cancel's clash, book's
 * "someone just took that slot" — while the keyboard stayed on the button that had just been
 * pressed. A task after it renders (after any control the same commit focused), the alert marked
 * `data-sheet-refusal` inside `scope` is scrolled into view and, when `take` is set, focused.
 * `take` is false where the sheet has deliberately put the keyboard elsewhere (R11 X11-3's "Pick
 * another time", which the refusal then describes).
 */
export function useRefusalInView(failure: unknown, scope: string, take = true) {
  useEffect(() => {
    if (!failure) return undefined;
    const timer = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`${scope} [data-sheet-refusal]`);
      if (!el) return;
      el.scrollIntoView?.({ block: "nearest" });
      if (take) el.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [failure, scope, take]);
}
