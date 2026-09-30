import { clubShortDate } from "@/lib/clubClock";
import { clubZone } from "@/lib/clubZone";

/**
 * Dates as the play surfaces write them, in the club's zone — through the club's one short date
 * (`clubShortDate`), so a play screen never says "Sept" or "01 Oct" where the grid does not.
 */

/** "14 Aug 2026". */
export function playDate(iso: string, timezone?: string): string {
  return clubShortDate(iso, timezone, { weekday: false, year: true });
}

const WEEKDAY_OFFSET: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/**
 * The pause allowance's year for the week an instant falls in: the calendar year of that club
 * week's MONDAY (§5.3) — so Fri 1 Jan 2027 is still in 2026's allowance (week of 28 Dec 2026).
 * Calendar arithmetic on the club-local date, never instant − 7 × 24 h.
 */
export function clubYear(iso: string, timezone?: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric", month: "numeric", day: "numeric", weekday: "short", timeZone: timezone ?? clubZone(),
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const local = Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day")));
  const monday = new Date(local - (WEEKDAY_OFFSET[part("weekday")] ?? 0) * 86_400_000);
  return monday.getUTCFullYear();
}
