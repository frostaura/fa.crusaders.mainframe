import type { GridBooking, SelectedSlot } from "./types";

/**
 * R16 J16-12 — several slots read in ONE order wherever they are listed: by start time, then by the
 * courts' own order on the day. The selection bar said them by time and the sheets by court, so a
 * member checking one against the other read two different lists. The page hands the sheets their
 * slots in this order; every later step (slot list, confirm, results) keeps the order it was given.
 */
export function inTimeOrder<T extends SelectedSlot | GridBooking>(items: readonly T[], courtOrder: readonly string[]): T[] {
  const court = (id: string) => {
    const at = courtOrder.indexOf(id);
    return at < 0 ? courtOrder.length : at;
  };
  return items
    .map((item, index) => ({ item, index, at: Date.parse(item.startsAt) }))
    .sort((a, b) => (a.at - b.at) || (court(a.item.courtId) - court(b.item.courtId)) || (a.index - b.index))
    .map(({ item }) => item);
}
