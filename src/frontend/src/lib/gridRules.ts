import type { ScheduleDay, ScheduleRulesWire } from "./api";

/**
 * The viewer's own booking rules, as the grid is TOLD them — never as it guesses them.
 *
 * <p>
 * <b>Why the grid is told.</b> `lib/scheduleGrid`'s `peakRestricted` mirrors
 * `BookingService.CheckPeakHoursRule` in the browser, and its own comment admits the cost:
 * two implementations of one money rule are two places to get it wrong. Items 3 and 19 add a
 * group window and a daily cap, both of which decide money, and neither is mirrored here.
 * `/schedule` computes them with the same evaluator the POST uses (D2 §3.3) and sends the
 * answer; this module reads it.
 * </p>
 *
 * <p>
 * <b>What it does when it is told nothing.</b> The backend for these fields is being built
 * alongside this screen, so every field is optional and an absent one answers "bookable".
 * That is not defensive padding — a grid that greys cells out on a missing field refuses
 * bookings the club would happily take, and the same rule is already written on the peak
 * mirror it sits beside. `known` is what separates "the club has no groups" from "this server
 * does not know about groups yet", and it is why `remainingToday: null` means *no limit*
 * rather than *none left*.
 * </p>
 *
 * <p>
 * <b>Two spellings, on purpose.</b> D2 §4.4 writes the block in camelCase, which is what
 * `/schedule` already uses for every other field it carries; the orchestrator's ruling 3 names
 * the same number `remaining_slots_today`. Reading both costs one line per key and removes
 * the failure where a spelling mismatch locks every cell on the club's grid — which would look
 * exactly like the cap working.
 * </p>
 */

export type ClockWindow = { start: string; end: string };

/** One of D2 §4.4's closed vocabulary — the same set the POST refuses with. */
export type GridReason =
  | "out_of_hours" | "group_window" | "no_bookable_window" | "peak_league_only"
  | "per_day_slot_cap" | "per_day_minute_cap" | "past_time" | "too_far_ahead"
  | "slot_taken" | "admin_block" | "court_inactive";

export type ViewerRules = {
  /** Whether this server said anything at all about the viewer's rules. */
  known: boolean;
  /** True ⇒ no window, no cap and no peak rule applies, and the grid says so rather than showing a number. */
  adminExempt: boolean;
  groups: { id: string; name: string }[];
  /** `null` = the server did not say. `[]` = it said there are none, which is D2 §4.3's empty intersection. */
  allowedWindows: ClockWindow[] | null;
  clubHours: ClockWindow | null;
  slicePriceCredits: number | null;
  maxSlotsPerDay: number | null;
  maxMinutesPerDay: number | null;
  bookedSlotsToday: number | null;
  bookedMinutesToday: number | null;
  /** Slots this viewer may still take today. `null` = unlimited or unknown; `0` = the wall. */
  remainingToday: number | null;
  emptyWindow: { groups: string[]; day: string } | null;
  clubDay: string | null;
};

const NOTHING_KNOWN: ViewerRules = {
  known: false, adminExempt: false, groups: [], allowedWindows: null, clubHours: null,
  slicePriceCredits: null, maxSlotsPerDay: null, maxMinutesPerDay: null,
  bookedSlotsToday: null, bookedMinutesToday: null, remainingToday: null,
  emptyWindow: null, clubDay: null,
};

/**
 * <p>
 * <b>`actorIsAdmin` makes the viewer exempt, whatever the block says.</b> The booking API exempts
 * an admin ACTOR from every window, cap and peak rule (`BookingPayer.ActorIsAdmin`, decided by the
 * same role claim that makes this session an admin), so the grid must not paint the admin's own
 * groups' windows as restrictions it would never enforce. A current server says `adminExempt`
 * itself; one that does not (an older build, a block without the flag) used to lock an admin out
 * of cells the API would happily book. Booking AS a member (`?as=`, the sheet's "Book as") is
 * checked by that member's rules in the quote and the POST — the grid stays the actor's.
 * </p>
 */
export function readViewerRules(day: ScheduleDay | null, actorIsAdmin = false): ViewerRules {
  const raw = day?.rules as (ScheduleRulesWire & Record<string, unknown>) | undefined;
  if (!raw || typeof raw !== "object") return actorIsAdmin ? { ...NOTHING_KNOWN, adminExempt: true } : NOTHING_KNOWN;
  return {
    known: true,
    adminExempt: actorIsAdmin || pick(raw, "adminExempt", "admin_exempt") === true,
    groups: readGroups(pick(raw, "groups", "groups")),
    allowedWindows: readWindows(pick(raw, "allowedWindows", "allowed_windows")),
    clubHours: readWindow(pick(raw, "clubHours", "club_hours")),
    slicePriceCredits: num(pick(raw, "slicePriceCredits", "slice_price_credits")),
    maxSlotsPerDay: num(pick(raw, "maxSlotsPerDay", "max_slots_per_day")),
    maxMinutesPerDay: num(pick(raw, "maxMinutesPerDay", "max_minutes_per_day")),
    bookedSlotsToday: num(pick(raw, "bookedSlotsToday", "booked_slots_today")),
    bookedMinutesToday: num(pick(raw, "bookedMinutesToday", "booked_minutes_today")),
    remainingToday: num(pick(raw, "remainingToday", "remaining_today", "remaining_slots_today")),
    emptyWindow: readEmptyWindow(pick(raw, "emptyWindowReason", "empty_window_reason")),
    clubDay: str(pick(raw, "clubDay", "club_day")),
  };
}

