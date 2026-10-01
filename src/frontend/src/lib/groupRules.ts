import type { MemberGroup, Weekday } from "./adminApi";

/**
 * Most-restrictive-wins, as arithmetic — GOAL item 3, D2 §4.2.
 *
 * <p>
 * <b>Pure, total, and the security boundary of the feature.</b> Nothing here fetches, renders
 * or throws: every function takes what it needs and answers for every input, including the
 * inputs a hand-edited database row can produce. That is deliberate — D3 §12 names a surviving
 * mutant in the intersection operator a release blocker, and a module you can only exercise
 * through a screen is a module nobody mutation-tests.
 * </p>
 *
 * <p>
 * <b>"Most restrictive" means the member gets the least favourable of the rules that apply to
 * them</b>, which is XACML's deny-overrides read in three shapes: for a permission the least
 * favourable is the NARROWEST window, so windows intersect; for a cap it is the SMALLEST, so
 * caps take a minimum; for a package discount it is the LOWEST a group sets (P13 §3.8). There is
 * no price here: a booking costs its playing minutes, the same for every member (P13 §1.1).
 * </p>
 *
 * <p>
 * <b>Nothing in this module touches an instant, and that is a correctness property rather than
 * an omission.</b> A window is a wall-clock face inside the club's own day — 17:00 on a Tuesday
 * is 17:00 in March and in June — so turning one into a `Date` to compare it would move the
 * answer twice a year at exactly the clubs that keep DST. Minutes past the club's midnight is
 * the only representation that survives that, and `resolveDay` is pinned against a DST club
 * and a club west of UTC for the reason.
 * </p>
 */

/** A half-open run of minutes past the club's local midnight: `[start, end)`. */
export type Interval = { start: number; end: number };

/**
 * A cap of zero means UNLIMITED, everywhere in this codebase.
 *
 * Named rather than written as a bare `0`, because the whole trap is that `0` reads as "none"
 * to anybody who has not been told — and `Math.min(0, 4)` is what makes one unlimited group
 * forbid everything.
 */
export const UNLIMITED = 0;

export const MINUTES_IN_DAY = 1440;

/** Which of the three caps a resolution is about. Spelled as the wire spells them. */
export type CapKey = "max_slots_per_day" | "max_minutes_per_day" | "advance_booking_days";

// ---------------------------------------------------------------------------------------
// Clock faces
// ---------------------------------------------------------------------------------------

/**
 * `HH:mm` → minutes past midnight, or null for a face this module will not guess at.
 *
 * <p>
 * Null rather than `NaN`: a `NaN` inside an interval is a window that silently matches nothing
 * or everything depending on which side of a comparison it lands, and it propagates through
 * arithmetic without ever failing. A null is a thing a caller has to decide about.
 * </p>
 */
export function parseClock(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  const total = hours * 60 + minutes;
  // 24:00 is the API's own end-of-day face — `EndMinute <= 1440` — so it reads, and 24:01
  // does not.
  return total > MINUTES_IN_DAY ? null : total;
}

/** Minutes past midnight → `HH:mm`, with `1440` written as the end-of-day face `24:00`. */
export function formatClock(minutes: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_IN_DAY, Math.round(minutes)));
  const hours = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------------------

