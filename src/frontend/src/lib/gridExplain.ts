import { useCallback, useMemo, useState } from "react";
import type { ScheduleDay, ScheduleSlot } from "./api";
import type { GridReason, ViewerRules } from "./gridRules";
import type { TimeSlice } from "./scheduleGrid";
import { walletTone } from "./balance";
import { adminWalletNote } from "./bookingsCopy";
import {
  closedSentence, earlierSummary, emptyWalletSentence, emptyWindowSentence, groupRateLine,
  quotaBannerBody, quotaBannerTitle, quotaPill, restrictionSentence,
} from "./gridCopy";

/**
 * Everything the grid says ABOUT itself: the standing notices above it, the sentence an
 * unavailable cell answers with, and the past wall's disclosure.
 *
 * <p>
 * One hook rather than five pieces of page state, because all five read the same two things —
 * the day and the viewer's rules — and because `pages/Schedule.tsx` is already at the
 * complexity gate's limit with the schedule's own state machine in it.
 * </p>
 */

export type Notice = {
  id: string;
  tone: "warning" | "info";
  title: string;
  body?: string;
  /**
   * A real way out, always. A notice with nothing to do about it is a wall.
   *
   * `to` is a route; `nextDay` asks the page to move the date on by one, which is the other
   * half of "cancel one of them, or pick another day".
   */
  action?: { label: string; to?: string; nextDay?: boolean };
};

export type GridExplainer = {
  /** The polite live region's current text. Empty except in the moment after something happened. */
  live: string;
  /**
   * The explanation a SIGHTED member reads — set only by `explain`, never by `announce`.
   *
   * <p>
   * The two used to be one string, so "Selection off." and "Selection cleared" were painted as a
   * banner over the grid. Chatter about the mode belongs to the screen reader alone; the answer a
   * locked cell gives belongs to everybody (D4 §2.9).
   * </p>
   */
  shown: string;
  /** Put the visible explanation away — its × button, and a change of day. */
  dismiss: () => void;
  announce: (text: string) => void;
  explain: (reason: GridReason, where: string) => void;
  /** `isAdmin` is the ACTOR's role: an admin may book at or below zero (R19), a member may not. */
  notices: (balanceCredits: number | null, day: ScheduleDay | null, isAdmin?: boolean) => Notice[];
  /** `null` until the member has booked something today — a counter from zero is noise. */
  quotaPill: { text: string; atLimit: boolean } | null;
  rateLine: string | null;
  collapsedRows: (
    slices: TimeSlice[], pastThresholdMs: number, expanded: boolean,
    isAdmin: boolean, slotsByCourt: Map<string, ScheduleSlot[]>,
  ) => { rows: number; label: string | null };
};

/**
 * The invisible nudge that makes a repeated announcement a second announcement.
 *
 * <p>
 * Built with `fromCharCode` rather than written as an escape in a template literal so it is a
 * deliberate character an `no-irregular-whitespace` rule can see the reason for, rather than
 * an invisible one somebody later deletes as a typo.
 * </p>
 */
const HAIR_SPACE = String.fromCharCode(0x200A);

/** @param dayLabel "Thu 1 Oct" when the grid shows a day other than today, else null (F1.7). */
export function useGridExplainer(day: ScheduleDay | null, rules: ViewerRules, dayLabel: string | null = null): GridExplainer {
  const [live, setLive] = useState("");
  const [shown, setShown] = useState("");

  // A live region only announces a change MADE to a node already in the document, and two
  // taps on the same cell must speak twice — a member pressing a locked cell again is asking
  // again. So the text is nudged with a hair space when it repeats, rather than churned to ""
  // (see `lib/announce`: an emptied region is itself an interruption on a braille display).
  const announce = useCallback((text: string) => {
    setLive((prev) => (prev === text ? text + HAIR_SPACE : text));
  }, []);

  const explain = useCallback((reason: GridReason, where: string) => {
    const sentence = sentenceFor(reason, where, day, rules);
    announce(sentence);
    setShown(sentence);
  }, [announce, day, rules]);
  const dismiss = useCallback(() => setShown(""), []);

  const notices = useCallback(
    (balanceCredits: number | null, current: ScheduleDay | null, isAdmin = false) =>
      buildNotices(rules, balanceCredits, current, isAdmin),
    [rules],
  );

  const pill = useMemo(() => {
    const booked = rules.bookedSlotsToday;
    const max = rules.maxSlotsPerDay;
    if (rules.adminExempt || booked === null || max === null || max <= 0 || booked <= 0) return null;
    // Approaching a limit is not a warning. Only arriving at it is.
    return { text: quotaPill(booked, max, dayLabel), atLimit: booked >= max };
  }, [rules, dayLabel]);

  const rateLine = useMemo(
    () => (rules.known && !rules.adminExempt && rules.groups.length > 0 ? groupRateLine(rules.groups) : null),
    [rules],
  );

  const collapsedRows = useCallback(
    (slices: TimeSlice[], pastThresholdMs: number, expanded: boolean, isAdmin: boolean,
      slotsByCourt: Map<string, ScheduleSlot[]>) =>
      collapseEarlier(slices, pastThresholdMs, expanded, isAdmin, slotsByCourt),
    [],
  );

  return { live, shown, dismiss, announce, explain, notices, quotaPill: pill, rateLine, collapsedRows };
}

