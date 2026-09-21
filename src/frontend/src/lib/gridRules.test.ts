import { describe, expect, it } from "vitest";
import type { ScheduleDay } from "./api";
import { cellVerdict, readViewerRules } from "./gridRules";

/**
 * What the grid is allowed to believe about a member's own rules.
 *
 * <p>
 * <b>`available` is a promise</b>, in this repo's own words about the peak rule, and it was
 * broken once already: 44 cells a day drawn green to a Regular member, each opening a modal
 * quoting court, time, cost and balance-after before refusing after Confirm. Items 3 and 19
 * would repeat that exactly — for the group window and for the daily cap — if the grid
 * guessed. So it is TOLD, by `/schedule`'s `rules` block, and everything below is about what
 * it does when it is told nothing, told a little, or told something it does not recognise.
 * </p>
 *
 * <p>
 * <b>Unknown is never false.</b> `lib/scheduleGrid`'s own doc-comment sets the rule this
 * module inherits: every missing field answers "bookable", because a client that hides cells
 * on an absent field refuses bookings the club would happily take. The backend for these
 * fields is being built in parallel with this screen; for as long as it is absent, this grid
 * must behave exactly as it did before the fields existed.
 * </p>
 */

const BASE: ScheduleDay = {
  date: "2026-09-21", timezone: "Africa/Johannesburg", sliceMinutes: 15,
  dayStartMinute: 360, dayEndMinute: 1320, advanceBookingDays: 14,
  penaltyPct: 30, penaltyWindowMinutes: 15,
  courts: [], slots: [],
};

const NOTHING = { isPast: false, outOfHours: false, peakRestricted: false, minuteOfDay: 17 * 60, sliceMinutes: 15 };

describe("readViewerRules", () => {
  it("answers 'nothing is known' for a payload with no rules block at all", () => {
    const r = readViewerRules(BASE);
    expect(r.known).toBe(false);
    expect(r.remainingToday).toBeNull();
    expect(r.allowedWindows).toBeNull();
    expect(r.adminExempt).toBe(false);
  });

  it("reads D2 §4.4's camelCase block as written", () => {
    const r = readViewerRules({ ...BASE, rules: {
      clubDay: "2026-09-21",
      groups: [{ id: "g1", name: "Non-league members" }],
      allowedWindows: [{ start: "06:00", end: "09:00" }],
      clubHours: { start: "06:00", end: "22:00" },
      slicePriceCredits: 12.5, maxSlotsPerDay: 4, maxMinutesPerDay: 60,
      bookedSlotsToday: 2, bookedMinutesToday: 30, remainingToday: 2,
      adminExempt: false, emptyWindowReason: null,
    } } as ScheduleDay);
    expect(r.known).toBe(true);
    expect(r.groups).toEqual([{ id: "g1", name: "Non-league members" }]);
    expect(r.allowedWindows).toEqual([{ start: "06:00", end: "09:00" }]);
    expect(r.remainingToday).toBe(2);
    expect(r.maxSlotsPerDay).toBe(4);
    expect(r.slicePriceCredits).toBe(12.5);
  });

  it("also reads the snake_case spelling, including the orchestrator's `remaining_slots_today`", () => {
    // Ruling 1 makes D2's wire the contract and D2 §4.4 writes this block in camelCase, which
    // is what `/schedule` already uses for every other field. Ruling 3 names the same number
    // `remaining_slots_today`. Both are accepted rather than guessed at, because guessing
    // wrong here is a locked grid for every member of the club.
    const r = readViewerRules({ ...BASE, rules: {
      remaining_slots_today: 0, max_slots_per_day: 4, booked_slots_today: 4,
      allowed_windows: [{ start: "17:00", end: "21:00" }],
      club_hours: { start: "06:00", end: "22:00" },
      admin_exempt: false,
      empty_window_reason: null,
    } } as unknown as ScheduleDay);
    expect(r.known).toBe(true);
    expect(r.remainingToday).toBe(0);
    expect(r.maxSlotsPerDay).toBe(4);
    expect(r.allowedWindows).toEqual([{ start: "17:00", end: "21:00" }]);
  });

  it("treats an admin's null quota as 'no limit', not as 'none left'", () => {
    // D2 §4.4: adminExempt makes remainingToday null and every reason null. A grid that read
    // null as zero would lock every cell on the one account that is exempt from everything.
    const r = readViewerRules({ ...BASE, rules: { adminExempt: true, remainingToday: null } } as ScheduleDay);
    expect(r.adminExempt).toBe(true);
    expect(r.remainingToday).toBeNull();
  });

  it("drops a window it cannot parse rather than believing it", () => {
    const r = readViewerRules({ ...BASE, rules: {
      allowedWindows: [{ start: "17:00", end: "21:00" }, { start: "boom", end: "21:00" }, { start: "21:00", end: "20:00" }],
    } } as ScheduleDay);
    expect(r.allowedWindows).toEqual([{ start: "17:00", end: "21:00" }]);
  });

  it("answers no windows at all — not 'unknown' — when the server says the intersection is empty", () => {
    const r = readViewerRules({ ...BASE, rules: {
      allowedWindows: [],
      emptyWindowReason: { groups: ["League members", "Non-league members"], day: "tue" },
    } } as ScheduleDay);
    expect(r.allowedWindows).toEqual([]);
    expect(r.emptyWindow?.groups).toHaveLength(2);
  });
});

