import { ApiError } from "./api";
import { unsureWords } from "./lostReplyCopy";
import { unsureSentence } from "./lostReply";
import { describeFailure } from "./errors";
import type { GroupAddResult, GroupAddRow, GroupPricingMode, Weekday } from "./adminApi";
import {
  CREDITS_PER_ZAR_DECIMALS, MAX_CREDITS_PER_ZAR, UNLIMITED, WEEK_IN_READING_ORDER, capOverrideIsInert,
  countSlots, creditsFor, formatClock, intersect, type Interval, type RateProblem,
} from "./groupRules";
import { clubCurrencySymbol } from "./currency";
import { formatRate, formatMoney } from "./utils";

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
  = "Paint the times this group may book. Paint nothing and they book any time the club is "
  + "open; paint anything and they book only the painted times. Drag to paint, hold Alt and "
  + "drag to erase, or use the arrow keys and Space.";

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
    /*
     * Two different facts. A group with NO window rows anywhere is unrestricted — the server's
     * `HasAnyWindows` rule and `groupRules.allowFor` — so a cleared painter saves a group whose
     * members book any time the club is open, and saying "cannot book" about it was the one
     * sentence on this screen that was false. Windows that exist but all fall outside the club's
     * hours really do leave nothing, and keep the loud sentence.
     */
    const anyPainted = WEEK_IN_READING_ORDER.some((day) => (painted[day] ?? []).length > 0);
    return anyPainted
      ? "Nothing bookable. Every painted time is outside the club's hours, so members of this group "
        + "cannot book at any time."
      : "No times of its own — members of this group book any time the club is open. Paint hours "
        + "to restrict them.";
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
 * A saved window that does not line up with the club's own slices.
 *
 * <p>
 * <b>Said rather than silently rounded.</b> The painter can only represent whole slices, so a
 * saved 06:07–09:00 under 15-minute slots paints as 06:15–09:00 — an access rule narrowed by a
 * rendering decision. Narrowing is the right direction to fail in (this is a permission), and
 * doing it without a word on screen is not: an admin who opens a group to change its name would
 * otherwise save a different rule than the one they opened.
 * </p>
 */
