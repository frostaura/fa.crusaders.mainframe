import { WEEKDAYS, type ScheduleConflict, type Weekday } from "./adminApi";
import { clubCalendarDate, clubClock, clubDayAndClock } from "./clubClock";
import { epochDay, weekdayOf } from "./scheduleRules";
import { formatCredits } from "./utils";

/**
 * Every sentence the repeating-bookings surface says, as pure functions returning strings.
 *
 * <p>
 * The shape is `doorsCopy.ts`'s, and so is the reason: the same sentence is needed in a
 * button's label, in an `aria-label` and in a result row, and the third copy of it is where
 * they start to disagree. On this surface that matters more than usual, because the primary
 * button's label deliberately restates the option the admin chose — so the last thing read
 * before the press is what will happen. A label composed at the call site is a label that can
 * say something the panel above it does not.
 * </p>
 *
 * <p>
 * <b>Absent is a third arm everywhere, not a synonym for zero.</b> Three backend lanes are
 * writing these endpoints in parallel with this screen, so `would_refund_credits`,
 * `next_occurrence` and the materialisation count will arrive missing for a while. A refund
 * phrase that reads a missing quote as "nothing would go back" states the opposite of the
 * truth, immediately above a control that issues refunds.
 * </p>
 *
 * <p>
 * <b>Bare club-local dates are formatted here and never handed to `lib/clubClock`.</b> That
 * module writes INSTANTS in the club's zone, which is right for `next_occurrence` and for a
 * change record's `occurred_at`. A `YYYY-MM-DD` from a schedule is not an instant — it is a
 * fact about the club's calendar — and turning it into one to format it is the DST bug
 * `scheduleRules` exists to avoid, in the last place anybody would look for it. So the two
 * functions below build a UTC date and format it pinned to UTC, which is the same string in
 * every reader's zone, in the same `en-GB` face the rest of the product uses.
 * </p>
 */

const CLUB_LOCALE = "en-GB";

const WEEKDAY_NAMES: Record<Weekday, string> = {
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday",
  thu: "Thursday", fri: "Friday", sat: "Saturday",
};

/** "Tuesday". */
export function weekdayName(day: Weekday): string { return WEEKDAY_NAMES[day]; }

/** "Tuesdays". Every English weekday pluralises with an `s`; none of them is irregular. */
export function weekdayPlural(day: Weekday): string { return `${WEEKDAY_NAMES[day]}s`; }

