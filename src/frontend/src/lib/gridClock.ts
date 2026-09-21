/**
 * The club's calendar day, and the one clock the booking grid reads.
 *
 * <p>
 * <b>Why this is not in `lib/clubClock`.</b> That module writes instants for a reader — a
 * clock face, a row time, a printed card — and every function in it hands back a formatted
 * string. These two hand back arithmetic: a `YYYY-MM-DD` the API is queried with, and a pair
 * of millisecond thresholds the grid compares cells against. Mixing them would put a number
 * nobody can print beside a string nobody can compare.
 * </p>
 *
 * <p>
 * <b>The zone is resolved the same way, though</b> — through `lib/clubZone`, which holds what
 * the club itself last told us and which never guesses. A caller that has a zone passes it and
 * teaches it on the way past; a caller that has none gets the reader's own clock, which is the
 * honest answer until the club has said, and is what the grid did before this module existed.
 * </p>
 */

import { clubZone, isUsableZone, rememberClubZone } from "./clubZone";

/** The one locale that spells a date the way this product does. A format, not a language. */
const CLUB_LOCALE = "en-GB";

/**
 * `YYYY-MM-DD` in the club's day, for the date the schedule is asked for.
 *
 * <p>
 * <b>D3-B03.</b> `pages/Schedule.tsx` used `new Date().toISOString().slice(0,10)` — the UTC
 * day — and `dateBounds` built its ±N-day window out of a browser-local `Date`. Two clocks on
 * one strip, on a screen whose every row label was already drawn in the club's zone. A club in
 * Denver opening the console at 21:00 was shown tomorrow's empty grid and told it was today's.
 * </p>
 *
 * <p>
 * Built from `formatToParts` rather than by string-slicing a locale render, because a locale's
 * numeric date is `21/09/2026` in `en-GB` and `9/21/2026` in `en-US` and neither is the ISO
 * spelling the API takes. Parts are the only stable way across engines.
 * </p>
 *
 * <p>
 * <b>A zone this engine cannot format in answers the reader's day, never a throw.</b> The
 * value arrives from a settings column somebody typed; `Intl` raises `RangeError` on a typo,
 * and a raise in a render body is a blank console rather than a clock one day out.
 * </p>
 */
export function clubDayOf(atMs: number, timezone?: string): string {
  const zone = zoneFor(timezone);
  const parts = new Intl.DateTimeFormat(CLUB_LOCALE, {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(atMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The caller's zone if this engine knows it, else whatever the club last told us. */
function zoneFor(timezone?: string): string | undefined {
  if (isUsableZone(timezone)) {
    rememberClubZone(timezone);
    return timezone;
  }
  return clubZone();
}

/**
 * `days` calendar days from a `YYYY-MM-DD`, still as a `YYYY-MM-DD`.
 *
 * <p>
 * Calendar arithmetic on the DATE, never on an instant: a day either side of a DST
 * transition is one calendar day away and 23 or 25 hours away, and the date picker's bounds
 * are a count of days. `Date.UTC` is used as a pure calendar — no zone reaches it, because
 * no zone is relevant to "one day after the 21st".
 * </p>
 */
export function shiftClubDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The two thresholds the grid compares its cells against. */
export type GridNow = {
  /**
   * A row is Past when its start is `<=` this. It is the start of the row that is running
   * NOW, so it moves in slice steps and the memoised grid repaints once a slice instead of
   * once a second. `-Infinity` before the day's first row starts.
   */
  pastThresholdMs: number;
  /**
   * "Now" for the peak-advance rule, rounded UP to the next whole minute.
   *
   * <p>
   * `peakRestricted` refuses a cell when `(start - now) / 3600000 > advanceHours`, so a `now`
   * that lags reality makes the client STRICTER than the server and hides a slot the club
   * would have sold. Rounding up can only make it more permissive, which is the direction
   * `lib/scheduleGrid`'s own doc-comment requires of every field on this path.
   * </p>
   */
  peakNowMs: number;
};

/**
 * Where the clock stands against this day's rows.
 *
 * <p>
 * <b>D3-B02.</b> `loadedAt` was stamped once, at load, and every cell compared against it for
 * the life of the tab. A console left open on the desk went on offering — and charging for —
 * slots that had already started, and `peakRestricted` froze with it. The fix is a ticker, and
 * this is what the ticker's raw millisecond is turned into so that a once-a-second tick does
 * not repaint two hundred cells sixty times a minute.
 * </p>
 *
 * @param rowStartsMs every row's start instant, in grid order — `buildTimeSlices` order.
 * @param nowMs the live clock, straight off the ticker.
 */
export function gridNow(rowStartsMs: readonly number[], nowMs: number): GridNow {
  let pastThresholdMs = -Infinity;
  for (const start of rowStartsMs) {
    if (start > nowMs) break;
    pastThresholdMs = start;
  }
  return { pastThresholdMs, peakNowMs: Math.ceil(nowMs / 60_000) * 60_000 };
}
