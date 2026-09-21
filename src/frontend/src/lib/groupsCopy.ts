import { ApiError } from "./api";
import { describeFailure } from "./errors";
import type { AdminItemResult, GroupPricingMode, Weekday } from "./adminApi";
import {
  UNLIMITED, WEEK_IN_READING_ORDER, capOverrideIsInert, countSlots, formatClock, intersect,
  type Interval,
} from "./groupRules";

/**
 * Every sentence the groups surface says — GOAL items 3 + 19.
 *
 * <p>
 * <b>Pure functions returning sentences, no JSX, both halves of every conditional</b> — the
 * shape `doorsCopy.ts` established, and for its reason: the same sentence is needed in a button
 * label, in an `aria-label` and in a result row, and the third copy of it is what drifts.
 * </p>
 *
 * <p>
 * <b>The painter's summary is the primary rendering of the rule, not a caption under it.</b> A
 * screen-reader user gets that sentence INSTEAD of a 7 × 56 grid of cells, so it has to be
 * correct rather than decorative — which is why it is generated from the same intervals the
 * grid paints from and counted against the club's own slice, never against an assumed 15.
 * </p>
 *
 * <p>
 * <b>No instant is formatted anywhere in this file.</b> Every face here is a wall-clock time
 * inside the club's own day, and a `YYYY-MM-DD` or an `HH:mm` turned into a `Date` in order to
 * print it is the DST bug in the last place anybody looks — the same note `scheduleCopy.ts`
 * carries. Where this surface prints a real instant (when a member was added to a group) it
 * goes through `lib/clubClock`, at the call site.
 * </p>
 */

// ---------------------------------------------------------------------------------------
// The standing statement
// ---------------------------------------------------------------------------------------

/**
 * The rule, its consequence, and the thing it does NOT override — above everything on the page.
 *
 * The third sentence is the half an admin forgets: a group can tighten the club's limits and
 * can never lift them, so a club that wonders why its "8 slots" group still gets 4 has the
 * answer on screen before it asks.
 */
export const MOST_RESTRICTIVE_STANDING
  = "When two rules disagree, the strictest one wins. A member in two groups can book only "
  + "where both allow it. The club-wide limits under Booking apply on top of every group — a "
  + "group can tighten them and can never lift them.";

export const GROUPS_READ_FAILED = "Couldn't read the club's groups. Nothing has changed.";

export const GROUPS_EMPTY_TITLE
  = "No groups yet. Everyone can book any open slot at the club's standard rate.";

export const STALE_PREVIEW
  = "Someone changed the club's opening hours while this was open, so the preview below is "
  + "from the old ones. Close and reopen it.";

export const PAINTER_INSTRUCTIONS
  = "Paint the times this group is allowed to book. Anything you leave unpainted, they cannot "
  + "book. Drag to paint, hold Alt and drag to erase, or use the arrow keys and Space.";

// ---------------------------------------------------------------------------------------
// Weekdays
// ---------------------------------------------------------------------------------------

const DAY_NAME: Record<Weekday, string> = {
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday",
  thu: "Thursday", fri: "Friday", sat: "Saturday",
};

const DAY_PLURAL: Record<Weekday, string> = {
  sun: "Sundays", mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays",
  thu: "Thursdays", fri: "Fridays", sat: "Saturdays",
};

export function dayName(day: Weekday): string { return DAY_NAME[day] ?? day; }
export function dayPlural(day: Weekday): string { return DAY_PLURAL[day] ?? day; }

