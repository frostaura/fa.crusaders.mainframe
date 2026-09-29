import { WEEKDAYS, type ScheduleBody, type Weekday } from "./adminApi";

/**
 * The schedule arithmetic: which dates a weekly rule falls on, and how many slots that holds.
 *
 * <p>
 * <b>Everything here counts in club-local DATES, and nothing here builds an instant.</b> That
 * is not a stylistic preference; it is the whole reason D2 §11.1 rejected an RRULE engine in
 * favour of a bounded weekly rule stored as a weekday set, local minutes past midnight, and a
 * date range. A `YYYY-MM-DD` in this module is a fact about the club's calendar, exactly as
 * `2026-11-03` is a fact about the club's calendar, and turning it into a moment in time on
 * the way to counting it is how "every Tuesday at 18:00" becomes "every Tuesday at 17:00 from
 * November" — or, once somebody reads a date back out of the drifted instant, "every Monday".
 * `API/Services/DoorPeriod.cs:68-73` is where this codebase already established the idiom.
 * </p>
 *
 * <p>
 * <b>Dates are carried as strings and parsed through `Date.UTC`.</b> A UTC-anchored epoch day
 * is the same integer in every reader's zone, so `addDays` is exact whether the admin is in
 * the club, in Chicago on the morning the clocks went back, or in Auckland. The alternative —
 * `new Date("2026-11-01")` followed by a local `setDate` — reads UTC midnight through the
 * reader's own calendar and silently skips a day for every reader west of UTC.
 * </p>
 *
 * <p>
 * <b>This module is pure, total and has no opinions about wording.</b> It returns numbers,
 * dates and refusal codes; `lib/scheduleCopy.ts` turns those into sentences. Nothing here
 * throws: a half-typed rule in an editor is an ordinary state, not an error, and an editor
 * that throws on the third keystroke of a date is an editor nobody can use.
 * </p>
 */

/** A club-local calendar date, `YYYY-MM-DD`. Nothing else is accepted, anywhere in here. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A 24-hour clock face, `HH:mm`, zero-padded. `6:05` and `24:00` are not faces. */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MS_PER_DAY = 86_400_000;

/** The weekly rule, in the shape the editor holds it and the wire carries it. */
export type WeeklyRule = {
  days: readonly Weekday[];
  /** `HH:mm`, club-local. */
  start: string;
  end: string;
  startDate: string;
  endDate?: string | null;
  intervalWeeks?: number;
};

export type Enumeration = {
  /** Club-local dates, ascending. Empty is a real answer, not a failure. */
  dates: string[];
  /** The rule names no end date, so what follows is a horizon and not the whole series. */
  openEnded: boolean;
  /** The horizon or the cap stopped the walk before the rule did. */
  truncated: boolean;
};

export type EnumerationWindow = {
  /**
   * How far past the start date an open-ended rule is walked. The club's
   * `schedule_materialisation_days`, whose default D2 §11.3 sets at 60 — so what the editor
   * counts is what the server will actually have written by the time anybody looks.
   */
  horizonDays?: number;
  /** A hard stop, so a mis-typed century cannot hang the editor mid-keystroke. */
  maxOccurrences?: number;
};

/** One reason a sentence may not be checked yet, in D2 §11.8's own vocabulary. */
export type RuleRefusal = {
  code: string;
  /** Present on `schedule_not_slice_aligned`, because the admin needs the club's own number. */
  sliceMinutes?: number;
  /** Present on `schedule_too_large`, for the same reason. */
  rows?: number;
};

export type ValidationContext = {
  sliceMinutes: number;
  /**
   * Where the club's grid starts, in minutes past midnight. Slice boundaries are measured
   * from here, not from midnight — see {@link isSliceAligned}.
   */
  dayStartMinute?: number;
  /** `schedule_max_rows_per_change`; D2's default is 2000. */
  maxRows?: number;
  /**
   * The ids this club's active courts actually have — and `undefined` is a third answer.
   *
   * <p>
   * A page whose court list has not loaded, or whose court read failed, does not know that a
   * court is invalid. Telling an admin their courts are wrong out of a gap in our own
   * knowledge is the "unknown is never false" defect in its most expensive form: the sentence
   * is correct and the screen refuses to check it.
   * </p>
   */
  activeCourtIds?: readonly string[];
};

const DEFAULT_HORIZON_DAYS = 60;
const DEFAULT_MAX_OCCURRENCES = 400;
const DEFAULT_MAX_ROWS = 2000;
const MAX_INTERVAL_WEEKS = 8;
const NAME_MIN = 2;
const NAME_MAX = 128;
const LABEL_MAX = 128;

