/**
 * The club day of a step (`docs/specs/member-code.md` §3.6): the tenant-local calendar date of
 * the step's FIRST instant, `step × 30` seconds, as `YYYY-MM-DD`.
 *
 * <p>
 * <b>Built from `formatToParts`, never from a formatted string.</b> The layout of
 * `toLocaleDateString` is locale DATA — the order of the fields, the separators, even the
 * digits — and it is data the phone does not control. The year, month and day parts are
 * numbers whatever the locale, so joining them is the only construction that means the same
 * thing on every phone. `en-US` with `numberingSystem: "latn"` pins the digits to ASCII.
 * </p>
 *
 * <p>
 * A zone the runtime does not know throws `RangeError` from the constructor; that is left to
 * propagate, because a club day computed in the wrong zone is a K_day the server never derived
 * and every code the phone showed would be refused offline.
 * </p>
 */

export const STEP_MS = 30_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", numberingSystem: "latn",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Throws when this runtime cannot compute a club day in `tz`. */
export function assertKnownZone(tz: string): void {
  formatter(tz);
}

/** `YYYY-MM-DD` in `tz` for the first instant of `step`. */
export function clubDayOf(step: number, tz: string): string {
  const parts = formatter(tz).formatToParts(new Date(step * STEP_MS));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const year = part("year").padStart(4, "0");
  return `${year}-${part("month")}-${part("day")}`;
}

/**
 * The club day's half-open step range `[first, end)` — midnight to the next local midnight.
 *
 * <p>
 * The phone does not need this to make a code; it is here so the vitest reader can execute
 * every field of `clubday.json` rather than a convenient subset (the corpus's anti-drift rule:
 * executed equals declared). Found by bisection over at most 3 120 steps each way — the
 * widest real day (Antarctica/Troll's two-hour shift) — so it is exact on a DST day.
 * </p>
 */
export function clubDayRange(step: number, tz: string): { first: number; end: number } {
  const day = clubDayOf(step, tz);
  const MAX = 3_120;
  // The first step whose day is `day`: the answer lies in (step - MAX, step].
  let lo = step - MAX;
  let hi = step;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (clubDayOf(mid, tz) === day) hi = mid; else lo = mid;
  }
  const first = hi;
  // The first step AFTER the day: the answer lies in (step, step + MAX].
  lo = step;
  hi = step + MAX;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (clubDayOf(mid, tz) === day) lo = mid; else hi = mid;
  }
  return { first, end: hi };
}