/** Sorted, with touching and overlapping runs merged, so one painted block is one interval. */
export function normalise(intervals: Interval[]): Interval[] {
  const sane = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .map((i) => ({ start: Math.max(0, i.start), end: Math.min(MINUTES_IN_DAY, i.end) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const interval of sane) {
    const last = out[out.length - 1];
    // `>=` and not `>`: 06:00–09:00 painted beside 09:00–12:00 is one block an admin dragged,
    // and reading it back as two would make the summary sentence say a gap that is not there.
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else out.push({ ...interval });
  }
  return out;
}

/**
 * Every minute in BOTH lists — the deny-overrides operator, and the one D3 §12 blocks a
 * release on.
 */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const left = normalise(a);
  const right = normalise(b);
  const out: Interval[] = [];
  for (const one of left) {
    for (const other of right) {
      const start = Math.max(one.start, other.start);
      const end = Math.min(one.end, other.end);
      if (end > start) out.push({ start, end });
    }
  }
  return normalise(out);
}

export function totalMinutes(intervals: Interval[]): number {
  return normalise(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
}

/**
 * How many whole slices fit inside these intervals.
 *
 * Per interval and then summed, never off the total: two 10-minute scraps are twenty minutes
 * and no bookable slot at all, and a screen that added them into one would offer a slot
 * nowhere on the grid.
 */
export function countSlots(intervals: Interval[], sliceMinutes: number): number {
  if (!Number.isFinite(sliceMinutes) || sliceMinutes <= 0) return 0;
  return normalise(intervals).reduce((sum, i) => sum + Math.floor((i.end - i.start) / sliceMinutes), 0);
}

/**
 * Whether a booking lies entirely inside ONE contiguous allowed interval.
 *
 * `CheckOperatingHoursRule`'s own whole-range rule: 08:45–09:15 across a 09:00 edge is refused
 * rather than half-sold, and a member allowed 06:00–09:00 and 17:00–21:00 cannot book across
 * the middle of the day by adding the two together.
 */
export function fitsInOneWindow(windows: Interval[], start: number, end: number): boolean {
  return normalise(windows).some((w) => w.start <= start && end <= w.end);
}

// ---------------------------------------------------------------------------------------
// The club's own hours
// ---------------------------------------------------------------------------------------

/** The club's settings document, as much of it as this module reads. */
export type ClubHoursSettings = {
  operating_hours?: Record<string, string | null> | null;
  day_start_minute?: number | null;
  day_end_minute?: number | null;
};

/**
 * The club's hours for one weekday — the ceiling on every group, and on the union of none.
 *
 * <p>
 * The map wins where it names the day; a day the map does NOT name falls back to the flat
 * `day_start_minute` / `day_end_minute` pair, which is `OperatingHours`' own rule and the only
 * thing that makes the flat pair mean anything. A day named as blank is a club that is SHUT,
 * and answers closed rather than falling through to the pair.
 * </p>
 */
export function clubHoursFor(settings: ClubHoursSettings | null | undefined, day: Weekday): Interval[] {
  const named = settings?.operating_hours?.[day];
  if (typeof named === "string") {
    const [from, to] = named.split("-");
    const start = parseClock(from);
    const end = parseClock(to);
    if (start === null || end === null || end <= start) return [];
    return [{ start, end }];
  }
  const start = settings?.day_start_minute;
  const end = settings?.day_end_minute;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return [];
  return normalise([{ start, end }]);
}

// ---------------------------------------------------------------------------------------
// One group's allowance
// ---------------------------------------------------------------------------------------

/** An archived group stops contributing to the intersection. That is what archiving is FOR. */
export function isActive(group: MemberGroup): boolean {
  return group.status !== "archived";
}

/** Every window row this group has, anywhere in the week — the "has it painted at all" test. */
function hasAnyWindow(group: MemberGroup): boolean {
  return (group.windows ?? []).length > 0;
}

/**
 * What one group allows on one weekday.
 *
 * <p>
 * <b>A group with no window rows ANYWHERE is unrestricted</b> — the club's own hours. Without
 * that clause, a group created to hold a DISCOUNT would silently forbid its members from booking
 * at all, which is the single worst failure this feature can have because it looks like the
 * club being shut.
 * </p>
 *
 * <p>
 * A group that has painted SOMETHING and left this day blank is closed on this day. Once a
 * group has painted Monday, its silence about Tuesday is a decision.
 * </p>
 *
 * <p>
 * A row the module cannot read — `end <= start`, outside `[0,1440]` — is DROPPED, and a dropped
 * row makes the group more restrictive rather than less. Failing closed is right for an access
 * rule; it is deliberately the opposite posture from `OperatingHours`, which is lenient because
 * a strict reading there would shut the club.
 * </p>
 */
export function allowFor(group: MemberGroup, day: Weekday, clubHours: Interval[]): Interval[] {
  if (!hasAnyWindow(group)) return normalise(clubHours);
  const rows = (group.windows ?? []).filter((w) => w.day === day);
  const intervals: Interval[] = [];
  for (const row of rows) {
    const start = parseClock(row.start);
    const end = parseClock(row.end);
    if (start === null || end === null || end <= start) continue;
    intervals.push({ start, end });
  }
  return normalise(intervals);
}

/**
 * `Allowed(m, d) = ClubHours(d) ∩ ⋂ over the member's active groups of Allow(g, d)`.
 *
 * A member in no group is unrestricted at the club's own hours — not refused, and not "the
 * default group's rules". A brand-new member must be able to book before an admin has
 * classified them, and a club that never opens this screen must behave exactly as it does today.
 */
export function allowedWindows(groups: MemberGroup[], day: Weekday, clubHours: Interval[]): Interval[] {
  let allowed = normalise(clubHours);
  for (const group of groups.filter(isActive)) {
    allowed = intersect(allowed, allowFor(group, day, clubHours));
    if (allowed.length === 0) break;
  }
  return allowed;
}

/**
 * The names of the groups that between them leave nothing, or null.
 *
 * <p>
 * Null when the CLUB is closed that day: "your groups disagree" about a Sunday nobody can book
 * is a sentence that sends an admin looking for a bug that is not there. The state this names
 * is the one D2 §4.3 calls reachable — two groups whose windows do not overlap — and it is
 * named rather than rendered as an empty grid, because an empty grid reads as "the club is
 * shut".
 * </p>
 */
export function emptyIntersection(
  groups: MemberGroup[], day: Weekday, clubHours: Interval[],
): string[] | null {
  if (normalise(clubHours).length === 0) return null;
  if (allowedWindows(groups, day, clubHours).length > 0) return null;
  return groups.filter(isActive).map((g) => g.name);
}

// ---------------------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------------------

/**
 * The MINIMUM over the member's groups, with the club's own value where a group inherits.
 *
 * <p>
 * <b>Zeros are skipped, because a zero is unlimited.</b> A naive `Math.min` would let one
 * unlimited group forbid everything, and that is the trap D2 calls out by name. Unlimited is
 * treated as +∞ here and answered as `UNLIMITED` when nothing finite survives.
 * </p>
 *
 * <p>
 * <b>A group may LOWER a cap and never raise one, and ruling 3 wins over D2 §4.2 here.</b> D2
 * writes `min over g of (g.cap ?? tenant)`, which consults the club's value only where a group
 * inherits — so a group override of 8 under a club limit of 4 would raise that member to 8.
 * Ruling 3 says a group may lower either cap and never raise one, so the club's own value stays
 * in the fold unconditionally and the answer is 4. D3 §6.3's example sentence ("League or
 * senior members may book 8 slots a day. Everyone else gets the club's 4") is written the other
 * way round and is wrong for the same reason; {@link capOverrideIsInert} is how the editor says
 * so at the moment an admin types it, rather than letting them believe a number that will never
 * bite.
 * </p>
 */
export function capFor(groups: MemberGroup[], key: CapKey, tenantDefault: number): number {
  const active = groups.filter(isActive);
  const values = active.map((group) => {
    const own = group.caps?.[key];
    return typeof own === "number" && Number.isFinite(own) ? own : tenantDefault;
  });
  values.push(tenantDefault);
  const bounded = values.filter((v) => Number.isFinite(v) && v > 0);
  return bounded.length === 0 ? UNLIMITED : Math.min(...bounded);
}

/**
 * Whether a group override an admin has just typed will change nothing.
 *
 * <p>
 * A silent no-op is the worst outcome available here: the admin types 8, presses Save, the
 * screen says saved, and the member goes on getting 4 with nothing anywhere explaining why.
 * Under ruling 3 a group can only tighten, so an override at or above the club's own bound —
 * and "unlimited" is above every bound — is inert and the editor says so.
 * </p>
 */
export function capOverrideIsInert(override: number, tenantValue: number | null): boolean {
  if (tenantValue === null || tenantValue <= 0) return false; // no club bound to be inert against
  if (override <= 0) return true; // "unlimited" cannot lift the club's own limit
  return override >= tenantValue;
}

/**
 * The real per-day ceiling in SLOTS — the stricter of the slot cap and the minute cap.
 *
 * Ruling 3: both caps stay and the most restrictive of the two applies. A club that sets 4
 * slots and leaves 60 minutes has set an hour, and no single field would have told them.
 */
export function ceilingSlots(slotCap: number, minuteCap: number, sliceMinutes: number): number {
  const fromSlots = slotCap > 0 ? slotCap : Number.POSITIVE_INFINITY;
  const fromMinutes = minuteCap > 0 && sliceMinutes > 0
    ? Math.floor(minuteCap / sliceMinutes)
    : Number.POSITIVE_INFINITY;
  const ceiling = Math.min(fromSlots, fromMinutes);
  return Number.isFinite(ceiling) ? ceiling : UNLIMITED;
}

// ---------------------------------------------------------------------------------------
// One day, resolved
// ---------------------------------------------------------------------------------------

export type DayOptions = {
  settings: ClubHoursSettings & { slice_minutes?: number | null };
  /** `member_max_slots_per_day` — the club-wide value the settings page owns. 0 = no limit. */
  slotCap: number;
  /** `member_per_day_max_minutes` — the older cap, which ruling 3 keeps. 0 = no limit. */
  minuteCap: number;
  advanceDays: number;
};

export type ResolvedDay = {
  day: Weekday;
  clubHours: Interval[];
  allowed: Interval[];
  /** The names of the groups that between them leave nothing bookable, or null. */
  emptyBecause: string[] | null;
  maxSlotsPerDay: number;
  maxMinutesPerDay: number;
  advanceBookingDays: number;
  /** The stricter of the two caps, in slots. 0 = unlimited. */
  ceilingSlots: number;
  /** How many whole slices the member may book somewhere inside `allowed`. */
  allowedSlots: number;
  /** How many the club itself is open for, which is what `allowedSlots` is a fraction of. */
  clubSlots: number;
};

/**
 * Everything the page needs about one weekday for one member, from one call.
 *
 * Resolved as a bundle rather than field by field at each call site, because the six answers
 * are one decision and a screen that computed five of them against this week's groups and one
 * against last week's would be wrong in a way nothing on it could show.
 */
export function resolveDay(groups: MemberGroup[], day: Weekday, options: DayOptions): ResolvedDay {
  const slice = options.settings.slice_minutes ?? 15;
  const clubHours = clubHoursFor(options.settings, day);
  const allowed = allowedWindows(groups, day, clubHours);
  const slots = capFor(groups, "max_slots_per_day", options.slotCap);
  const minutes = capFor(groups, "max_minutes_per_day", options.minuteCap);
  return {
    day,
    clubHours,
    allowed,
    emptyBecause: emptyIntersection(groups, day, clubHours),
    maxSlotsPerDay: slots,
    maxMinutesPerDay: minutes,
    advanceBookingDays: capFor(groups, "advance_booking_days", options.advanceDays),
    ceilingSlots: ceilingSlots(slots, minutes, slice),
    allowedSlots: countSlots(allowed, slice),
    clubSlots: countSlots(clubHours, slice),
  };
}

/** The week, in the order a club reads it — Monday first, Sunday last. */
export const WEEK_IN_READING_ORDER: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// ---------------------------------------------------------------------------------------
// The tariff — package discount and peak priority (D2: groups replace the member class; P13 §3.8)
// ---------------------------------------------------------------------------------------

/** The API's bounds on a group's package discount, in basis points: 0 to 10 000 (100 %). */
export const MIN_PACKAGE_DISCOUNT_BPS = 0;
export const MAX_PACKAGE_DISCOUNT_BPS = 10_000;

/** One group as the tariff reads it. `undefined` / `null` (no say) never counts as a discount. */
export type TariffInput = Pick<MemberGroup, "id" | "name"> & {
  status?: MemberGroup["status"];
  sort_order?: number;
  package_discount_bps?: number | null;
  peak_priority?: boolean | null;
};

export type ResolvedTariff = {
  /** The package discount in basis points; null when no active group sets one. */
  discountBps: number | null;
  /** The group the discount comes from, or null when there is none. */
  discountGroup: TariffInput | null;
  peak: boolean;
  /** The groups explicitly withholding peak priority, by name. */
  withheldBy: string[];
};

/** A discount a group really SETS: a whole number of basis points in range. Anything else is no say. */
function setsDiscount(bps: number | null | undefined): bps is number {
  return typeof bps === "number" && Number.isInteger(bps) && bps >= MIN_PACKAGE_DISCOUNT_BPS && bps <= MAX_PACKAGE_DISCOUNT_BPS;
}

/**
 * What a member's groups add up to — the SAME rule as the server's `MemberTariffs.Resolve`.
 *
 * <p>
 * <b>Discount: the LOWEST any active group sets; none when no group sets one</b> (P13 §3.8,
 * "most restrictive"). A group with no say is skipped rather than read as 0 %: a "Juniors" group
 * made only to hold a booking window must not take a league member's discount away. An archived
 * group says nothing. The discount is rand off a package; it never changes minutes (§1.2).
 * </p>
 *
 * <p>
 * <b>Peak: granted when at least one active group grants it and none withholds it.</b> A group
 * with no say cannot take a league member's priority away; an explicit "withholds" wins over any
 * number of grants, and is named, so a refusal can say which group stopped them.
 * </p>
 *
 * <p>
 * Ties on the discount go to the club's own order (sort order, then name, then id) — the
 * server's tie-break, so the group this names is the group the purchase row will name.
 * </p>
 */
export function resolveTariff(groups: TariffInput[]): ResolvedTariff {
  const ordered = groups
    .filter((g) => (g.status ?? "active") === "active")
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let discountGroup: TariffInput | null = null;
  for (const group of ordered) {
    const bps = group.package_discount_bps;
    if (!setsDiscount(bps)) continue;
    if (discountGroup === null || bps < (discountGroup.package_discount_bps as number)) discountGroup = group;
  }
  const withheldBy = ordered.filter((g) => g.peak_priority === false).map((g) => g.name);
  const peak = ordered.some((g) => g.peak_priority === true) && withheldBy.length === 0;
  return {
    discountBps: discountGroup ? (discountGroup.package_discount_bps as number) : null,
    discountGroup,
    peak,
    withheldBy: peak ? [] : withheldBy,
  };
}