// ---------------------------------------------------------------------------------------
// Local-date arithmetic
// ---------------------------------------------------------------------------------------

/**
 * A club-local date as a whole number of days since the epoch, or null if it is not a date.
 *
 * Anchored at UTC on purpose: the integer this returns must not depend on where the reader
 * is standing, and `Date.UTC` is the only construction in the language that guarantees it.
 */
export function epochDay(date: string): number | null {
  const match = DATE_RE.exec(date);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = Date.UTC(year, month - 1, day);
  // Round-trip guard: `Date.UTC(2026, 1, 31)` is 3 March, and an editor that accepted
  // "2026-02-31" would enumerate a series a day out for the rest of its life.
  const back = new Date(utc);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return Math.round(utc / MS_PER_DAY);
}

/**
 * The club's calendar day right now — `YYYY-MM-DD`, in the club's zone.
 *
 * <p>
 * This is the one place in this module that starts from an instant, and it is the only one
 * that legitimately can: "now" IS an instant, and the question is which calendar day the club
 * is currently in. `en-CA` is used purely because its date format is ISO's; the club's reading
 * format is `lib/scheduleCopy`'s business, not this function's.
 * </p>
 *
 * <p>
 * <b>With no zone it answers the reader's own day and never guesses one.</b> That is the same
 * rule `lib/clubClock` follows, and here it is safe in a way a heading reading "club time"
 * would not be: the value is only ever the default in an editable date field, so an admin
 * whose browser is a day ahead of the club sees the wrong default and corrects it, rather than
 * being told something false. D3-B01..03 are this question's other face — a grid whose "today"
 * came out of UTC opened on yesterday every evening for a club east of Greenwich.
 * </p>
 */
export function clubToday(timezone?: string, now: number = Date.now()): string {
  try {
    return new Date(now).toLocaleDateString("en-CA", timezone ? { timeZone: timezone } : undefined);
  } catch {
    // `toLocaleDateString` throws a RangeError on a zone this engine does not know, and the
    // value comes from a settings column somebody typed. A throw here would blank the editor.
    return new Date(now).toLocaleDateString("en-CA");
  }
}

