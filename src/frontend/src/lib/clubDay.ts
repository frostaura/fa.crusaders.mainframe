import { clubZone } from "./clubZone";

/**
 * A club DATE turned into instants, in the club's own zone (review round 4, A4-7).
 *
 * <p>
 * Transactions asked for `${from}T00:00:00Z` to `${to}T23:59:59Z` — UTC days. At a club two hours
 * ahead of UTC that moved every movement between midnight and 02:00 onto the previous day, and
 * dropped the last second of the range. A club day starts at the club's midnight, whatever the
 * reader's zone, and the range is half-open: from one midnight to the next, as the server filters.
 * </p>
 */

/** The wall-clock reading of an instant in a zone, as if that reading were UTC. */
function wallAsUtc(instant: number, zone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

/** The instant a club date begins: 00:00 in the club's zone (the reader's own while it is unknown). */
export function clubDayStart(date: string, zone: string | undefined = clubZone()): Date {
  const [y, m, d] = date.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  // Two passes settle the offset; a third covers a date whose midnight a DST change moves.
  for (let i = 0; i < 3; i += 1) guess = target - (wallAsUtc(guess, zone) - guess);
  return new Date(guess);
}

/** The club date after this one, "2026-10-01" → "2026-10-02". */
export function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Today's club date, moved by `days` ("2026-09-30"). */
export function clubToday(days = 0, zone: string | undefined = clubZone(), now = Date.now()): string {
  const wall = new Date(wallAsUtc(now, zone));
  wall.setUTCDate(wall.getUTCDate() + days);
  return wall.toISOString().slice(0, 10);
}

/** The half-open instant range `[from's midnight, the midnight after to)`, each end optional. */
export function clubDayRange(
  from: string, to: string, zone: string | undefined = clubZone(),
): { from?: string; to?: string } {
  return {
    from: from ? clubDayStart(from, zone).toISOString() : undefined,
    to: to ? clubDayStart(nextDate(to), zone).toISOString() : undefined,
  };
}
