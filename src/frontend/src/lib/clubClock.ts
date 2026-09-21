/**
 * One way to write a date on the doors surface, and the reason there has to be exactly one.
 *
 * <p>
 * <b>A13.</b> One reviewed page carried two date formats at once: everything the doors code
 * wrote used `en-GB` with `hour12: false`, and one row — the feed's `<time title>`, which
 * went through `utils.formatInstant` — used `toLocaleString(undefined, …)` and rendered
 * <code>"9/19/26, 9:25 PM"</code> in the reviewer's browser. Month-first and a 12-hour clock
 * are not this club's conventions, and two formats on one screen make a reader stop and work
 * out which is which on the one screen where they are reconciling times after an incident.
 * </p>
 *
 * <p>
 * <b>`en-GB` is a FORMAT choice, not a language one.</b> It is how this product already
 * spells a date everywhere else: day before month, 24-hour clock, no AM/PM. Passing
 * `undefined` hands the decision to whatever locale the admin's laptop happens to carry,
 * which is why the defect was invisible to everyone who built it.
 * </p>
 *
 * <p>
 * <b>The timezone is optional and that is deliberate.</b> Where the club's own zone is known
 * — every screen that has read `GET /admin/doors` — it is passed, and the face is the club's
 * day. Where it is not yet known the browser's zone is used, which for a club volunteer
 * standing in the club is the same zone; what is never done is to guess a named zone.
 * </p>
 *
 * <p>
 * B20: nothing here prints a bare weekday. "Fri" is unambiguous across a 24-hour window and
 * ambiguous across a 7-day or 30-day one, and the log offers both — so a weekday always
 * carries its date.
 * </p>
 */

/** The one locale every doors face is written in. See the note above: a format, not a language. */
const CLUB_LOCALE = "en-GB";

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

/** "21:25" — a clock face in the club's day. */
export function clubClock(iso: string | number | Date, timezone?: string): string {
  return new Date(iso).toLocaleTimeString(CLUB_LOCALE, { ...CLOCK, timeZone: timezone });
}

/**
 * "Fri 19 Sep, 21:25" — a weekday AND its date, because the log ranges over 30 days.
 *
 * B20: the log's own empty state and its range boundary printed "Fri 18:40" against a
 * 7-day or 30-day filter, where four Fridays are in range and the reader cannot tell which.
 */
export function clubDayAndClock(iso: string | number | Date, timezone?: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString(CLUB_LOCALE, {
    weekday: "short", day: "numeric", month: "short", timeZone: timezone,
  });
  return `${day}, ${clubClock(date, timezone)}`;
}

/**
 * "19 September 2026, 21:25" — the long form, for a `title`, an accessible name and a
 * printed card, where the fact has to arrive once and completely.
 */
export function clubInstant(iso: string | number | Date, timezone?: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString(CLUB_LOCALE, {
    day: "numeric", month: "long", year: "numeric", timeZone: timezone,
  });
  return `${day}, ${clubClock(date, timezone)}`;
}

/**
 * What a ROW prints: the clock face, plus the day when the row is not today's.
 *
 * <p>
 * <b>A7 / E-M5.</b> Every row on every doors surface printed a relative age — "6m ago",
 * "2d ago" — with the exact time available only in a `title`. A `title` is invisible on a
 * phone, invisible to a screen reader, and invisible to anyone using touch, which is every
 * admin this surface was designed for. The question a committee asks is "what time did that
 * happen", and the screen would not answer it.
 * </p>
 *
 * <p>
 * <b>Relative age stays, as the SECOND thing on the row.</b> It is what makes a page feel
 * live, and "2 minutes ago" is the right answer to a different question. It is the ordering
 * that was wrong, not the presence.
 * </p>
 *
 * <p>
 * <b>And the zone is the club's, always.</b> O1: this surface had two clock formatters and
 * the feed did not pass a timezone to either, so an admin reading the log from a laptop in
 * another zone got their own midnight against the club's day boundary. The API sends
 * `timezone` on `/admin/doors` and, since WIRE-R2 §3, on the log too; every caller passes it.
 * </p>
 */
export function clubRowTime(iso: string | number | Date, now: number, timezone?: string): string {
  const date = new Date(iso);
  return isSameClubDay(date, new Date(now), timezone) ? clubClock(date, timezone) : clubDayAndClock(date, timezone);
}

/** Two instants in the CLUB's calendar day — never the browser's. */
function isSameClubDay(a: Date, b: Date, timezone?: string): boolean {
  const face = (d: Date) => d.toLocaleDateString(CLUB_LOCALE, {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: timezone,
  });
  return face(a) === face(b);
}

/**
 * The resolved range, in words, above the rows (A4).
 *
 * <p>
 * "Last 24 hours" is a rolling window and the page offered no way to ask for yesterday or for
 * one day, so a chair exporting "yesterday's" scans was handed half of yesterday and half of
 * today and had no way to tell. The range the SERVER resolved is the only range the page may
 * state — a second client-side computation of "24 hours ago" is a different instant from the
 * one the rows were read with, which is the defect the CSV filter already had to close.
 * </p>
 */
export function clubRangeInWords(
  range: { from: string; to: string } | null | undefined, timezone?: string,
): string | null {
  if (!range) return null;
  return `Scans from ${clubDayAndClock(range.from, timezone)} to ${clubDayAndClock(range.to, timezone)}, club time.`;
}

/** "19 September 2026" — a date with no clock, for the printed card's own footer. */
export function clubDate(iso: string | number | Date, timezone?: string): string {
  return new Date(iso).toLocaleDateString(CLUB_LOCALE, {
    day: "numeric", month: "long", year: "numeric", timeZone: timezone,
  });
}