/** "A", "A and B", "A, B and C" — a list a person reads, not one joined with commas throughout. */
function listOf(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------------------
// The painter's summary
// ---------------------------------------------------------------------------------------

export type PaintedWeek = Partial<Record<Weekday, Interval[]>>;

/** "06:00–09:00 and 17:00–21:00" — a day's runs, with a real gap kept as a gap. */
function runsPhrase(intervals: Interval[]): string {
  return listOf(intervals.map((i) => `${formatClock(i.start)}–${formatClock(i.end)}`));
}

/** Two days read "Mondays and Tuesdays"; three or more read "Mondays to Fridays". */
function daysPhrase(days: Weekday[]): string {
  if (days.length === 1) return dayPlural(days[0]);
  if (days.length === 2) return `${dayPlural(days[0])} and ${dayPlural(days[1])}`;
  return `${dayPlural(days[0])} to ${dayPlural(days[days.length - 1])}`;
}

/** Consecutive days carrying identical runs, collapsed into one phrase each. */
function weekPhrases(painted: PaintedWeek): string[] {
  const out: string[] = [];
  let run: Weekday[] = [];
  let runKey: string | null = null;
  const flush = () => {
    if (run.length > 0 && runKey) out.push(`${daysPhrase(run)} ${runKey}`);
    run = [];
    runKey = null;
  };
  for (const day of WEEK_IN_READING_ORDER) {
    const intervals = painted[day] ?? [];
    const key = intervals.length === 0 ? null : runsPhrase(intervals);
    if (key === null) { flush(); continue; }
    if (key === runKey) run.push(day);
    else { flush(); run = [day]; runKey = key; }
  }
  flush();
  return out;
}

function slotsPhrase(painted: number, open: number): string {
  if (painted === 0) return `None of the ${open} slots the club is open.`;
  return `${painted} of the ${open} slots the club is open.`;
}

/**
 * What the painter means, in one sentence, regenerated as it is painted.
 *
 * <p>
 * <b>This is the accessible summary</b> — the thing a screen-reader user is given in place of
 * the grid — so the two states that read as "blank" get the loudest sentences. Nothing painted
 * does not mean "not configured yet"; it means those members cannot book at all, and this line
 * is the only place on the screen that would ever say so.
 * </p>
 */
export function paintedWeekSentence(
  painted: PaintedWeek, club: PaintedWeek, sliceMinutes: number,
): string {
  let paintedSlots = 0;
  let openSlots = 0;
  for (const day of WEEK_IN_READING_ORDER) {
    const clubDay = club[day] ?? [];
    openSlots += countSlots(clubDay, sliceMinutes);
    paintedSlots += countSlots(intersect(painted[day] ?? [], clubDay), sliceMinutes);
  }
  if (paintedSlots === 0) {
    return "Nothing painted. Members of this group cannot book at any time — paint the hours "
      + "they are allowed.";
  }
  if (paintedSlots === openSlots) return `Every hour the club is open. All ${openSlots} slots.`;
  const phrases = weekPhrases(painted);
  const head = phrases.length > 1
    // The Oxford comma before the final "and" is deliberate: these phrases already contain
    // "and" inside them ("06:00–09:00 and 17:00–21:00"), so the list separator has to be
    // visibly stronger than the one inside an item.
    ? `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`
    : phrases[0];
  return `${head}. ${slotsPhrase(paintedSlots, openSlots)}`;
}

/**
 * What the live region says after a painted run — ONCE, not per cell.
 *
 * A `Shift+Arrow` run of twelve cells announced twelve times is a live region an admin turns
 * their screen reader off to escape, which costs them every other announcement on the page.
 */
export function paintedRunAnnouncement(
  day: Weekday, fromMinute: number, toMinute: number, allowed = true,
): string {
  return `${dayName(day)} ${formatClock(fromMinute)} to ${formatClock(toMinute)} `
    + `${allowed ? "allowed" : "not allowed"}.`;
}

// ---------------------------------------------------------------------------------------
// The empty intersection
// ---------------------------------------------------------------------------------------

/**
 * Two groups whose times do not overlap, said in words — D2 §4.3.
 *
 * Never an empty grid: an empty grid reads as "the club is shut", which sends an admin to look
 * at the opening hours for a fault that is in the groups.
 */
export function emptyIntersectionSentence(
  groupNames: string[], day: Weekday, memberName?: string | null,
): string {
  const names = listOf(groupNames);
  if (memberName) {
    return `${memberName} is in ${names}, and their times do not overlap. `
      + `There is nothing she can book on a ${dayName(day)}.`;
  }
  const inThem = groupNames.length === 2 ? `both ${names}` : names;
  return `A member in ${inThem} can book nothing on a ${dayName(day)}: their times do not overlap.`;
}

// ---------------------------------------------------------------------------------------
// The per-day ceiling — item 19
// ---------------------------------------------------------------------------------------

function slotsWord(count: number): string {
  return count === 1 ? "1 slot" : `${count} slots`;
}

const ADMINS_EXEMPT = "Admins are never limited.";

/**
 * Where the per-day ceiling is SET, what it actually resolves to — ruling 3.
 *
 * <p>
 * <b>The inert-override arm is the one that earns this function.</b> A group may lower either
 * cap and never raise one, so an override at or above the club's own bound changes nothing —
 * and without this sentence an admin types 8, presses Save, is told it saved, and never learns
 * why the member still gets 4. D3 §6.3's example is written the other way round and is wrong.
 * </p>
 */
export function capResolutionSentence(
  groupName: string, groupCap: number | null | undefined, clubCap: number,
): string {
  const others = clubCap > 0
    ? `Everyone else gets the club's ${clubCap}.`
    : "Everybody else has no limit, because the club has not set one.";
  if (groupCap === null || groupCap === undefined) {
    return clubCap > 0
      ? `${groupName} members get the club's limit of ${slotsWord(clubCap)} a day. ${ADMINS_EXEMPT}`
      : `${groupName} members have no limit on how many slots they book in a day, because the `
        + `club has not set one. ${ADMINS_EXEMPT}`;
  }
  if (capOverrideIsInert(groupCap, clubCap)) {
    const asked = groupCap > 0 ? String(groupCap) : "no limit";
    return `${groupName} members may book ${slotsWord(clubCap)} a day — the club's own limit. `
      + `A group can lower that and never raise it, so ${asked} would change nothing. ${ADMINS_EXEMPT}`;
  }
  if (groupCap === UNLIMITED) {
    return `${groupName} members have no limit on how many slots they book in a day. ${ADMINS_EXEMPT}`;
  }
  return `${groupName} members may book ${slotsWord(groupCap)} a day. ${others} ${ADMINS_EXEMPT}`;
}

// ---------------------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------------------

/** A multiplier written the way it was typed — 7500 bps is "0.75×", not "7500". */
function multiplierFace(bps: number): string {
  return String(Number((bps / 10_000).toFixed(4)));
}

/** Credits with no trailing noise: 8, 8.5, 8.25 — never "8.00" and never "8.2500000001". */
export function creditsFace(credits: number): string {
  return String(Number(credits.toFixed(2)));
}

/**
 * What one slice costs under this pricing choice, shown beside the choice.
 *
 * A mode picked with no figure beside it is three radio buttons an admin guesses at; the
 * consequence is what makes the choice readable.
 */
export function slicePriceLine(input: {
  mode: GroupPricingMode;
  credits: number;
  courtPrice: number;
  multiplierBps?: number | null;
  unknown?: boolean;
}): string {
  if (input.unknown) return "The club's system hasn't said what one slot costs under this choice yet.";
  if (input.mode === "inherit_court") {
    return `One slot costs what the court costs — ${creditsFace(input.courtPrice)} credits.`;
  }
  if (input.mode === "multiplier") {
    const face = typeof input.multiplierBps === "number" ? multiplierFace(input.multiplierBps) : "?";
    return `One slot costs ${creditsFace(input.credits)} credits — ${face}× the court's `
      + `${creditsFace(input.courtPrice)}.`;
  }
  return `One slot costs ${creditsFace(input.credits)} credits, whatever the court charges.`;
}

/**
 * The club's top-up rate in the block it actually sells — D3 §6.2.
 *
 * <p>
 * R100 rather than per rand, because `topup_block_zar` is what a member hands over and "1.6"
 * means nothing to a volunteer. The consequence clause is the point: a number of credits is
 * only meaningful against what a court costs, and that is the arithmetic nobody should be doing
 * standing at a desk.
 * </p>
 */
export function ratePerBlockSentence(input: {
  creditsPerZar: number | null | undefined;
  blockZar: number | null | undefined;
  slicePrice: number;
}): string {
  if (typeof input.creditsPerZar !== "number" || typeof input.blockZar !== "number") {
    return "The club's system hasn't said what R100 buys.";
  }
  const credits = Number((input.creditsPerZar * input.blockZar).toFixed(2));
  const head = `R${input.blockZar} buys ${creditsFace(credits)} credits`;
  if (input.slicePrice <= 0) {
    return `${head}. Courts cost nothing at the moment, so that buys any number of slots.`;
  }
  const slots = Math.floor(credits / input.slicePrice);
  if (slots === 0) return `${head} — not enough for a single slot at today's prices.`;
  return `${head} — about ${slotsWord(slots)} at today's prices.`;
}

// ---------------------------------------------------------------------------------------
// Moving somebody between groups
// ---------------------------------------------------------------------------------------

/**
 * What changes for one named person, said BEFORE the save rather than after it.
 *
 * <p>
 * Every arm names the person, because a consequence written as "their next top-up" is one an
 * admin reads about the row they are looking at, and the row they are looking at is not always
 * the row they clicked.
 * </p>
 *
 * <p>
 * The top-up clause is grounded: the rate is locked onto the top-up row at purchase
 * (`LockTopUpConversionRate`), so credit already bought genuinely does not move. Saying so is
 * not reassurance, it is the difference between an admin making the change and an admin
 * refusing to.
 * </p>
 */
export function groupChangeConsequence(input: {
  name: string;
  sliceBefore?: number | null;
  sliceAfter?: number | null;
  creditsPerBlockBefore?: number | null;
  creditsPerBlockAfter?: number | null;
  blockZar?: number | null;
}): string[] {
  const out: string[] = [];
  const { name } = input;
  if (typeof input.creditsPerBlockBefore === "number" && typeof input.creditsPerBlockAfter === "number"
    && input.creditsPerBlockBefore !== input.creditsPerBlockAfter) {
    out.push(`${name}'s next top-up will buy ${creditsFace(input.creditsPerBlockAfter)} credits per `
      + `R${input.blockZar ?? 100} instead of ${creditsFace(input.creditsPerBlockBefore)}. `
      + "Credit he already has does not change.");
  }
  if (typeof input.sliceBefore === "number" && typeof input.sliceAfter === "number"
    && input.sliceBefore !== input.sliceAfter) {
    out.push(`A slot will cost ${name} ${creditsFace(input.sliceAfter)} credits instead of `
      + `${creditsFace(input.sliceBefore)}.`);
  }
  if (out.length > 0) return out;
  const knewSomething = typeof input.sliceBefore === "number" || typeof input.creditsPerBlockBefore === "number";
  return knewSomething
    ? [`Nothing ${name} pays changes. Which times he may book still might — check the preview.`]
    : [`The club's system hasn't said what this changes for ${name}. Open the preview before saving.`];
}

// ---------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------

/**
 * Every code in D2 §4.5's table, as a sentence.
 *
 * <p>
 * Flat strings so `StateBlock` and `describeFailure` can take the map whole; the four that
 * carry figures are enriched by {@link explainGroupRefusal}, which has the error in hand. A
 * screen that rendered `group_multiplier_out_of_range` at a volunteer has said nothing at all.
 * </p>
 */
export const GROUP_REFUSAL_CODES: Record<string, string> = {
  group_name_invalid: "A group's name has to be between 2 and 64 characters.",
  group_name_taken: "The club already has a group with that name. Two groups with one name is an "
    + "admin reading the wrong rule — give this one a different name.",
  group_description_too_long: "The description has to be 256 characters or fewer. It is shown to "
    + "members on the booking grid, so shorter is better anyway.",
  group_pricing_mode_invalid: "That is not one of the three ways a group can be priced.",
  group_multiplier_out_of_range: "The multiplier has to be between 0 and 100 times the court's own "
    + "price.",
  group_flat_price_invalid: "A flat price has to be a whole number of cents, zero or more.",
  group_pricing_field_not_for_mode: "That figure belongs to a different way of pricing. Clear it, "
    + "or change how this group is priced.",
  group_max_slots_out_of_range: "Slots a day has to be a whole number between 0 and 96, where 0 "
    + "means no limit.",
  group_max_minutes_out_of_range: "Minutes a day has to be a whole number between 0 and 1440, "
    + "where 0 means no limit.",
  group_advance_days_out_of_range: "How far ahead this group may book has to be between 0 and 365 "
    + "days.",
  group_window_day_invalid: "One of the painted days is not a day of the week the club's system "
    + "recognises.",
  group_window_range_invalid: "One of the painted times starts after it ends, or runs past "
    + "midnight. A window has to sit inside one day.",
  group_windows_too_many: "That is more painted blocks than the club's system keeps — at most 8 on "
    + "one day and 56 in a week. Painting a longer block instead of several touching ones usually "
    + "fixes it.",
  group_windows_overlap: "Two painted blocks on one day overlap. Merged, they would be ambiguous "
    + "to read back, so the club's system keeps them apart.",
  group_limit_reached: "The club already has the most groups it can have — 32. Archive one you no "
    + "longer use.",
  group_has_members: "This group still has members, so it cannot be deleted. Archive it instead.",
  group_is_system_default: "This is one of the club's two standing groups. It can be renamed and "
    + "edited, and it cannot be deleted. Archive it instead.",
  too_many_members: "That is more than 500 members in one go. Do it in smaller batches.",
};

/** The figure one of these refusals carried, as a string, or null. */
function figure(err: ApiError, key: string): string | null {
  const value = err.detail(key);
  return value === null || value === undefined ? null : String(value);
}

/**
 * A refusal with the server's own figures in it.
 *
 * "One of the painted times starts after it ends" sends an admin looking at seven days; "the
 * Tuesday window starts after it ends" sends them to the Tuesday.
 */
export function explainGroupRefusal(err: unknown, action = "save this group"): string {
  if (err instanceof ApiError) {
    const code = err.code;
    if (code === "group_name_taken") {
      const name = figure(err, "name");
      if (name) {
        return `The club already has a group called “${name}”. Two groups with one name is an `
          + "admin reading the wrong rule — give this one a different name.";
      }
    }
    if (code === "group_window_range_invalid" || code === "group_windows_overlap"
      || code === "group_window_day_invalid") {
      const day = figure(err, "day") as Weekday | null;
      if (day && DAY_NAME[day]) {
        const base = GROUP_REFUSAL_CODES[code];
        return `${base.replace(/^One of the painted|^Two painted/, (m) => m)} The day is ${DAY_NAME[day]}.`;
      }
    }
    if (code === "group_pricing_field_not_for_mode") {
      const field = figure(err, "field");
      if (field) {
        return `${GROUP_REFUSAL_CODES[code]} The figure is the one called “${field}”.`;
      }
    }
  }
  return describeFailure(err, { action, codes: GROUP_REFUSAL_CODES });
}

/**
 * Why a delete was refused, and the way out — never the bare code.
 *
 * <p>
 * The escape has to be IN the sentence. A refusal that explains itself and stops leaves an
 * admin with a group they cannot get rid of and no idea that archiving exists; archiving is the
 * designed answer, and it is reversible, which is exactly why it is the answer.
 * </p>
 */
export function deleteRefusalSentence(
  code: string, about: { groupName: string; memberCount: number | null },
): string {
  const archive = "Archive it instead: an archived group stops applying to anybody and keeps its "
    + "record, so the club can bring it back.";
  if (code === "group_is_system_default") {
    return `${about.groupName} is one of the club's two standing groups. It can be renamed and `
      + `edited, and it cannot be deleted — so this screen always has two rows to explain the `
      + `feature with. ${archive}`;
  }
  if (code === "group_has_members") {
    const count = about.memberCount;
    const who = count === null ? "members" : count === 1 ? "1 member" : `${count} members`;
    const them = count === 1 ? "that member" : `all ${count ?? "those"} of them`;
    return `${about.groupName} has ${who}, so it cannot be deleted. Deleting it would silently `
      + `change what ${them} may book and what they pay, with no screen showing it. ${archive}`;
  }
  return GROUP_REFUSAL_CODES[code] ?? "The club's system refused that and did not say why.";
}

// ---------------------------------------------------------------------------------------
// Counts, labels and per-item results
// ---------------------------------------------------------------------------------------

/** Members in a group, at 0, 1 and 2 — and the absent count said as absent. */
export function memberCountLine(count: number | null | undefined): string {
  if (typeof count !== "number") return "Member count not sent";
  if (count === 0) return "No members yet";
  return count === 1 ? "1 member" : `${count} members`;
}

export function addMembersLabel(count: number, groupName: string): string {
  return `Add ${count === 1 ? "1 member" : `${count} members`} to ${groupName}`;
}

/**
 * One row of an add-members result.
 *
 * <p>
 * `POST /member-groups/{id}/members` answers per item, so the screen shows per item. A batch
 * reported as one toast is four seconds to read six outcomes, over a viewport that deliberately
 * carries no live region — and "already in this group" is not a failure, which a single
 * success/failure count cannot express at all.
 * </p>
 */
export function addResultLine(result: AdminItemResult, name: string): string {
  if (result.status === "added") return `${name} — added.`;
  if (result.status === "already_a_member") return `${name} — already in this group; nothing changed.`;
  const reason = result.error
    ? ADD_FAILURE_REASONS[result.error] ?? "the club's system refused it and did not say why."
    : "the club's system refused it and did not say why.";
  return `${name} — ${reason}`;
}

const ADD_FAILURE_REASONS: Record<string, string> = {
  member_not_found: "the club's system does not have this member any more.",
  not_a_member: "this person is not a member of the club.",
  group_limit_reached: "this group is full.",
  too_many_members: "too many at once — try a smaller batch.",
};

// ---------------------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------------------

/**
 * The paragraph under a preview — every rule that bit, with its count.
 *
 * <p>
 * The last line is the one an admin actually plans against: a per-day ceiling multiplied by the
 * days in view, because "84 slots" and "4 a day" are two facts nobody combines standing up, and
 * the real answer is the smaller of them.
 * </p>
 */
export function previewSummary(input: {
  who: string;
  allowedSlots: number;
  clubSlots: number;
  blockedByGroup: number;
  ceilingPerDay: number;
  daysCounted: number;
}): string[] {
  const out: string[] = [];
  out.push(input.allowedSlots === 0
    ? `Can book none of the ${input.clubSlots} slots the club is open.`
    : `Can book ${input.allowedSlots} of the ${input.clubSlots} slots the club is open.`);
  out.push(input.blockedByGroup === 0
    ? "Nothing is blocked by this group's own times."
    : `${slotsWord(input.blockedByGroup)} are blocked by this group's own times.`);
  if (input.ceilingPerDay === UNLIMITED) {
    out.push("There is no per-day limit on top of that.");
  } else {
    const ceiling = input.ceilingPerDay * input.daysCounted;
    out.push(`On top of that, ${slotsWord(input.ceilingPerDay)} a day is the most any one of them `
      + `can hold — so the real ceiling is ${Math.min(ceiling, input.allowedSlots)} slots this week.`);
  }
  return out;
}