export function misalignedWindowNote(faces: string[], sliceMinutes: number): string {
  const which = faces.length === 1 ? "One of this group's saved times" : "Some of this group's saved times";
  return `${which} doesn't line up with the club's ${sliceMinutes}-minute slots (${listOf(faces)}). `
    + "Painting here saves the whole slots inside it, which is slightly less time — leave the "
    + "painter alone and save nothing else if you want it kept as it is.";
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
  groupName: string, groupCap: number | null | undefined, clubCap: number | null,
): string {
  /*
   * `clubCap === null` is the club's system not having SENT the key, which is a different fact
   * from the club having set no limit — and the difference matters most here, because "nobody
   * is limited" is a claim an admin would act on. `member_max_slots_per_day` is being shipped
   * by a backend lane in parallel with this screen, so absent is a state that will happen.
   */
  if (clubCap === null) {
    if (groupCap === null || groupCap === undefined) {
      return `The club's system hasn't said a limit on slots a day, and ${groupName} doesn't set `
        + `one either — so nothing on this screen limits how many slots a day they book. `
        + `${ADMINS_EXEMPT}`;
    }
    return `${membersOf(groupName)} may book ${slotsWord(groupCap)} a day. The club's system hasn't `
      + `said what everybody else gets. ${ADMINS_EXEMPT}`;
  }
  const others = clubCap > 0
    ? `Everyone else gets the club's ${clubCap}.`
    : "Everybody else has no limit, because the club has not set one.";
  if (groupCap === null || groupCap === undefined) {
    return clubCap > 0
      ? `${membersOf(groupName)} get the club's limit of ${slotsWord(clubCap)} a day. ${ADMINS_EXEMPT}`
      : `${membersOf(groupName)} have no limit on how many slots they book in a day, because the `
        + `club has not set one. ${ADMINS_EXEMPT}`;
  }
  if (capOverrideIsInert(groupCap, clubCap)) {
    const asked = groupCap > 0 ? String(groupCap) : "no limit";
    return `${membersOf(groupName)} may book ${slotsWord(clubCap)} a day — the club's own limit. `
      + `A group can lower that and never raise it, so ${asked} would change nothing. ${ADMINS_EXEMPT}`;
  }
  if (groupCap === UNLIMITED) {
    return `${membersOf(groupName)} have no limit on how many slots they book in a day. ${ADMINS_EXEMPT}`;
  }
  return `${membersOf(groupName)} may book ${slotsWord(groupCap)} a day. ${others} ${ADMINS_EXEMPT}`;
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
 * A spread of credit figures as one face: "8" when every court agrees, "8–12" when they differ.
 *
 * <p>
 * <b>Review round 1, F3.3.</b> Every figure on the Groups page used to be worked out from the
 * club's retired `slice_price_credits` setting — 8 cr — while each court now carries its own
 * price. "R100 buys 240 credits — about 30 slots" was arithmetic on a number no court charged.
 * The page now reads the courts, and where they differ it says the range rather than picking one.
 * </p>
 */
export function creditsRange(values: readonly number[]): string {
  if (values.length === 0) return "?";
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? creditsFace(low) : `${creditsFace(low)}–${creditsFace(high)}`;
}

/** Said instead of a price while the courts have not been read — never a figure invented. */
export const COURTS_UNREAD = "The club's courts haven't been read yet, so what a slot costs isn't known.";

/**
 * What one slice costs under this pricing choice, shown beside the choice.
 *
 * A mode picked with no figure beside it is three radio buttons an admin guesses at; the
 * consequence is what makes the choice readable. `credits` holds one figure per distinct court
 * price (F3.3), so a club whose courts differ reads a range, never one court's price.
 */
export function slicePriceLine(input: {
  mode: GroupPricingMode;
  credits: readonly number[];
  /** The distinct prices of the club's courts in use; null while they have not been read. */
  courtPrices: readonly number[] | null;
  multiplierBps?: number | null;
  unknown?: boolean;
}): string {
  if (input.unknown) return "The club's system hasn't said what one slot costs under this choice yet.";
  if (input.mode === "flat_per_slice") {
    return `One slot costs ${creditsRange(input.credits)} credits, whatever the court charges.`;
  }
  if (!input.courtPrices || input.courtPrices.length === 0) return COURTS_UNREAD;
  const depends = input.courtPrices.length > 1 ? ", depending on the court" : "";
  if (input.mode === "inherit_court") {
    return `One slot costs what the court costs — ${creditsRange(input.courtPrices)} credits${depends}.`;
  }
  const face = typeof input.multiplierBps === "number" ? multiplierFace(input.multiplierBps) : "?";
  return `One slot costs ${creditsRange(input.credits)} credits${depends} — ${face}× the court's `
    + `${creditsRange(input.courtPrices)}.`;
}

/** "about 3 slots" / "about 3–5 slots" / "not enough for a single slot" — from a price spread. */
function slotsBought(credits: number, prices: readonly number[]): string {
  const fewest = Math.floor(credits / Math.max(...prices));
  const most = Math.floor(credits / Math.min(...prices));
  if (most === 0) return " — not enough for a single slot at today's prices.";
  if (fewest === most) return ` — about ${slotsWord(most)} at today's prices.`;
  if (fewest === 0) return ` — up to ${slotsWord(most)} at today's prices, depending on the court.`;
  return ` — about ${fewest}–${slotsWord(most)} at today's prices, depending on the court.`;
}

/**
 * The club's top-up rate in the block it actually sells — D3 §6.2.
 *
 * <p>
 * R100 rather than per rand, because `topup_block_zar` is what a member hands over and "1.6"
 * means nothing to a volunteer. The consequence clause is the point: a number of credits is
 * only meaningful against what a court costs, and that is the arithmetic nobody should be doing
 * standing at a desk. `slicePrices` is one figure per court price (F3.3); null when the price
 * is not known — the courts unread, or a flat price not yet typed — and then no slot count is
 * claimed at all (a blank flat price used to read "Courts cost nothing at the moment").
 * </p>
 */
export function ratePerBlockSentence(input: {
  creditsPerZar: number | null | undefined;
  blockZar: number | null | undefined;
  slicePrices: readonly number[] | null;
}): string {
  if (typeof input.creditsPerZar !== "number" || typeof input.blockZar !== "number") {
    // No amount invented here. The branch is reached when the BLOCK is unknown as well as
    // the rate, so naming a figure would be naming one this club may not use — and now that
    // the symbol is the club's too, the old literal named a currency it may not take either.
    return "The club's system hasn't said what a top-up buys.";
  }
  const credits = Number((input.creditsPerZar * input.blockZar).toFixed(2));
  // Through the one formatter, so this sentence and the top-up screen — which quotes the
  // same `topup_block_zar` — cannot name the club's money two different ways.
  const head = `${formatMoney(input.blockZar)} buys ${creditsFace(credits)} credits`;
  if (!input.slicePrices || input.slicePrices.length === 0) return `${head}.`;
  const priced = input.slicePrices.filter((p) => p > 0);
  if (priced.length === 0) {
    return `${head}. Courts cost nothing at the moment, so that buys any number of slots.`;
  }
  return `${head}${slotsBought(credits, priced)}`;
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
      + `${formatMoney(input.blockZar ?? 100)} instead of ${creditsFace(input.creditsPerBlockBefore)}. `
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
  group_is_system_default: "This is one of the club's built-in groups. It can be renamed and edited, "
    + "and it cannot be deleted — and the league group, which carries the club's rates, cannot be "
    + "archived either.",
  too_many_members: "That is more than 500 members in one go. Do it in smaller batches.",
  group_credits_per_zar_invalid: "A top-up rate has to be more than 0 and at most 1000, with at most "
    + "4 decimal places.",
  group_peak_priority_invalid: "Peak hours has to be one of the three choices: grants, withholds or no say.",
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
  // A lost reply, read back (R4 carry-over): the list shows whether the save landed.
  const unsure = unsureSentence(err, GROUP_LOST.save);
  if (unsure) return unsure;
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
    if (code === "group_credits_per_zar_invalid") {
      const max = figure(err, "max");
      const decimals = figure(err, "decimals");
      if (max && decimals) {
        return `A top-up rate has to be more than 0 and at most ${max}, with at most ${decimals} `
          + "decimal places.";
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
 * `POST /member-groups/{id}/members` answers per item (`{ user_id, result }`), so the screen
 * shows per item. A batch reported as one toast is four seconds to read six outcomes, over a
 * viewport that deliberately carries no live region — and "already in this group" is not a
 * failure, which a single success/failure count cannot express at all.
 * </p>
 */
export function addResultLine(row: GroupAddRow, name: string): string {
  if (row.result === "added") return `${name} — added.`;
  if (row.result === "already_a_member") return `${name} — already in this group; nothing changed.`;
  return `${name} — ${ADD_FAILURE_REASONS[row.result] ?? "the club's system refused it and did not say why."}`;
}

/** A row the club refused — neither added nor already there. */
export function addRowFailed(row: GroupAddRow): boolean {
  return row.result !== "added" && row.result !== "already_a_member";
}

/**
 * The heading over the rows, counted on the screen because the server sends no counts (A4-2).
 * "Already in" is said as itself, never folded into "done" or into "failed".
 */
export function addResultHeading(result: GroupAddResult): string {
  const asked = result.results.length;
  const added = result.results.filter((r) => r.result === "added").length;
  const already = result.results.filter((r) => r.result === "already_a_member").length;
  const failed = asked - added - already;
  const parts = [`${added} of ${asked} added`];
  if (already > 0) parts.push(`${already} already in`);
  if (failed > 0) parts.push(`${failed} refused`);
  return `${parts.join(", ")}.`;
}

/** The note beside a result the reply of which was lost and the members list was read instead. */
export const ADD_LOST = {
  proven: "The club's reply didn't arrive, so we checked who is in the group now.",
  checked: (name: string) => `The club didn't answer, so we checked: nobody new is in ${name} — nothing changed. Try again in a moment.`,
  unchecked: (name: string) => `The club didn't answer and we couldn't check either, so we can't tell whether they were added to ${name}. Refresh the group before trying again.`,
} as const;

const ADD_FAILURE_REASONS: Record<string, string> = {
  member_not_found: "the club's system does not have this member any more.",
  // Read back after a lost reply: the group does not have them, and the reply that would say why is gone.
  not_added: "not in the group — the club's record shows they weren't added.",
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

// ---------------------------------------------------------------------------------------
// The card's actions and their confirm dialogs (P3 — row actions behind ⋯, destructive work
// behind a dialog with an outcome-named primary). Tests query by these.
// ---------------------------------------------------------------------------------------

export const GROUP_ACTIONS = {
  edit: "Edit",
  members: "Members",
  preview: "Preview week",
  more: (name: string) => `More actions for ${name}`,
  archive: "Archive group",
  archiveTitle: (name: string) => `Archive ${name}?`,
  archiveBody: (name: string) =>
    `${name} stops applying to anybody. Nothing is deleted and it can be brought back.`,
  remove: "Delete group",
  removeTitle: (name: string) => `Delete ${name}?`,
  removeBody: (name: string) =>
    `${name} is removed for good. The club refuses this while anybody is still in it — archive it instead to keep its history.`,
  standing: (name: string) =>
    `${name} is one of the club's two standing groups. It can be renamed and edited, and it cannot be deleted.`,
} as const;

// ---------------------------------------------------------------------------------------
// D2 — groups carry the top-up rate and the peak say (the member class is gone)
// ---------------------------------------------------------------------------------------

/** "R1" — one unit of the club's money, as a rate is quoted against it. */
function oneUnit(): string {
  return `${clubCurrencySymbol()}1`;
}

/** "R100", not "R100.00", where the amount is whole — a block is always whole in practice. */
export function wholeMoney(amount: number): string {
  return Number.isInteger(amount) ? `${clubCurrencySymbol()}${amount}` : formatMoney(amount);
}

/** "2.4 cr per R1" — a rate, in the unit it is typed in. */
export function rateFace(rate: number): string {
  return `${formatRate(rate)} cr per ${oneUnit()}`;
}

/**
 * A group's top-up rate as its card's chip says it. Absent (an API that predates D2) is not
 * "the club's rate" — that is the claim a volunteer would act on — so it has its own words.
 */
export function rateChip(rate: number | null | undefined): string {
  if (rate === undefined) return "Top-up rate not sent";
  return rate === null ? "Club rate" : rateFace(rate);
}

/** A group's say on the peak window, as its card's chip says it. */
export function peakChip(say: boolean | null | undefined): string {
  if (say === undefined) return "Peak say not sent";
  if (say === null) return "No say on peak";
  return say ? "Grants peak" : "Withholds peak";
}

/** The three caps in one line for the card — each either the group's own figure or the club's. */
export function capsSummary(caps: {
  max_slots_per_day?: number | null;
  max_minutes_per_day?: number | null;
  advance_booking_days?: number | null;
} | undefined): string {
  const part = (value: number | null | undefined, noun: string) => {
    if (typeof value !== "number") return null;
    return value === UNLIMITED ? `no limit on ${noun}` : `${value} ${noun}`;
  };
  const own = [
    part(caps?.max_slots_per_day, "slots a day"),
    part(caps?.max_minutes_per_day, "minutes a day"),
    part(caps?.advance_booking_days, "days ahead"),
  ].filter((x): x is string => x !== null);
  if (own.length === 0) return "The club's limits apply.";
  const joined = listOf(own);
  return `${joined[0].toUpperCase()}${joined.slice(1)}. The club's limits cover the rest.`;
}

export const SYSTEM_GROUP = {
  badge: "Built in",
  note: (name: string) =>
    `${name} replaced the league / over-65 member class. It can be renamed and edited, and it can't `
    + "be archived or deleted — the club's rates rely on it.",
} as const;

/** The editor's sections, in the order the sheet lays them out. */
export const GROUP_SECTIONS = {
  basics: "Basics",
  price: "Court price",
  rate: "Top-up rate",
  peak: "Peak hours",
  times: "Booking times",
  limits: "Limits",
} as const;

export const GROUP_SHEET = {
  newTitle: "New group",
  editTitle: (name: string) => `Edit ${name}`,
  description: "What this group pays, when it may book and how much. Members in several groups get the strictest rule.",
  settingsTab: "Settings",
  membersTab: "Members",
  membersAfterCreate: "Save the group first, then add its members.",
  create: "Create group",
  save: "Save changes",
  saved: (name: string) => `${name} saved.`,
  created: (name: string) => `${name} created.`,
  nameLabel: "Name",
  descriptionLabel: "Description",
  descriptionHelp: "Members see this on the booking grid, so keep it short.",
  nameRequired: "Give the group a name.",
} as const;

// --- Top-up rate -------------------------------------------------------------------------

export const RATE_COPY = {
  inherit: "Use the club's rate",
  inheritHelp: (clubRate: number | null | undefined) => (typeof clubRate === "number"
    ? `The club's rate is ${rateFace(clubRate)}, set under Settings → Credits. A group that uses it has no say in anybody's rate.`
    : "The club's rate is set under Settings → Credits. A group that uses it has no say in anybody's rate."),
  field: () => `Credits per ${oneUnit()}`,
  combine: "A member in several groups tops up at the lowest rate any of their groups sets. Credit a member already has never changes.",
} as const;

/** What a typed rate would be refused for, in the admin's words — the server's figures, not ours. */
export function rateProblemSentence(problem: RateProblem): string {
  switch (problem) {
    case "empty": return `Enter a rate, or switch on "${RATE_COPY.inherit}".`;
    case "not_a_number": return "That isn't a number — enter a rate like 2.4.";
    case "not_positive": return "A rate has to be more than 0.";
    case "too_high": return `A rate can be at most ${MAX_CREDITS_PER_ZAR}.`;
    case "too_precise": return `Use at most ${CREDITS_PER_ZAR_DECIMALS} decimal places.`;
  }
}

/**
 * "R100 → 240 cr" — what one top-up block buys at the rate on screen, as it is typed.
 * The block is the club's `topup_block_zar`; without it, R100 is said as an example, and says so.
 */
export function ratePreviewLine(rate: number, blockZar: number | null | undefined): string {
  const block = typeof blockZar === "number" && blockZar > 0 ? blockZar : 100;
  const credits = creditsFor(block, rate);
  return `${wholeMoney(block)} → ${Number(credits.toFixed(2))} cr`;
}

// --- Peak hours --------------------------------------------------------------------------

export const PEAK_OPTIONS = [
  {
    value: "grants",
    title: "Grants peak priority",
    description: "Members may book peak hours as far ahead as anyone else.",
  },
  {
    value: "withholds",
    title: "Withholds it",
    description: "Members wait for the late window, even if another of their groups grants priority.",
  },
  {
    value: "none",
    title: "No say",
    description: "Leaves it to the member's other groups.",
  },
] as const;

export type PeakChoice = typeof PEAK_OPTIONS[number]["value"];

export function peakChoiceOf(say: boolean | null | undefined): PeakChoice {
  if (say === true) return "grants";
  if (say === false) return "withholds";
  return "none";
}

export function peakSayOf(choice: PeakChoice): boolean | null {
  if (choice === "grants") return true;
  if (choice === "withholds") return false;
  return null;
}

export const PEAK_COMBINE
  = "A member has peak priority when at least one of their groups grants it and none of them "
  + "withholds it. A withhold always wins.";

/** The club's own peak window, from settings, so the choice above it is about a real stretch. */
export function peakWindowLine(peakHours: unknown, advanceHours: unknown): string {
  const hours = typeof peakHours === "string" && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(peakHours)
    ? peakHours.replace("-", "–")
    : null;
  const lead = typeof advanceHours === "number"
    ? (advanceHours === 1 ? "1 hour" : `${advanceHours} hours`)
    : null;
  if (!hours) return "The club's peak hours are set under Settings → Booking.";
  if (!lead) return `The club's peak hours are ${hours}.`;
  return `The club's peak hours are ${hours}. Without priority, a member can take a free peak slot from ${lead} before it starts.`;
}

// --- Archive / restore ---------------------------------------------------------------------

export const ARCHIVE_COPY = {
  title: (name: string) => `Archive ${name}?`,
  body: (name: string, members: number | null | undefined) => {
    const who = typeof members === "number" && members > 0
      ? `its ${members === 1 ? "member" : `${members} members`} go back to their other groups' rules and the club's rate`
      : "nobody is in it, so nothing changes for anybody today";
    return `${name} stops applying — ${who}. Nothing is deleted, and it can be brought back.`;
  },
  reasonLabel: "Why are you archiving it?",
  reasonHelp: "Goes on the change record, so the next admin knows.",
  confirm: "Archive group",
  restore: "Bring back",
  restored: (name: string) => `${name} is back.`,
  archived: (name: string) => `${name} is archived.`,
} as const;

/**
 * A group write whose reply was lost, read back (review round 3, the admin lost-reply audit):
 * what the groups list still shows, and what cannot be told. See `lib/lostReplyCopy`.
 */
export const GROUP_LOST = {
  archive: (name: string) => unsureWords(`${name} is still active`, `${name} was archived`, "Groups"),
  restore: (name: string) => unsureWords(`${name} is still archived`, `${name} was brought back`, "Groups"),
  remove: (name: string) => unsureWords(`${name} is still there`, `${name} was deleted`, "Groups"),
  /** The sheet's save: nothing the list shows says it landed, so the sheet stays open with the edits. */
  save: unsureWords("the group is as it was", "the group was saved", "Groups"),
} as const;

export const ARCHIVED_HEADING = "Archived";

// ---------------------------------------------------------------------------------------
// GroupAssign — one member's groups, set whole
// ---------------------------------------------------------------------------------------

export const ASSIGN_COPY = {
  title: (name: string) => `Groups for ${name}`,
  description: "Their groups decide what a slot costs them, when they may book, their top-up rate and peak hours.",
  label: "Groups",
  add: "Add a group",
  search: "Search groups",
  empty: "No groups match",
  none: "In no group — the club's standard rules and rate apply.",
  remove: (group: string) => `Take out of ${group}`,
  archived: "Archived",
  archivedHint: "Archived — can be kept, not joined",
  loadAction: "read the club's groups",
  whatChanges: "What changes",
  previewing: "Working out what changes…",
  previewFailed: "Couldn't work out what this changes. Saving still works, and the result will say.",
  nothingChanges: "Nothing about their rate or peak hours changes.",
  reasonLabel: "Why? (optional)",
  reasonHelp: "Goes on the change record.",
  change: "Change groups",
  changeFor: (name: string) => `Change groups for ${name}`,
  saveLabel: (name: string, count: number) => (count === 0
    ? `Take ${name} out of every group`
    : `Put ${name} in ${count === 1 ? "1 group" : `${count} groups`}`),
  saved: (name: string, count: number) => (count === 0
    ? `${name} is in no group now.`
    : `${name} is in ${count === 1 ? "1 group" : `${count} groups`} now.`),
  unchanged: "Nothing to change.",
} as const;

/** "1.6 → 2.4 cr per R1, from League" — a rate before and after, with where the new one comes from. */
export function rateChangeLine(
  before: number, after: number, afterGroup: string | null, clubWord = "the club's rate",
): string {
  const source = afterGroup ? `from ${afterGroup}` : clubWord;
  if (before === after) return `Top-up rate stays ${rateFace(after)} (${source}).`;
  return `Top-up rate ${formatRate(before)} → ${rateFace(after)} (${source}). Credit they already have doesn't change.`;
}

/** Peak before and after, naming the group that withholds it when one does. */
export function peakChangeLine(before: boolean, after: boolean, withheldBy: string[]): string {
  const by = withheldBy.length > 0 ? ` — ${listOf(withheldBy)} withholds it` : "";
  if (before === after) return after ? "Keeps peak priority." : `Still no peak priority${by}.`;
  return after ? "Gains peak priority." : `Loses peak priority${by}.`;
}

/** The member's standing, in one line under their groups: rate and peak. */
export function tariffLine(tariff: {
  top_up_credits_per_zar: number;
  peak_priority: boolean;
  peak_withheld_by?: string[];
}, rateGroupName: string | null): string {
  const rate = `Tops up at ${rateFace(tariff.top_up_credits_per_zar)}${rateGroupName ? ` (${rateGroupName})` : " (club rate)"}`;
  if (tariff.peak_priority) return `${rate} · peak priority`;
  const by = tariff.peak_withheld_by && tariff.peak_withheld_by.length > 0
    ? ` (withheld by ${listOf(tariff.peak_withheld_by)})`
    : "";
  return `${rate} · no peak priority${by}`;
}

/** PUT `/admin/members/{id}/groups` refusals, as sentences. */
export const ASSIGN_REFUSAL_CODES: Record<string, string> = {
  group_ids_required: "The club's system didn't receive the list of groups. Try again.",
  group_not_found: "One of those groups no longer exists — somebody deleted it. Reopen this and choose again.",
  group_archived: "One of those groups has been archived, so nobody can join it. Take it off and save again.",
  too_many_groups: "That's more groups than the club can hold.",
  member_not_found: "The club's system doesn't have this member any more.",
};

/** A refusal with the group it names, where the server named one. */
export function explainAssignRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code === "group_archived") {
    const name = err.detail("name");
    if (typeof name === "string" && name) {
      return `${name} has been archived, so nobody can join it. Take it off and save again.`;
    }
  }
  return describeFailure(err, { action: "change their groups", codes: ASSIGN_REFUSAL_CODES });
}

// ---------------------------------------------------------------------------------------
// The member's top-up screen
// ---------------------------------------------------------------------------------------

/**
 * "Your rate: League — 2.4 cr per R1" — the rate the member is quoted, and the group it comes
 * from in the club's own words. No group is the club's standard rate, said as such; an API that
 * predates D2 sends no `rate_group` at all, and then the line names only the rate.
 */
export function yourRateLine(rate: number, rateGroup: { name: string } | null | undefined): string {
  if (rateGroup === undefined) return `Your rate: ${rateFace(rate)}`;
  if (rateGroup === null) return `Your rate: the club's standard rate — ${rateFace(rate)}`;
  return `Your rate: ${rateGroup.name} — ${rateFace(rate)}`;
}

// ---------------------------------------------------------------------------------------
// The rest of what a change of groups changes (review round 1, F3.12)
// ---------------------------------------------------------------------------------------

type RulesForLines = {
  allowed_windows?: Array<{ start: string; end: string }> | null;
  max_slots_per_day?: number | null;
  max_minutes_per_day?: number | null;
  advance_booking_days?: number | null;
};

function windowsFace(windows: RulesForLines["allowed_windows"]): string | null {
  if (!windows) return null;
  if (windows.length === 0) return "no times at all";
  return windows.map((w) => `${w.start}–${w.end}`).join(", ");
}

/** A cap in words: a positive number, or "no limit" for the 0 / null the server uses for none. */
function capFace(value: number | null | undefined, unit: (n: number) => string): string | null {
  if (value === undefined) return null;
  return value === null || value <= 0 ? "no limit" : unit(value);
}

/**
 * The booking times and daily limits a change of groups changes — the preview named only the
 * rate, the peak say and the slot price, so an admin could move somebody into a group that halved
 * what they may book and read "nothing else changes". Only the lines that DIFFER are returned,
 * and a figure the server did not send on either side is not compared.
 */
export function rulesChangeLines(before: RulesForLines, after: RulesForLines): string[] {
  const lines: string[] = [];
  const wBefore = windowsFace(before.allowed_windows);
  const wAfter = windowsFace(after.allowed_windows);
  if (wBefore !== null && wAfter !== null && wBefore !== wAfter) {
    lines.push(`Today they could book ${wAfter} instead of ${wBefore}.`);
  }
  const pairs: Array<[number | null | undefined, number | null | undefined, string, (n: number) => string]> = [
    [before.max_slots_per_day, after.max_slots_per_day, "Slots a day", (n) => slotsWord(n)],
    [before.max_minutes_per_day, after.max_minutes_per_day, "Minutes a day", (n) => `${n} minutes`],
    [before.advance_booking_days, after.advance_booking_days, "Booking ahead", (n) => (n === 1 ? "1 day" : `${n} days`)],
  ];
  for (const [was, will, label, unit] of pairs) {
    const a = capFace(was, unit);
    const b = capFace(will, unit);
    if (a !== null && b !== null && a !== b) lines.push(`${label}: ${b} instead of ${a}.`);
  }
  return lines;
}

/**
 * "Juniors members" — or just "League members" when the group is already named for its members
 * (F3.23: the page read "League members members get the club's limit").
 */
export function membersOf(groupName: string): string {
  return /\bmembers$/i.test(groupName.trim()) ? groupName.trim() : `${groupName} members`;
}