/** What the grid needs to know about one cell before it can judge it. */
export type CellFacts = {
  minuteOfDay: number;
  sliceMinutes: number;
  isPast: boolean;
  outOfHours: boolean;
  /** The peak mirror the client already carries, evaluated by `lib/scheduleGrid`. */
  peakRestricted: boolean;
};

export type CellVerdict = { bookable: boolean; reason: GridReason | null };

const BOOKABLE: CellVerdict = { bookable: true, reason: null };

/**
 * Whether this viewer may take this cell, and — when not — which rule said so.
 *
 * <p>
 * <b>The order is the design, not an implementation detail.</b> Past first, because a started
 * slot has nothing to explain. Then the club being shut, which is a fact about the world.
 * Then the rules that say the slot was never this member's — the empty intersection, the
 * group's window, the peak rule — and only then the daily cap, which is about the member
 * rather than about the slot. A member at their cap looking at a league-only cell must not be
 * told to "cancel one of your four", because cancelling would not make that slot theirs.
 * </p>
 */
export function cellVerdict(rules: ViewerRules, cell: CellFacts): CellVerdict {
  if (cell.isPast) return { bookable: false, reason: "past_time" };
  if (cell.outOfHours) return { bookable: false, reason: "out_of_hours" };
  // An admin is exempt from every RULE — never from the clock and never from the club's hours.
  if (rules.adminExempt) return BOOKABLE;
  if (rules.emptyWindow) return { bookable: false, reason: "no_bookable_window" };
  if (outsideEveryWindow(rules.allowedWindows, cell)) return { bookable: false, reason: "group_window" };
  if (cell.peakRestricted) return { bookable: false, reason: "peak_league_only" };
  if (rules.remainingToday === 0) return { bookable: false, reason: "per_day_slot_cap" };
  return BOOKABLE;
}

/**
 * The whole booking must lie inside ONE contiguous window.
 *
 * <p>
 * D2 §4.2: an 08:45–09:15 booking across a 09:00 edge is refused with the edge in the body,
 * and that is the same whole-range rule `CheckOperatingHoursRule` already applies. Two windows
 * that touch are still two windows — merging them here would offer a slot the server refuses.
 * </p>
 */
function outsideEveryWindow(windows: ClockWindow[] | null, cell: CellFacts): boolean {
  if (windows === null) return false;              // the server did not say — offer it
  if (windows.length === 0) return true;           // it said there are none
  const from = cell.minuteOfDay;
  const to = cell.minuteOfDay + cell.sliceMinutes;
  return !windows.some((w) => {
    const start = parseClock(w.start);
    const end = parseClock(w.end);
    return start !== null && end !== null && from >= start && to <= end;
  });
}

/** `HH:mm` as minutes past local midnight, or null for anything this cannot read. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/* ─────────────────────────── reading, defensively ─────────────────────────── */

function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readGroups(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((g) => (g && typeof g === "object" ? g as Record<string, unknown> : {}))
    .filter((g) => typeof g.name === "string")
    .map((g) => ({ id: typeof g.id === "string" ? g.id : "", name: g.name as string }));
}

/**
 * A window row with `end <= start`, or one this cannot parse, is DROPPED.
 *
 * <p>
 * D2 §4.7 decides the direction and gives the reason: for an access rule, failing closed is
 * right, and a dropped window makes the group more restrictive rather than less. The opposite
 * posture governs the club's own opening hours, which decide whether it can trade at all.
 * Two postures, two reasons, both written down.
 * </p>
 */
function readWindows(value: unknown): ClockWindow[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(readWindow).filter((w): w is ClockWindow => w !== null);
}

function readWindow(value: unknown): ClockWindow | null {
  if (!value || typeof value !== "object") return null;
  const { start, end } = value as Record<string, unknown>;
  if (typeof start !== "string" || typeof end !== "string") return null;
  const from = parseClock(start);
  const to = parseClock(end);
  if (from === null || to === null || to <= from) return null;
  return { start, end };
}

function readEmptyWindow(value: unknown): { groups: string[]; day: string } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const groups = Array.isArray(raw.groups) ? raw.groups.filter((g): g is string => typeof g === "string") : [];
  return { groups, day: typeof raw.day === "string" ? raw.day : "" };
}