/** The inverse: a whole epoch day back to `YYYY-MM-DD`, read out of the UTC calendar. */
export function fromEpochDay(days: number): string {
  const date = new Date(days * MS_PER_DAY);
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `n` local days later (or earlier). Exact across every transition, because no zone is read. */
export function addDays(date: string, n: number): string {
  const day = epochDay(date);
  if (day === null) return date;
  return fromEpochDay(day + n);
}

/** Whole local days from `a` to `b`, negative when `b` is earlier. `null` for a non-date. */
export function daysBetween(a: string, b: string): number | null {
  const from = epochDay(a);
  const to = epochDay(b);
  if (from === null || to === null) return null;
  return to - from;
}

/** The club-local weekday, `0` = Sunday, matching `WEEKDAYS`' own order and `DayOfWeek`. */
export function weekdayIndex(date: string): number | null {
  const day = epochDay(date);
  if (day === null) return null;
  return new Date(day * MS_PER_DAY).getUTCDay();
}

/** The same thing in the product's one weekday spelling. */
export function weekdayOf(date: string): Weekday | null {
  const index = weekdayIndex(date);
  return index === null ? null : WEEKDAYS[index];
}

/**
 * The Monday that starts this date's ISO week.
 *
 * ISO weeks start on Monday, and a Sunday belongs to the week that started six days before
 * it — not to the one beginning the next morning. Getting that backwards shifts every
 * other-week series by exactly one week, which is a league night on the wrong Tuesday.
 */
export function isoWeekStart(date: string): string {
  const index = weekdayIndex(date);
  if (index === null) return date;
  // Sunday (0) is six days into its ISO week; every other day is `index - 1` days in.
  const offset = index === 0 ? 6 : index - 1;
  return addDays(date, -offset);
}

/**
 * Whether this date's week is one the interval lands on, anchored on the start date's week.
 *
 * An interval that is absent, zero or not a number means every week — the honest reading of a
 * field an editor has not filled in yet, and the one that cannot silently empty a series.
 */
export function inIntervalPhase(date: string, startDate: string, intervalWeeks?: number): boolean {
  const interval = Number.isFinite(intervalWeeks) ? Math.trunc(intervalWeeks as number) : 1;
  if (interval <= 1) return true;
  const gap = daysBetween(isoWeekStart(startDate), isoWeekStart(date));
  if (gap === null) return false;
  return (Math.round(gap / 7) % interval) === 0;
}

// ---------------------------------------------------------------------------------------
// Clock faces and slices
// ---------------------------------------------------------------------------------------

/** `"18:00"` → `1080`. Null for anything that is not a zero-padded 24-hour face. */
export function parseHhMm(face: string): number | null {
  const match = TIME_RE.exec(face ?? "");
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** `1080` → `"18:00"`. */
export function formatHhMm(minutes: number): string {
  const whole = Math.max(0, Math.trunc(minutes));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** How many slices one occurrence holds, on ONE court. Zero when the rule is not readable. */
export function slotsPerOccurrence(rule: Pick<WeeklyRule, "start" | "end">, sliceMinutes: number): number {
  const start = parseHhMm(rule.start);
  const end = parseHhMm(rule.end);
  if (start === null || end === null || !(sliceMinutes > 0) || end <= start) return 0;
  return Math.floor((end - start) / sliceMinutes);
}

/**
 * Whether both ends of the range land on one of the club's grid boundaries.
 *
 * <p>
 * <b>Both ends, not the duration — and D2's own example is why.</b> §11.8 words the rule as
 * "the range is a whole multiple of `slice_minutes`", and then §11.8 illustrates the harm
 * with 18:05–20:50, which is 165 minutes and therefore a whole multiple of 15. A
 * duration-only check accepts exactly the range it was written to refuse, and the club gets
 * two blanked grid cells every league night for a season. This is reported to the backend
 * lane as a wire question rather than assumed away.
 * </p>
 *
 * <p>
 * <b>Measured from the club's day start, not from midnight.</b> The grid's cells begin at
 * `day_start_minute`; on the club in the fixtures that is 06:00 and the two measurements
 * agree, which is exactly what would make a midnight-anchored implementation look correct
 * forever until a club sets an odd day start.
 * </p>
 */
export function isSliceAligned(
  startMinute: number, endMinute: number, sliceMinutes: number, dayStartMinute = 0,
): boolean {
  if (!(sliceMinutes > 0)) return false;
  const aligned = (minute: number) => ((minute - dayStartMinute) % sliceMinutes + sliceMinutes) % sliceMinutes === 0;
  return aligned(startMinute) && aligned(endMinute);
}

/** One `AdminBlock` row per court per occurrence — D2 §11.3's materialisation, counted. */
export function rowsToCreate(occurrences: number, courtCount: number): number {
  return Math.max(0, occurrences) * Math.max(0, courtCount);
}

/** The number a member would experience: slices taken off the grid across the whole series. */
export function slotsHeld(occurrences: number, courtCount: number, perOccurrence: number): number {
  return rowsToCreate(occurrences, courtCount) * Math.max(0, perOccurrence);
}

// ---------------------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------------------

/**
 * Every club-local date this rule falls on, ascending.
 *
 * <p>
 * The walk is day by day in local dates. It is bounded three ways — by the rule's own end
 * date, by the horizon for an open-ended rule, and by a hard cap — and it reports which of
 * the last two stopped it, because "10 Tuesdays" and "the first 10 of an unknown number of
 * Tuesdays" are different sentences and the editor must not write the first when it means the
 * second.
 * </p>
 */
export function enumerateOccurrences(rule: WeeklyRule, window: EnumerationWindow = {}): Enumeration {
  const horizonDays = window.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const maxOccurrences = window.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
  const openEnded = !rule.endDate;

  const first = epochDay(rule.startDate);
  const chosen = new Set(rule.days);
  if (first === null || chosen.size === 0) return { dates: [], openEnded, truncated: false };

  const horizonEnd = first + Math.max(0, horizonDays);
  const ruleEnd = rule.endDate ? epochDay(rule.endDate) : null;
  // An unreadable end date is treated as no end date rather than as "nothing happens": the
  // admin is mid-keystroke, and an editor that empties the series on "2026-12-1" is one that
  // flickers its consequence line at every character.
  const last = ruleEnd ?? horizonEnd;

  const walked = walkMatchingDays(rule, chosen, first, last, maxOccurrences);
  // Open-ended and we walked to the horizon: what we listed is a window, and the copy has to
  // say so. Cut short by the cap counts too, which is why this is an OR and not an assignment.
  const truncated = walked.truncated || (openEnded && ruleEnd === null);
  return { dates: walked.dates, openEnded, truncated };
}

/**
 * Every day in `[first, last]` the rule actually falls on, stopping at the cap.
 *
 * Separated from the window arithmetic above because the two reason about different things:
 * that decides WHERE to stop, this decides WHICH days inside it count. `truncated` here means
 * only "the cap stopped us" — the open-ended horizon is the caller's to fold in.
 */
function walkMatchingDays(
  rule: WeeklyRule,
  chosen: Set<string>,
  first: number,
  last: number,
  maxOccurrences: number,
): { dates: string[]; truncated: boolean } {
  const dates: string[] = [];
  for (let day = first; day <= last; day += 1) {
    if (dates.length >= maxOccurrences) return { dates, truncated: true };
    const date = fromEpochDay(day);
    const weekday = WEEKDAYS[new Date(day * MS_PER_DAY).getUTCDay()];
    if (!chosen.has(weekday)) continue;
    if (!inIntervalPhase(date, rule.startDate, rule.intervalWeeks)) continue;
    dates.push(date);
  }
  return { dates, truncated: false };
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

/** The time half of {@link validateRule}: the range itself, then its alignment to the grid. */
function validateTimes(rule: WeeklyRule, ctx: ValidationContext): RuleRefusal[] {
  const start = parseHhMm(rule.start);
  const end = parseHhMm(rule.end);
  if (start === null || end === null || end <= start) return [{ code: "schedule_time_range_invalid" }];
  if (!isSliceAligned(start, end, ctx.sliceMinutes, ctx.dayStartMinute ?? 0)) {
    return [{ code: "schedule_not_slice_aligned", sliceMinutes: ctx.sliceMinutes }];
  }
  return [];
}

/** The date half: the range, the interval, and how many rows the whole thing would write. */
function validateSpan(rule: WeeklyRule, ctx: ValidationContext, courtCount: number): RuleRefusal[] {
  const out: RuleRefusal[] = [];
  const startDay = epochDay(rule.startDate);
  const endDay = rule.endDate ? epochDay(rule.endDate) : null;
  if (startDay === null || (rule.endDate && endDay === null) || (endDay !== null && endDay < startDay)) {
    out.push({ code: "schedule_date_range_invalid" });
  }
  const interval = rule.intervalWeeks ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL_WEEKS) {
    out.push({ code: "schedule_interval_out_of_range" });
  }
  const maxRows = ctx.maxRows ?? DEFAULT_MAX_ROWS;
  // Counted against the same cap the server applies, with the cap itself as the walk's
  // bound plus one — enough to prove it is over without walking a century to find out.
  const { dates } = enumerateOccurrences(rule, { maxOccurrences: maxRows + 1 });
  const rows = rowsToCreate(dates.length, courtCount);
  if (rows > maxRows) out.push({ code: "schedule_too_large", rows });
  return out;
}

/**
 * Every reason this sentence may not be checked yet, in D2 §11.8's vocabulary.
 *
 * <p>
 * <b>The server is still the authority.</b> This exists so the editor can keep its own Check
 * button honest — a button that posts a sentence the server will certainly refuse is a
 * network round trip spent to tell an admin something the screen already knew — and so the
 * refusal an admin reads is the same sentence in both cases. It is not a substitute for the
 * server's own validation and never sees the two rules only the server can check:
 * `schedule_name_taken` and `schedule_limit_reached`.
 * </p>
 */
export function validateRule(body: ScheduleBody | (WeeklyRule & {
  name: string; label: string; courts: readonly string[];
}), ctx: ValidationContext): RuleRefusal[] {
  const out: RuleRefusal[] = [];
  const name = (body.name ?? "").trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) out.push({ code: "schedule_name_invalid" });
  const label = (body.label ?? "").trim();
  if (label.length < 1 || label.length > LABEL_MAX) out.push({ code: "schedule_label_invalid" });

  const days = body.days ?? [];
  if (days.length === 0 || days.some((d) => !WEEKDAYS.includes(d))) out.push({ code: "schedule_days_invalid" });

  out.push(...validateTimes(body, ctx));

  const courtIds = body.courts ?? [];
  const known = ctx.activeCourtIds;
  // Unknown is never false: with no court list we decline to judge the courts at all.
  if (courtIds.length === 0 || (known !== undefined && courtIds.some((id) => !known.includes(id)))) {
    out.push({ code: "schedule_courts_invalid" });
  }

  out.push(...validateSpan(body, ctx, courtIds.length));
  return out;
}
