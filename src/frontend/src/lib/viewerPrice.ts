import type { ScheduleCourt, ScheduleDay } from "./api";

/**
 * What THIS viewer pays for one slice on each court (R5 I5-1, HIGH).
 *
 * <p>
 * `court.slicePriceCredits` is the court's own price. A member pays their GROUP's price —
 * `GroupRules.PriceFor(groups, court price)`, the highest any of their groups asks — and the
 * grid, the headers and the Book sheet all quoted the court's: "Book 50.00 cr", "You need 10.00
 * more" and a disabled Book for a member whose group pays 30 and who had 40 to spend, while the
 * club would have taken the booking.
 * </p>
 *
 * <p>
 * The server's own per-court figures win whenever it sends them (`slicePricesByCourt` on the
 * schedule's rules, `slice_prices_by_court` on the desk's member rules). Otherwise the one group
 * price the rules carry is the price on its REFERENCE court (the schedule's: the first open court
 * by number; the desk read's: the cheapest), and another court's is derived from it: the same
 * court price is the same group price; a group that leaves the reference price alone leaves every
 * court's alone; any other group is a multiplier on the court's price. Unknown rules price at the
 * court's own figure — the club re-prices on Confirm either way.
 * </p>
 */
export type PriceSource = {
  /** The viewer's price on the reference court; null when the rules did not say. */
  groupPrice: number | null;
  /** The reference court's own price the group price was computed from; null when unknown. */
  referencePrice: number | null;
  /** The server's per-court figures, by court id, when it sent them. */
  byCourt: ReadonlyMap<string, number> | null;
};

export const NO_PRICE_SOURCE: PriceSource = { groupPrice: null, referencePrice: null, byCourt: null };

export type PriceOf = (court: Pick<ScheduleCourt, "id" | "slicePriceCredits">) => number;

/** One slice's price for this viewer on `court`. */
export function viewerSlicePrice(court: Pick<ScheduleCourt, "id" | "slicePriceCredits">, source: PriceSource): number {
  const told = source.byCourt?.get(court.id);
  if (typeof told === "number") return told;
  const { groupPrice, referencePrice } = source;
  if (groupPrice === null) return court.slicePriceCredits;
  if (referencePrice === null || referencePrice <= 0 || court.slicePriceCredits === referencePrice) return groupPrice;
  if (groupPrice === referencePrice) return court.slicePriceCredits;
  return Math.round((court.slicePriceCredits * groupPrice * 100) / referencePrice) / 100;
}

export function priceOfFor(source: PriceSource): PriceOf {
  return (court) => viewerSlicePrice(court, source);
}

/** The court the schedule's `rules.slicePriceCredits` is priced on: the first open court by number. */
export function scheduleReferencePrice(day: Pick<ScheduleDay, "courts"> | null): number | null {
  const open = (day?.courts ?? []).filter((c) => c.isActive !== false).sort((a, b) => a.courtNumber - b.courtNumber);
  return open[0]?.slicePriceCredits ?? null;
}

/** The cheapest open court — what the desk's member booking-rules prices its single figure on. */
export function cheapestOpenPrice(day: Pick<ScheduleDay, "courts"> | null): number | null {
  const prices = (day?.courts ?? []).filter((c) => c.isActive !== false).map((c) => c.slicePriceCredits);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * A per-court price list in either spelling — `[{ court_id | courtId, credits }]` — as a map;
 * null when absent or empty, so an older server falls back to the derivation.
 */
export function readPricesByCourt(raw: unknown): ReadonlyMap<string, number> | null {
  if (!Array.isArray(raw)) return null;
  const map = new Map<string, number>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.court_id === "string" ? r.court_id : typeof r.courtId === "string" ? r.courtId : null;
    const credits = typeof r.credits === "number" ? r.credits : null;
    if (id !== null && credits !== null) map.set(id, credits);
  }
  return map.size ? map : null;
}

/** The schedule's own source: the viewer's rules on the day shown. */
export function schedulePriceSource(day: ScheduleDay | null, groupPrice: number | null): PriceSource {
  const raw = day?.rules as Record<string, unknown> | undefined | null;
  const byCourt = raw && typeof raw === "object"
    ? readPricesByCourt(raw.slicePricesByCourt ?? raw.slice_prices_by_court)
    : null;
  return { groupPrice, referencePrice: scheduleReferencePrice(day), byCourt };
}