/** "Court 1, Court 2 and Court 3" → the way a person reads a list out loud. */
function joinWords(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "Tuesdays and Thursdays", in week order however they were ticked.
 *
 * Order is not cosmetic here: a sentence reading "Fridays, Mondays and Wednesdays" makes a
 * reader stop and work out whether the screen means something by the order. It does not.
 */
export function daysPhrase(days: readonly Weekday[]): string {
  const chosen = WEEKDAYS.filter((d) => days.includes(d));
  if (chosen.length === 0) return "no days yet";
  if (chosen.length === WEEKDAYS.length) return "every day";
  return joinWords(chosen.map(weekdayPlural));
}

/**
 * "10 Tuesdays" — or "10 dates" when the rule names more than one weekday.
 *
 * There is no noun that is true of a Tuesday and a Thursday at once, and "10 Tuesdays and
 * Thursdays" is not a count of anything. The fallback is plain and correct.
 */
export function occurrencesNoun(count: number, days: readonly Weekday[]): string {
  const single = days.length === 1 ? days[0] : null;
  const noun = single
    ? (count === 1 ? weekdayName(single) : weekdayPlural(single))
    : (count === 1 ? "date" : "dates");
  return `${count === 0 ? "no" : count} ${noun}`;
}

/**
 * "Courts 1, 2 and 3" where the names share a prefix, and the names in full where they do not.
 *
 * A club that calls its courts "Glass court" and "Back court" must not be handed "Courts
 * Glass court and Back court"; a club on the default names must not be handed the word
 * "Court" three times in one clause.
 */
export function courtsPhrase(names: readonly string[]): string {
  if (names.length === 0) return "no courts yet";
  if (names.length === 1) return names[0];
  const suffixes = names.map((n) => /^Court (.+)$/.exec(n)?.[1] ?? null);
  if (suffixes.every((s): s is string => s !== null)) return `Courts ${joinWords(suffixes)}`;
  return joinWords(names);
}

// ---------------------------------------------------------------------------------------
// Bare club-local dates. See the header: these never become instants.
// ---------------------------------------------------------------------------------------

function utcDateFor(date: string): Date | null {
  const day = epochDay(date);
  return day === null ? null : new Date(day * 86_400_000);
}

/** "Tue 6 Oct" — a weekday AND its date, because a bare weekday is ambiguous over a season. */
export function clubDateShort(date: string): string {
  // The product's one short date (lib/clubClock) — never ICU's en-GB "Sept".
  return utcDateFor(date) ? clubCalendarDate(date) : date;
}

/** "6 October 2026" — the long form, for a consequence line and an accessible name. */
export function clubDateLong(date: string): string {
  const utc = utcDateFor(date);
  if (!utc) return date;
  return utc.toLocaleDateString(CLUB_LOCALE, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------------------

export type RuleWords = {
  courtNames: readonly string[];
  days: readonly Weekday[];
  start: string;
  end: string;
  label: string;
  startDate: string;
  endDate?: string | null;
  intervalWeeks?: number;
};

/** The whole rule as one readable line — the list row's subtitle and the detail page's lede. */
export function ruleSentence(rule: RuleWords): string {
  const interval = rule.intervalWeeks ?? 1;
  const when = interval > 1
    ? `every ${interval} weeks on ${daysPhrase(rule.days)}`
    : `on ${daysPhrase(rule.days)}`;
  const named = rule.label ? `, called “${rule.label}”` : "";
  return `Holds ${courtsPhrase(rule.courtNames)} ${when} from ${rule.start} to ${rule.end}${named}, ${datesPhrase(rule.startDate, rule.endDate)}.`;
}

/**
 * The dates the rule runs between. Ended before its first date (review round 3, A-6): "from Wed
 * 30 Sep until Tue 29 Sep" read as a range running backwards. An ISO date compares as text.
 */
function datesPhrase(startDate: string, endDate?: string | null): string {
  const from = `from ${clubDateShort(startDate)}`;
  if (!endDate) return `${from} with no end date`;
  if (endDate < startDate) return `${from} — it ended before that first date`;
  return `${from} until ${clubDateShort(endDate)}`;
}

export type ConsequenceInput = {
  occurrences: number;
  days: readonly Weekday[];
  courtCount: number;
  slotsPerOccurrence: number;
  label: string;
  truncated: boolean;
  openEnded: boolean;
  horizonDays?: number;
};

/** "Members will see “League night” and cannot book them." — or the unnamed half of it. */
function membersClause(label: string, slots: number): string {
  if (!label) return "Members will see this hold on the grid and cannot book those slots.";
  return `Members will see “${label}” and cannot book ${slots === 1 ? "it" : "them"}.`;
}

/**
 * The plain consequence, regenerated under the sentence as it is typed.
 *
 * <p>
 * Four arms, and three of them are the ones a screen usually gets wrong: a half-typed rule
 * asks for the missing half rather than computing the consequence of nothing; a rule that
 * matches no dates says so instead of printing "0 slots held"; and an open-ended rule says
 * what it counted and that the series carries on, because "That is 9 Tuesdays" is a false
 * total for a series with no end.
 * </p>
 */
export function consequenceLine(input: ConsequenceInput): string {
  const { occurrences, days, courtCount, slotsPerOccurrence, label } = input;
  if (courtCount <= 0) return "Choose at least one court to see what this would hold.";
  if (slotsPerOccurrence <= 0) return "Set a start and an end time to see what this would hold.";
  if (occurrences <= 0) return `That is ${occurrencesNoun(0, days)} in those dates, so nothing would be held.`;

  const slots = occurrences * courtCount * slotsPerOccurrence;
  const courts = `${courtCount} court${courtCount === 1 ? "" : "s"}`;
  const per = `${slotsPerOccurrence} slot${slotsPerOccurrence === 1 ? "" : "s"}`;
  const held = `${courts} × ${per} = ${slots} slot${slots === 1 ? "" : "s"} held`;

  if (input.openEnded || input.truncated) {
    const horizon = input.horizonDays ? `the next ${input.horizonDays} days` : "the dates worked out so far";
    const carries = input.openEnded ? ", and it carries on after that" : "";
    return `That is ${occurrencesNoun(occurrences, days)} in ${horizon}${carries}. `
      + `${held} so far. ${membersClause(label, slots)}`;
  }
  return `That is ${occurrencesNoun(occurrences, days)}. ${held}. ${membersClause(label, slots)}`;
}

// ---------------------------------------------------------------------------------------
// The clash check
// ---------------------------------------------------------------------------------------

/** "Check 10 Tuesdays" — and a label that promises no count when there is none to promise. */
export function checkLabel(occurrences: number, days: readonly Weekday[]): string {
  if (occurrences <= 0) return "Check these dates";
  return `Check ${occurrencesNoun(occurrences, days)}`;
}

export function checkingLabel(occurrences: number, days: readonly Weekday[]): string {
  if (occurrences <= 0) return "Checking…";
  return `Checking ${occurrencesNoun(occurrences, days)}…`;
}

/**
 * The failed arm, and the one rule that governs it: this sentence is never followed by a
 * control that writes. A check that did not finish is not evidence that nothing is in the way.
 */
export const CHECK_FAILED = "The check didn't finish, so nothing was created. Try again.";

/** A check that no longer describes the sentence above it is not a licence to write either. */
export const CHECK_STALE =
  "The sentence changed after that check, so it no longer says what would happen. Check again.";

export function nothingInTheWay(
  { slots, occurrences, days }: { slots: number; occurrences: number; days: readonly Weekday[] },
): string {
  const allSlots = slots === 1 ? "The 1 slot is free" : `All ${slots} slots are free`;
  const allDates = occurrences === 1
    ? `on the ${occurrencesNoun(1, days)}`
    : `on all ${occurrencesNoun(occurrences, days)}`;
  return `Nothing is in the way. ${allSlots} ${allDates}.`;
}

export function conflictsHeadline(count: number): string {
  return `${count} booking${count === 1 ? " is" : "s are"} in the way.`;
}

/** Said in the same breath as the count, because it is the half an admin is scanning for. */
export const NOTHING_CHANGED_YET = "Nothing has changed yet.";

/**
 * What cancelling this one booking would pay back — with the arm for a quote we have not got.
 *
 * `would_refund_credits` comes from the server's own `QuoteCancellationAsync`, so when it is
 * there it is the figure the cancellation will actually pay. When it is absent the honest
 * answer is that we do not know, and it is not zero: this sentence is read immediately above
 * the control that issues the refund.
 */
export function conflictRefundPhrase(
  conflict: Pick<ScheduleConflict, "would_refund_credits" | "member_name">,
): string {
  const to = conflict.member_name ? ` to ${conflict.member_name}` : "";
  const amount = conflict.would_refund_credits;
  if (amount === undefined || amount === null) return `What would go back${to} isn't known yet.`;
  if (amount === 0) return `Nothing would go back${to}.`;
  return `${formatCredits(amount)} would go back${to}.`;
}

/** The primary button's label, restating the option chosen — including the unknown total. */
export function clearAllLabel(count: number, totalCredits: number | null): string {
  const bookings = `${count} booking${count === 1 ? "" : "s"}`;
  if (totalCredits === null) return `Cancel ${bookings} and refund them in full`;
  return `Cancel ${bookings} and refund ${formatCredits(totalCredits)} in full`;
}

export const CREATE_LABEL = "Create the hold";

// ---------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------

/**
 * A sentence for every refusal D2 §11.8 can answer with, for `describeFailure`'s `codes`.
 *
 * The two that are about numbers take the club's own — and stay true when the club's settings
 * have not loaded, which is the arm a hardcoded 15 would hide for as long as every club used
 * 15-minute slices.
 */
export function scheduleCodes(
  { sliceMinutes, maxRows }: { sliceMinutes?: number; maxRows?: number },
): Record<string, string> {
  const marks = sliceMinutes
    ? `This club books in ${sliceMinutes}-minute slots, so the start and the end both have to land on a ${sliceMinutes}-minute mark.`
    : "The start and the end both have to land on one of the club's booking marks.";
  const tooLarge = maxRows
    ? `That is more than the ${maxRows} slots this club will hold in one go. Shorten the dates, or use fewer courts.`
    : "That is more slots than this club will hold in one go. Shorten the dates, or use fewer courts.";
  return {
    schedule_name_invalid: "Give it a name of 2 to 128 characters, so it can be found again later.",
    schedule_name_taken: "There is already a repeating booking with that name. Give this one a different name.",
    schedule_label_invalid: "Give it a label of 1 to 128 characters — the label is what members see on the grid.",
    schedule_days_invalid: "Choose at least one day of the week.",
    schedule_time_range_invalid: "The end time has to be after the start time, on the same day.",
    schedule_not_slice_aligned: marks,
    schedule_interval_out_of_range: "Repeat every 1 to 8 weeks.",
    schedule_date_range_invalid: "The last date has to be on or after the first one.",
    schedule_courts_invalid: "Choose at least one court this club still has.",
    schedule_too_large: tooLarge,
    schedule_limit_reached:
      "This club already has as many repeating bookings as it can have. End one it no longer needs first.",
    // The world moved between the check and the save. Said as what happened, not as a code.
    schedule_conflicts:
      "Something was booked in the way while you were reading. Nothing has been created — check again to see what changed.",
    occurrence_in_past:
      "That date has already happened, so it cannot be changed. What already happened stays as it happened.",
    advance_days_exceed_schedule_horizon:
      "Members can book further ahead than this club writes its repeating bookings, so a member could book into a night that has not been held yet. An admin needs to change one of those two numbers in Admin settings.",
  };
}

// ---------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------

function weekdayWordFor(date: string): string {
  const day = weekdayOf(date);
  return day ? weekdayName(day) : "date";
}

export function editScopeQuestion(date: string): string {
  const word = weekdayWordFor(date);
  return `Change which ${word}s?`;
}

export function editScopeOptions(date: string): { only: string; future: string } {
  return {
    only: `Just ${clubDateShort(date)}`,
    future: `${clubDateShort(date)} and every ${weekdayWordFor(date)} after it`,
  };
}

/**
 * The third fact, stated whether or not anyone asked.
 *
 * D2 §11.5 makes the past immutable mechanically — every re-materialisation is
 * `WHERE StartsAt > now()` — so this sentence is describing the system rather than promising
 * on its behalf, which is the only kind of reassurance worth printing.
 */
export function pastNeverChanges(date: string): string {
  return `${weekdayWordFor(date)}s before ${clubDateLong(date)} never change `
    + "— what already happened stays as it happened.";
}

/** `effective_from` is clamped, never refused — and the screen says so when it comes back. */
export function clampedNotice(clampedTo: string): string {
  return `That date has already passed, so the change starts from ${clubDateLong(clampedTo)} instead. `
    + "Dates before then are unchanged.";
}

// ---------------------------------------------------------------------------------------
// Skipping, and ending
// ---------------------------------------------------------------------------------------

/** The chip is a control, so it is labelled by what pressing it does — not by what it is. */
export function skipChipLabel(date: string): string {
  return `${clubDateLong(date)} — restore this ${weekdayWordFor(date)}`;
}

/** Said before the skip, not after: it is the half an admin is deciding on. */
export function skipConsequence(courtCount: number, date: string): string {
  const courts = courtCount === 1 ? "1 court opens" : `${courtCount} courts open`;
  const them = courtCount === 1 ? "it" : "them";
  return `${courts} back up on ${clubDateLong(date)}. Members will be able to book ${them}.`;
}

export type EndWords = {
  /** Null when the dates could not be read — never rendered as "0 more". */
  remaining: number | null;
  days: readonly Weekday[];
  /** Null when we cannot count what is held — never rendered as zero. */
  slots: number | null;
  /** A hold charges nobody, so this is 0 for every hold. Stated rather than left to inference. */
  refundCredits: number;
  /** The dates still ahead (club-local), so they are counted by their own weekdays (R5 A5-4). */
  dates?: readonly string[];
};

/** "Tuesday" / "date" — the noun without its count, for a sentence that supplies its own. */
function singularNoun(days: readonly Weekday[]): string {
  return days.length === 1 ? weekdayName(days[0]) : "date";
}

function pluralNoun(days: readonly Weekday[]): string {
  return days.length === 1 ? weekdayPlural(days[0]) : "dates";
}

/**
 * "5 more dates (1 Saturday and 4 Sundays)" — the dates still ahead counted by their OWN
 * weekdays (R5 A5-4): a series changing from Saturdays to Sundays said "5 more Saturdays" from its
 * latest rule when four of them were Sundays. One weekday reads as before ("4 more Sundays").
 */
function remainingPhrase(remaining: number, days: readonly Weekday[], dates?: readonly string[]): string {
  const counts = new Map<Weekday, number>();
  for (const date of dates ?? []) {
    const day = weekdayOf(date);
    if (day) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  if (counts.size === 1) {
    const [day] = [...counts.keys()];
    return `${remaining} more ${remaining === 1 ? weekdayName(day) : weekdayPlural(day)}`;
  }
  if (counts.size > 1) {
    // In the order the dates come (a Map keeps it): the Saturday before the Sundays it turns into.
    const parts = [...counts].map(([d, n]) => `${n} ${n === 1 ? weekdayName(d) : weekdayPlural(d)}`);
    return `${remaining} more dates (${joinWords(parts)})`;
  }
  return `${remaining} more ${remaining === 1 ? singularNoun(days) : pluralNoun(days)}`;
}

export function endConsequence({ remaining, days, slots, refundCredits, dates }: EndWords): string {
  const stops = remaining === null
    ? "Ending this stops every date still ahead"
    : `Ending this stops ${remainingPhrase(remaining, days, dates)}`;
  const release = slots === null
    ? `${stops}, and the slots it was holding can be booked again.`
    : `${stops} and releases ${slots} held slot${slots === 1 ? "" : "s"}, which members can then book.`;
  const money = refundCredits > 0
    ? `${formatCredits(refundCredits)} goes back to the members who paid.`
    : "Nobody is refunded — nobody was charged for a hold.";
  const past = days.length === 1 && !mixedWeekdays(dates)
    ? `${weekdayPlural(days[0])} that have already happened stay exactly as they are.`
    : "Dates that have already happened stay exactly as they are.";
  return `${release} ${money} ${past}`;
}

function mixedWeekdays(dates?: readonly string[]): boolean {
  return new Set((dates ?? []).map(weekdayOf).filter(Boolean)).size > 1;
}

/** The day chooser of a "from this date on" change (R5 A5-4). */
export function daysFromLegend(date: string): string {
  return `Days from ${clubDateShort(date)} on`;
}

// ---------------------------------------------------------------------------------------
// Earlier and later rules (R5 A5-4)
// ---------------------------------------------------------------------------------------

type RuleSpanWords = {
  from: string; days: readonly Weekday[]; start: string; end: string; interval_weeks: number; in_force: boolean;
};

/** The rule governing today: the one marked in force, else the earliest (an older API: none). */
export function ruleInForce<T extends RuleSpanWords>(rules: readonly T[] | undefined): T | null {
  if (!rules || rules.length === 0) return null;
  return rules.find((r) => r.in_force) ?? rules[0];
}

/**
 * "From Sun 1 Nov it holds Sundays, 18:00 to 20:00, instead." — one line per rule still to come,
 * so the header says what holds NOW and what changes from when (R5 A5-4: it described only the
 * latest rule, and "Next on" and the End count followed it).
 */
export function laterRuleLines(rules: readonly RuleSpanWords[] | undefined): string[] {
  const now = ruleInForce(rules);
  if (!rules || !now) return [];
  return rules.slice(rules.indexOf(now) + 1).map((rule) => {
    const every = rule.interval_weeks > 1 ? ` every ${rule.interval_weeks} weeks` : "";
    return `From ${clubDateShort(rule.from)} it holds ${daysPhrase(rule.days)}${every}, ${rule.start} to ${rule.end}, instead.`;
  });
}

// ---------------------------------------------------------------------------------------
// The list, and the detail page
// ---------------------------------------------------------------------------------------

export const LIST_EMPTY_TITLE = "No repeating bookings running.";

/**
 * The "Running now" list is empty — which says nothing about ended ones (review round 3, A-6:
 * it said "No repeating bookings yet." over a club whose only schedule had just been ended).
 */
export const LIST_EMPTY_ENDED_POINTER = "Ones that have ended are under “Ended”.";

/** The dates card with no rows: a new schedule is still being written; an ended one holds none. */
export const DATES_EMPTY = {
  title: "No dates yet.",
  hint: "They are written a few weeks ahead, so a new one can take a minute to appear.",
  endedTitle: "No dates — this has ended.",
  endedHint: "An ended repeating booking holds nothing from its last date on.",
} as const;

/**
 * The next date that is really held (review round 3, A-6): after a skip, `next_occurrence` still
 * named the skipped date. Once the dates are read, the first held or moved one is the answer;
 * until then (or where none is listed) the server's figure stands.
 */
export function nextHeldOccurrence(
  next: string | null | undefined,
  occurrences: ReadonlyArray<{ status?: string; starts_at?: string }> | null,
): string | null | undefined {
  if (occurrences === null) return next;
  const held = occurrences.find((o) => (o.status === "scheduled" || o.status === "overridden") && o.starts_at);
  return held?.starts_at ?? next;
}

/** The date that is really held next, with its own start and end (A4-3), or null while unknown. */
export function nextHeldDate<T extends { status?: string; starts_at?: string; ends_at?: string }>(
  occurrences: readonly T[] | null,
): T | null {
  return occurrences?.find((o) => (o.status === "scheduled" || o.status === "overridden") && o.starts_at) ?? null;
}

/**
 * One held date's own hours, "18:00–19:30" (review round 4, A4-3). A "from this date on" change
 * leaves the dates before it at the hours they were booked at, and the list showed only the date
 * — so an admin saw the new rule over dates the courts were really held at 18:00.
 */
export function occurrenceHours(occurrence: { starts_at?: string; ends_at?: string }, timezone?: string): string | null {
  if (!occurrence.starts_at || !occurrence.ends_at) return null;
  return `${clubClock(occurrence.starts_at, timezone)}–${clubClock(occurrence.ends_at, timezone)}`;
}

/**
 * When the rule's hours differ from some dates still held (A4-3): the first held date at the
 * rule's hours, said as "from", and that the dates before it keep theirs. Null when every held
 * date is at the rule's hours, or when none is (nothing to say "from").
 */
export function hoursFromLine(
  rule: { start?: string; end?: string },
  occurrences: ReadonlyArray<{ date: string; status?: string; starts_at?: string; ends_at?: string }> | null,
  timezone?: string,
): string | null {
  if (!occurrences || !rule.start || !rule.end) return null;
  const ruleHours = `${rule.start}–${rule.end}`;
  const held = occurrences.filter((o) => (o.status === "scheduled" || o.status === "overridden") && o.starts_at);
  const first = held.findIndex((o) => occurrenceHours(o, timezone) === ruleHours);
  if (first <= 0) return null;
  const earlier = held.slice(0, first).filter((o) => occurrenceHours(o, timezone) !== ruleHours);
  if (earlier.length === 0) return null;
  return `These hours apply from ${clubDateShort(held[first].date)}. `
    + `${earlier.length === 1 ? "The date before it keeps the hours it was" : `The ${earlier.length} dates before it keep the hours they were`} booked at — see each date below.`;
}

/** The empty state teaches the feature rather than restating the heading. */
export const LIST_EMPTY_HINT =
  "A repeating booking is how you hold Tuesday nights for the league "
  + "without booking 360 slots by hand.";

/** The read failed, so it is silent about whether the club has any. */
export const LIST_FAILED_CAVEAT = "That does not mean the club has none.";

/**
 * Three arms on the next date, because an absent field is not "there are no more".
 *
 * A schedule the backend has not shipped `next_occurrence` for is not a schedule that has
 * finished, and a list saying "no more dates" against a live league night is the screen
 * asserting an ending out of its own gap.
 */
export function nextOccurrenceLine(
  next: string | null | undefined, status: string | undefined, timezone?: string, endsAt?: string | null,
): string {
  if (next && endsAt) return `Next on ${clubDayAndClock(next, timezone)}–${clubClock(endsAt, timezone)}.`;
  if (next) return `Next on ${clubDayAndClock(next, timezone)}.`;
  if (status === "ended") return "This has ended — there are no more dates.";
  return "The next date hasn't been worked out yet.";
}

/**
 * The partial arm: some of the series is written and some is still being written.
 *
 * `null` for `held` is the honest answer when the occurrences read carries no court rows at
 * all, and it returns no sentence — an unknown proportion is not "all of them" and it is not
 * "none of them" either.
 */
export function partialMaterialisation(
  held: number | null, total: number, days: readonly Weekday[],
): string | null {
  if (held === null || held >= total) return null;
  const outstanding = total - held;
  return `${held} of ${occurrencesNoun(total, days)} are held. `
    + `${outstanding} ${outstanding === 1 ? "is" : "are"} still being created — check back in a minute.`;
}

const STATUS_WORDS: Record<string, string> = {
  scheduled: "Held", skipped: "Skipped", overridden: "Moved", past: "Already happened",
};

/** A word per state, and a word for the state we were not told — never a blank cell. */
export function occurrenceStatusWord(status: string | undefined): string {
  return (status && STATUS_WORDS[status]) ?? "Not known";
}

/**
 * A write whose reply was lost, read back (review round 3): what the record still shows, and
 * what cannot be told. Composed by `lib/lostReplyCopy`'s `unsureWords`.
 */
export const SCHEDULE_LOST = {
  stillHeld: (date: string) => `${clubDateShort(date)} is still held`,
  whetherSkipped: (date: string) => `${clubDateShort(date)} was skipped`,
  stillSkipped: (date: string) => `${clubDateShort(date)} is still skipped`,
  whetherRestored: (date: string) => `${clubDateShort(date)} was restored`,
  stillRunning: "it is still running",
  whetherEnded: "it was ended",
  hoursUnchanged: (date: string) => `${clubDateShort(date)} still has its old hours`,
  whetherHours: (date: string) => `the hours of ${clubDateShort(date)} changed`,
} as const;

/** Ruling 2's sentence, verbatim: both halves said, and no softer word than "nobody". */
export const CHANGES_UNDELETABLE = "Nobody can delete these from the app, including admins.";

/** What the change list is, above the rows. */
export const CHANGES_HEADING = "What has been changed here";
