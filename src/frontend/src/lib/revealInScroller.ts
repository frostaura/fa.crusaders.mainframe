import type { FocusEvent } from "react";

/**
 * X-8 (review round 3) — a control that takes focus inside a sideways-scrolling row is scrolled
 * wholly into that row's view.
 *
 * <p>
 * Browsers do this for most focus, but not for everything: Chromium does not scroll a
 * `position: sticky` box (a table's sticky header cell) into view, and "if needed" treats a
 * control half past the edge as already visible. Found on a 390 px phone — the Wallet Activity
 * table's "Refunds (net)" header and the Bookings grid's Court 4 chip took focus off-screen.
 * </p>
 *
 * <p>
 * Only the NEAREST horizontal scroller moves, and only by as much as it must (plus a small margin
 * so the focus ring shows); vertical scrolling is left to the browser.
 * </p>
 */
export function revealHorizontally(el: HTMLElement, margin = 8): void {
  for (let box = el.parentElement; box; box = box.parentElement) {
    if (box.scrollWidth <= box.clientWidth) continue;
    const overflowX = getComputedStyle(box).overflowX;
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    const target = el.getBoundingClientRect();
    const left = box.getBoundingClientRect().left + box.clientLeft;
    const right = left + box.clientWidth;
    if (target.left < left) box.scrollLeft -= left - target.left + margin;
    else if (target.right > right) box.scrollLeft += target.right - right + margin;
    return;
  }
}

/** `onFocus={revealOnFocus}` — the same, as a handler. */
export function revealOnFocus(event: FocusEvent<HTMLElement>): void {
  revealHorizontally(event.currentTarget);
}