describe("cellVerdict", () => {
  const rules = (over: Partial<ReturnType<typeof readViewerRules>>) =>
    ({ ...readViewerRules(BASE), ...over }) as ReturnType<typeof readViewerRules>;

  it("offers the slot when nothing is known — the client fails towards selling", () => {
    expect(cellVerdict(rules({}), NOTHING)).toEqual({ bookable: true, reason: null });
  });

  it("calls a started slot past before it calls it anything else", () => {
    expect(cellVerdict(rules({}), { ...NOTHING, isPast: true, outOfHours: true }).reason).toBe("past_time");
  });

  it("calls a shut club closed", () => {
    expect(cellVerdict(rules({}), { ...NOTHING, outOfHours: true }).reason).toBe("out_of_hours");
  });

  it("refuses a slot that does not lie ENTIRELY inside one allowed window", () => {
    const r = rules({ known: true, allowedWindows: [{ start: "17:00", end: "21:00" }] });
    // 17:00 for 15 minutes: inside.
    expect(cellVerdict(r, { ...NOTHING, minuteOfDay: 17 * 60 }).bookable).toBe(true);
    // 16:45 for 15 minutes: ends exactly on the edge, so it is outside.
    expect(cellVerdict(r, { ...NOTHING, minuteOfDay: 16 * 60 + 45 }).reason).toBe("group_window");
    // 20:45–21:00: the last slot that fits.
    expect(cellVerdict(r, { ...NOTHING, minuteOfDay: 20 * 60 + 45 }).bookable).toBe(true);
    expect(cellVerdict(r, { ...NOTHING, minuteOfDay: 21 * 60 }).reason).toBe("group_window");
  });

  it("does not let a booking straddle two windows that happen to touch it", () => {
    const r = rules({ known: true, allowedWindows: [{ start: "06:00", end: "09:00" }, { start: "09:15", end: "12:00" }] });
    expect(cellVerdict(r, { ...NOTHING, minuteOfDay: 9 * 60, sliceMinutes: 15 }).reason).toBe("group_window");
  });

  it("names the empty intersection as its own thing, not as an ordinary window refusal", () => {
    const r = rules({ known: true, allowedWindows: [], emptyWindow: { groups: ["A", "B"], day: "tue" } });
    expect(cellVerdict(r, NOTHING).reason).toBe("no_bookable_window");
  });

  it("locks a cell only once the quota has actually run out", () => {
    expect(cellVerdict(rules({ known: true, remainingToday: 1 }), NOTHING).bookable).toBe(true);
    expect(cellVerdict(rules({ known: true, remainingToday: 0 }), NOTHING).reason).toBe("per_day_slot_cap");
  });

  it("exempts an admin from every rule on their own grid", () => {
    const r = rules({
      known: true, adminExempt: true, remainingToday: 0,
      allowedWindows: [{ start: "06:00", end: "07:00" }],
    });
    expect(cellVerdict(r, { ...NOTHING, peakRestricted: true })).toEqual({ bookable: true, reason: null });
    // Not past and not closed, though — those are facts about the world, not about a role.
    expect(cellVerdict(r, { ...NOTHING, isPast: true }).reason).toBe("past_time");
  });

  it("keeps the peak rule the client already mirrors, and puts the group's window first", () => {
    expect(cellVerdict(rules({}), { ...NOTHING, peakRestricted: true }).reason).toBe("peak_league_only");
    const both = rules({ known: true, allowedWindows: [{ start: "06:00", end: "07:00" }] });
    expect(cellVerdict(both, { ...NOTHING, peakRestricted: true }).reason).toBe("group_window");
  });

  it("puts the quota AFTER every reason that is about the slot rather than about the member", () => {
    // A member at their cap looking at a league-only cell is not 'Full' — that slot was never
    // theirs to take, and telling them to cancel one of their own would be a lie.
    const r = rules({ known: true, remainingToday: 0 });
    expect(cellVerdict(r, { ...NOTHING, peakRestricted: true }).reason).toBe("peak_league_only");
  });
});