/**
 * The one sentence a cell answers with. Never a code, never "an error occurred".
 *
 * <p>
 * A table of builders rather than a switch, so adding a reason to D2 §4.4's closed vocabulary
 * is one row and not one more branch through a function the complexity gate already watches.
 * The default arm is what an UNKNOWN reason gets — a server ahead of this client says something
 * honest rather than nothing.
 * </p>
 */
type SentenceContext = { where: string; clubDay: string; rules: ViewerRules; day: ScheduleDay | null };

const SENTENCE: Partial<Record<GridReason, (c: SentenceContext) => string>> = {
  // The hours are on the day payload already (`dayStartMinute` / `dayEndMinute`, per weekday),
  // so the sentence names them even on a server that sends no `rules` block at all. "The club
  // is shut at that time" is the honest fallback; it is not the best answer available, and the
  // best answer is already in the client's hands.
  out_of_hours: (c) => `${c.where}: ${closedSentence(c.clubDay, c.rules.clubHours ?? hoursFromDay(c.day))}`,
  no_bookable_window: (c) =>
    emptyWindowSentence(c.rules.emptyWindow?.groups ?? c.rules.groups.map((g) => g.name), c.clubDay),
  group_window: (c) => restrictionSentence(c.where, c.rules.groups, c.rules.allowedWindows ?? []),
  peak_league_only: (c) => `${c.where} is reserved for league and senior members until closer to the time. `
    + "It becomes yours to book if it is still free then.",
  per_day_slot_cap: (c) =>
    `${quotaBannerTitle(c.rules.maxSlotsPerDay ?? 0, c.clubDay)} ${quotaBannerBody(c.rules.maxSlotsPerDay ?? 0)}`,
  per_day_minute_cap: (c) => `You've booked your ${c.rules.maxMinutesPerDay ?? 0} minutes of court time for that day. `
    + "Cancel one of them, or pick another day.",
  court_inactive: (c) => `${c.where} is not in use at the moment. The club can tell you when it is back.`,
};

function sentenceFor(reason: GridReason, where: string, day: ScheduleDay | null, rules: ViewerRules): string {
  const build = SENTENCE[reason];
  const clubDay = rules.clubDay ?? day?.date ?? "";
  return build ? build({ where, clubDay, rules, day }) : `${where} isn't available.`;
}

/**
 * The standing notices above the grid.
 *
 * <p>
 * Banners, never toasts. A toast for a STANDING condition clears itself after four seconds and
 * leaves the member staring at a locked grid with no explanation — and the toast viewport
 * deliberately carries no live region of its own (`Toast.tsx`), so a member who looked away
 * gets nothing at all.
 * </p>
 */
function buildNotices(rules: ViewerRules, balanceCredits: number | null, day: ScheduleDay | null, isAdmin: boolean): Notice[] {
  const clubDay = rules.clubDay ?? day?.date ?? "";
  return [ruleNotice(rules, clubDay), walletNotice(balanceCredits, day, isAdmin)]
    .filter((n): n is Notice => n !== null);
}

/** At most one rule notice: the empty intersection outranks the cap, because it outlasts it. */
function ruleNotice(rules: ViewerRules, clubDay: string): Notice | null {
  // An exempt viewer has no window and no cap to be told about, whatever else the block carries.
  if (rules.adminExempt) return null;
  if (rules.emptyWindow) {
    return { id: "empty-window", tone: "warning", title: emptyWindowSentence(rules.emptyWindow.groups, clubDay) };
  }
  const max = rules.maxSlotsPerDay ?? 0;
  if (rules.remainingToday !== 0 || max <= 0) return null;
  return {
    id: "quota", tone: "warning",
    title: quotaBannerTitle(max, clubDay),
    body: quotaBannerBody(max),
    action: { label: "Try tomorrow", nextDay: true },
  };
}

