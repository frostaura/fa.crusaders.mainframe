import { useLayoutEffect, useRef } from "react";

/**
 * Where a sheet's focus goes back to when it was opened from a ⋯ MENU (review round 6, X6-1).
 *
 * <p>
 * The dialog surface returns focus to whatever had it when the sheet opened, and falls back to
 * `<main>` when that element has gone. Opened from a menu, what had focus was the menu item, which
 * unmounts with the menu — so Escape on Adjust minutes, Sell package or Change groups dropped a
 * keyboard user at the top of the page. This handler, passed as the sheet content's
 * `onCloseAutoFocus`, steps in ONLY then: when the opener is gone (or was inside a menu) it focuses
 * `returnFocus()` — the ⋯ the menu hung from. A sheet opened from a button that is still on the
 * page (the table's Sell package) is left to the surface, which goes back to that button.
 * </p>
 */
export function useMenuReturnFocus(returnFocus?: () => HTMLElement | null | undefined) {
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement;
  }, []);
  return (event: Event) => {
    if (!returnFocus || event.defaultPrevented) return;
    const from = opener.current;
    const stillThere = from instanceof HTMLElement && from.isConnected && from !== document.body && !from.closest("[role='menu']");
    if (stillThere) return;
    const target = returnFocus();
    if (!target || !target.isConnected) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  };
}
