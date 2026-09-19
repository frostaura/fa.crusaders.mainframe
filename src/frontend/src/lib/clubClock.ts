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

/** "19 September 2026" — a date with no clock, for the printed card's own footer. */
export function clubDate(iso: string | number | Date, timezone?: string): string {
  return new Date(iso).toLocaleDateString(CLUB_LOCALE, {
    day: "numeric", month: "long", year: "numeric", timeZone: timezone,
  });
}