/**
 * D4 §2.6. A member with 0.00 credits was shown thirty-one green cells and found out in the
 * dialog, after picking a court and a time. `null` is UNKNOWN — a wallet read that has not
 * landed — and says nothing, because a grid that shouted "no credits" at a slow network would
 * be wrong more often than right.
 *
 * <p>
 * <b>An admin is not refused.</b> R19: an admin books at or below zero, and the booking API lets
 * them. "You can't book yet" was false for the desk, so an admin at or below zero gets a calm
 * `info` note with the figure and what it means — no Top up call to action, because nothing is
 * blocked.
 * </p>
 */
export function walletNotice(balanceCredits: number | null, day: ScheduleDay | null, isAdmin = false): Notice | null {
  // Through `walletTone`, and exported so the one rule can be asserted on all three surfaces
  // at once. This used to ask `balanceCredits > 0`, which let 0.004 through — a balance that
  // renders as "0.00" and buys nothing, on a grid still offering thirty-one green cells while
  // the chip beside it was already red.
  if (walletTone(balanceCredits) !== "zero") return null;
  if (isAdmin) return { id: "wallet-admin", tone: "info", title: adminWalletNote(balanceCredits ?? 0) };
  return {
    id: "wallet", tone: "warning",
    // The balance, not just the price. A member below zero is told what they owe rather than
    // that they "have no credits" — the banner could not say it while this dropped the figure.
    title: emptyWalletSentence(balanceCredits, cheapestSlice(day)),
    action: { label: "Top up", to: "/wallet/topup" },
  };
}

/** The club's own opening and closing for THIS weekday, as clock faces. */
function hoursFromDay(day: ScheduleDay | null): { start: string; end: string } | null {
  if (!day || typeof day.dayStartMinute !== "number" || typeof day.dayEndMinute !== "number") return null;
  if (day.dayEndMinute <= day.dayStartMinute) return null;
  return { start: asClock(day.dayStartMinute), end: asClock(day.dayEndMinute) };
}

function asClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function cheapestSlice(day: ScheduleDay | null): number | null {
  const prices = (day?.courts ?? []).map((c) => c.slicePriceCredits).filter((p) => typeof p === "number");
  return prices.length ? Math.min(...prices) : null;
}

/**
 * How many leading rows the past wall swallows, and what its disclosure says.
 *
 * <p>
 * D4 §7.4 and D3-B01. Measured at 375×812: 247 past cells and the first bookable slot
 * <b>3 670 px</b> below the top — 74 rows, about four and a half phone screens. The rows are
 * not deleted, because `gridWindow`'s own comment records the member who was sold 03:00 on a
 * Sunday and could find it on no screen in the product. They collapse.
 * </p>
 *
 * <p>
 * <b>Expanded by default when any of them is the viewer's own</b>, and for an admin, who is
 * reconciling the day rather than shopping for a court. A member who played this morning must
 * not have to find a disclosure to see their own booking.
 * </p>
 */
export function collapseEarlier(
  slices: TimeSlice[], pastThresholdMs: number, expanded: boolean, isAdmin: boolean,
  slotsByCourt: Map<string, ScheduleSlot[]>,
): { rows: number; label: string | null } {
  let past = 0;
  for (const t of slices) {
    if (Date.parse(t.utc) > pastThresholdMs) break;
    past += 1;
  }
  // One or two dead rows are not a wall, and a disclosure over them costs more than it saves.
  if (past < 4 || past === slices.length) return { rows: 0, label: null };

  const until = Date.parse(slices[past - 1].utc);
  const mine = countMine(slotsByCourt, until);
  if (expanded || isAdmin || mine > 0) return { rows: 0, label: null };
  return { rows: past, label: earlierSummary(past, mine, slices[0].label, slices[past - 1].label) };
}

function countMine(slotsByCourt: Map<string, ScheduleSlot[]>, untilMs: number): number {
  let n = 0;
  for (const slots of slotsByCourt.values()) {
    for (const s of slots) if (s.isMine && Date.parse(s.startsAtUtc) <= untilMs) n += 1;
  }
  return n;
}
