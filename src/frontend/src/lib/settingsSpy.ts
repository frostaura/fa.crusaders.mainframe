/**
 * The section the admin is reading: the LAST one whose heading has reached the top of the
 * scroller (BA-18). The scroller is `<main>`, not the window, and an IntersectionObserver keyed
 * on the viewport kept the tops it saw when an entry last CHANGED — so with "Box screens" open
 * and filling the screen, the rail lit "Repeating bookings" above it. Measured from the live
 * positions on every scroll (one frame at a time), it cannot go stale.
 */
export function sectionAtTop(tops: readonly { id: string; top: number }[], scrollerTop: number, offset = 96): string | null {
  let current: string | null = tops[0]?.id ?? null;
  for (const { id, top } of tops) if (top - scrollerTop <= offset) current = id;
  return current;
}
