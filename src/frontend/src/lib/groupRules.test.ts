import { describe, expect, it } from "vitest";
import {
  UNLIMITED, allowedWindows, allowFor, capFor, capOverrideIsInert, ceilingSlots, clubHoursFor,
  countSlots, emptyIntersection, fitsInOneWindow, formatClock, intersect, memberSlicePrice,
  normalise, parseClock, priceForGroup, resolveDay, round2AwayFromZero, totalMinutes,
} from "./groupRules";
import { groupFixture, restrictedGroupFixture, weekdayWindows, windowFixture } from "../test/groupFixtures";
import { SETTINGS_FIXTURE } from "../test/harness";

/**
 * Most-restrictive-wins, as a table — GOAL item 3, D2 §4.2, D3 §12.
 *
 * <p>
 * <b>This module is the security boundary of the whole feature and it is why the test comes
 * first.</b> A wrong answer here sells a court that should not have been sold, or forbids a
 * member the club meant to let in, and neither failure announces itself: the grid simply
 * paints, and somebody pays. D3 §12 names a surviving mutant in the intersection operator a
 * release blocker, so the cases below are written to kill mutants rather than to cover lines —
 * a union where an intersection belongs, a `min` where a `max` belongs, a zero that means
 * unlimited being treated as a zero that means none.
 * </p>
 *
 * <p>
 * <b>Three traps have their own sections, because each of them produced a real defect in the
 * design review.</b> A group with no windows at all is UNRESTRICTED, not silenced — without
 * that clause a group created to hold a price forbids its members from booking. A price is
 * resolved by MAXIMUM, because "most restrictive" means the least favourable rule wins and the
 * least favourable price is the high one. And a cap of `0` means unlimited everywhere in this
 * codebase, so the `min` has to skip zeros or one unlimited group forbids everything.
 * </p>
 */

const CLUB_WEEKDAY = [{ start: 360, end: 1320 }]; // 06:00–22:00, the fixture club's weekday

describe("clock faces, which every window in this feature is written in", () => {
  it("reads and writes HH:mm as minutes past the club's midnight", () => {
    expect(parseClock("06:00")).toBe(360);
    expect(parseClock("17:45")).toBe(1065);
    // 24:00 is the API's own end-of-day face: `EndMinute <= 1440`.
    expect(parseClock("24:00")).toBe(1440);
    expect(formatClock(360)).toBe("06:00");
    expect(formatClock(1440)).toBe("24:00");
  });

  it("answers null for a face it cannot read, rather than a plausible number", () => {
    // A `NaN` flowing into an interval is a window that silently matches nothing and is
    // painted as if it matched everything, depending on which side of the comparison it lands.
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("6pm")).toBeNull();
    expect(parseClock("")).toBeNull();
    expect(parseClock("06:60")).toBeNull();
  });
});

describe("the club's own hours, which are the ceiling on every group", () => {
  it("reads the day's entry from the operating-hours map", () => {
    expect(clubHoursFor(SETTINGS_FIXTURE, "sat")).toEqual([{ start: 420, end: 1200 }]);
  });

  /**
   * Sunday is deliberately absent from the fixture map, and a day the map does not name is
   * the only way the flat `day_start_minute` / `day_end_minute` pair means anything.
   */
  it("falls back to the club's flat pair for a day the map does not name", () => {
    expect(clubHoursFor(SETTINGS_FIXTURE, "sun")).toEqual([{ start: 360, end: 1320 }]);
  });

  it("answers closed for a club that names the day as shut", () => {
    const shut = { ...SETTINGS_FIXTURE, operating_hours: { ...SETTINGS_FIXTURE.operating_hours, sat: "" } };
    expect(clubHoursFor(shut, "sat")).toEqual([]);
  });
});

describe("intervals", () => {
  it("merges touching and overlapping runs, so one painted block is one interval", () => {
    expect(normalise([{ start: 360, end: 480 }, { start: 480, end: 540 }])).toEqual([{ start: 360, end: 540 }]);
    expect(normalise([{ start: 480, end: 600 }, { start: 360, end: 540 }])).toEqual([{ start: 360, end: 600 }]);
  });

  it("keeps a real gap as two intervals — 06:00–09:00 AND 17:00–21:00 is the point", () => {
    expect(normalise([{ start: 1020, end: 1260 }, { start: 360, end: 540 }]))
      .toEqual([{ start: 360, end: 540 }, { start: 1020, end: 1260 }]);
  });

  /** The operator D3 §12 calls a release blocker if a mutant survives in it. */
  it("intersects rather than unions", () => {
    expect(intersect([{ start: 360, end: 1320 }], [{ start: 1020, end: 1260 }]))
      .toEqual([{ start: 1020, end: 1260 }]);
    expect(intersect([{ start: 360, end: 600 }], [{ start: 540, end: 900 }]))
      .toEqual([{ start: 540, end: 600 }]);
    // Disjoint is EMPTY, not both. A union here is the defect that sells a 21:00 court to a
    // member whose group stops at 16:00.
    expect(intersect([{ start: 360, end: 540 }], [{ start: 1020, end: 1260 }])).toEqual([]);
  });

  it("counts minutes and slots off the intervals, not off the painted cells", () => {
    expect(totalMinutes([{ start: 360, end: 540 }, { start: 1020, end: 1080 }])).toBe(240);
    expect(countSlots([{ start: 360, end: 540 }], 15)).toBe(12);
    expect(countSlots([{ start: 360, end: 540 }], 30)).toBe(6);
  });
});

describe("a group's own allowance for a day", () => {
  /**
   * <b>The clause without which the feature is a trap.</b> A club creating a group to hold a
   * PRICE paints nothing, and every member in it would be forbidden from booking at all.
   */
  it("treats a group with no window rows anywhere as unrestricted", () => {
    expect(allowFor(groupFixture(), "tue", CLUB_WEEKDAY)).toEqual(CLUB_WEEKDAY);
  });

  it("treats a group with windows on OTHER days as closed on this one", () => {
    // The other half of the same conditional, and the half that makes painting mean anything:
    // once a group has painted Monday, its silence about Tuesday is a decision.
    const group = groupFixture({ windows: [windowFixture("mon", "06:00", "16:00")] });
    expect(allowFor(group, "tue", CLUB_WEEKDAY)).toEqual([]);
  });

  it("unions several windows on one day", () => {
    const group = groupFixture({
      windows: [windowFixture("tue", "06:00", "09:00"), windowFixture("tue", "17:00", "21:00")],
    });
    expect(allowFor(group, "tue", CLUB_WEEKDAY))
      .toEqual([{ start: 360, end: 540 }, { start: 1020, end: 1260 }]);
  });

  /**
   * `GroupRules.WindowsFor` drops a row outside `[0,1440]` or with `End <= Start`, and a
   * dropped window makes the group MORE restrictive, not less. Failing closed is right for an
   * access rule; it is the opposite posture from `OperatingHours`, deliberately.
   */
  it("drops a window it cannot read rather than widening the group", () => {
    const group = groupFixture({
      windows: [windowFixture("tue", "21:00", "17:00"), windowFixture("tue", "06:00", "09:00")],
    });
    expect(allowFor(group, "tue", CLUB_WEEKDAY)).toEqual([{ start: 360, end: 540 }]);
  });
});

describe("the intersection, in 0, 1, 2 and 3 groups", () => {
  it("gives a member in NO group the club's own hours", () => {
    expect(allowedWindows([], "tue", CLUB_WEEKDAY)).toEqual(CLUB_WEEKDAY);
  });

  it("gives a member in one group that group's window, clipped to the club's hours", () => {
    const group = groupFixture({ windows: [windowFixture("tue", "05:00", "23:00")] });
    // Painted wider than the club is open; the club's hours are the ceiling.
    expect(allowedWindows([group], "tue", CLUB_WEEKDAY)).toEqual(CLUB_WEEKDAY);
  });

  it("gives a member in two groups only what BOTH allow", () => {
    const morning = groupFixture({ id: "a", windows: [windowFixture("tue", "06:00", "12:00")] });
    const afternoon = groupFixture({ id: "b", windows: [windowFixture("tue", "10:00", "18:00")] });
    expect(allowedWindows([morning, afternoon], "tue", CLUB_WEEKDAY))
      .toEqual([{ start: 600, end: 720 }]);
  });

  it("gives a member in three groups what all three allow, and an unrestricted one costs nothing", () => {
    const morning = groupFixture({ id: "a", windows: [windowFixture("tue", "06:00", "12:00")] });
    const afternoon = groupFixture({ id: "b", windows: [windowFixture("tue", "10:00", "18:00")] });
    const unrestricted = groupFixture({ id: "c", windows: [] });
    expect(allowedWindows([morning, afternoon, unrestricted], "tue", CLUB_WEEKDAY))
      .toEqual([{ start: 600, end: 720 }]);
  });

  it("ignores an archived group, which is what archiving is FOR", () => {
    const shut = groupFixture({ id: "a", status: "archived", windows: [windowFixture("tue", "06:00", "07:00")] });
    expect(allowedWindows([shut], "tue", CLUB_WEEKDAY)).toEqual(CLUB_WEEKDAY);
  });

  it("refuses a booking that crosses an edge, even when both halves are allowed separately", () => {
    // `CheckOperatingHoursRule`'s own whole-range rule: 08:45–09:15 across a 09:00 edge is
    // refused, and a member who can book 06:00–09:00 and 17:00–21:00 cannot book across.
    const windows = [{ start: 360, end: 540 }, { start: 1020, end: 1260 }];
    expect(fitsInOneWindow(windows, 480, 540)).toBe(true);
    expect(fitsInOneWindow(windows, 525, 555)).toBe(false);
    expect(fitsInOneWindow(windows, 500, 1100)).toBe(false);
  });
});

describe("the empty intersection — reachable, and named rather than rendered as an empty grid", () => {
  it("names the groups whose times do not overlap", () => {
    const early = groupFixture({ id: "a", name: "League members", windows: [windowFixture("tue", "06:00", "09:00")] });
    const late = groupFixture({ id: "b", name: "Non-league members", windows: [windowFixture("tue", "17:00", "21:00")] });
    expect(allowedWindows([early, late], "tue", CLUB_WEEKDAY)).toEqual([]);
    expect(emptyIntersection([early, late], "tue", CLUB_WEEKDAY))
      .toEqual(["League members", "Non-league members"]);
  });

  /**
   * A club that is shut on a Sunday is not a rules failure and must not be reported as one —
   * "your groups disagree" about a day nobody can book is a sentence that sends an admin
   * looking for a bug that is not there.
   */
  it("says nothing when the club itself is closed that day", () => {
    const group = groupFixture({ windows: [windowFixture("tue", "06:00", "09:00")] });
    expect(emptyIntersection([group], "sun", [])).toBeNull();
  });

  it("says nothing when there is something bookable", () => {
    expect(emptyIntersection([groupFixture()], "tue", CLUB_WEEKDAY)).toBeNull();
  });
});

describe("price — most restrictive is the HIGHEST, and that is the decision most likely to be argued with", () => {
  it("inherits the court's own price", () => {
    expect(priceForGroup(groupFixture(), 8)).toBe(8);
  });

  it("applies a multiplier in basis points, rounded away from zero to two places", () => {
    // `AwayFromZero` matches the walk-up pro-rata and the penalty, so the club does not round
    // in its own favour in one place and against itself in another.
    expect(priceForGroup(groupFixture({ pricing: { mode: "multiplier", multiplier_bps: 7_500 } }), 8)).toBe(6);
    expect(priceForGroup(groupFixture({ pricing: { mode: "multiplier", multiplier_bps: 12_500 } }), 8.01)).toBe(10.01);
    expect(round2AwayFromZero(8.005)).toBe(8.01);
    expect(round2AwayFromZero(-8.005)).toBe(-8.01);
  });

  it("takes a flat per-slice price as it stands", () => {
    expect(priceForGroup(groupFixture({ pricing: { mode: "flat_per_slice", flat_slice_price_credits: 12 } }), 8)).toBe(12);
  });

  it("answers null — not the court's price — for a flat group whose price the server has not sent", () => {
    // Unknown is never a number. A `?? courtPrice` here would quote a member the standard rate
    // for a group the club has priced, and nothing on the screen would say it was a guess.
    expect(priceForGroup(groupFixture({ pricing: { mode: "flat_per_slice", flat_slice_price_credits: null } }), 8))
      .toBeNull();
  });

  it("gives a member in no group the court's own price", () => {
    expect(memberSlicePrice([], 8)).toEqual({ credits: 8, unknown: false });
  });

  it("gives a member in two groups the HIGHER price, never the lower", () => {
    const cheap = groupFixture({ id: "a", pricing: { mode: "multiplier", multiplier_bps: 5_000 } });
    const dear = groupFixture({ id: "b", pricing: { mode: "flat_per_slice", flat_slice_price_credits: 12 } });
    // The mutant this kills is `Math.min`. It would make a mis-click cost the club revenue
    // nobody notices, instead of costing a member a price they can see before confirming.
    expect(memberSlicePrice([cheap, dear], 8)).toEqual({ credits: 12, unknown: false });
  });

  it("says so when one of the groups has a price it could not work out", () => {
    // The highest KNOWN figure, with the flag that stops the screen printing it as final. The
    // copy turns the pair into "at least R4.00", which is the only true sentence available
    // when one of the three rules has not arrived yet.
    const known = groupFixture({ id: "a", pricing: { mode: "multiplier", multiplier_bps: 5_000 } });
    const unknown = groupFixture({ id: "b", pricing: { mode: "flat_per_slice", flat_slice_price_credits: null } });
    expect(memberSlicePrice([known, unknown], 8)).toEqual({ credits: 4, unknown: true });
  });

  it("falls back to the court's own price when NO group's price could be read", () => {
    const unknown = groupFixture({ id: "b", pricing: { mode: "flat_per_slice", flat_slice_price_credits: null } });
    // Not zero. A maximum over nothing is 0, and quoting a member a free court because three
    // fields had not shipped is the one arithmetic mistake here that costs the club money.
    expect(memberSlicePrice([unknown], 8)).toEqual({ credits: 8, unknown: true });
  });

  it("clamps a multiplier outside the API's own bound rather than quoting it", () => {
    expect(priceForGroup(groupFixture({ pricing: { mode: "multiplier", multiplier_bps: -5_000 } }), 8)).toBe(0);
    // 1_000_000 bps is the API's ceiling: 100×, so R800.00 and not R800 000.00.
    expect(priceForGroup(groupFixture({ pricing: { mode: "multiplier", multiplier_bps: 9_999_999 } }), 8)).toBe(800);
  });
});

describe("caps — most restrictive is the MINIMUM, and 0 means unlimited", () => {
  it("gives a member in no group the club's own limit", () => {
    expect(capFor([], "max_slots_per_day", 4)).toBe(4);
  });

  it("inherits the club's limit for a group that overrides nothing", () => {
    expect(capFor([groupFixture()], "max_slots_per_day", 4)).toBe(4);
  });

  it("takes the lower of a group's override and the club's", () => {
    const strict = groupFixture({ id: "a", caps: { max_slots_per_day: 2 } });
    expect(capFor([strict], "max_slots_per_day", 4)).toBe(2);
  });

  /**
   * <b>The trap D2 calls out by name.</b> A naive `min` would make one unlimited group forbid
   * everything, because `0` is unlimited everywhere in this codebase and `Math.min(0, 4)` is
   * `0` read as none.
   */
  it("skips a zero, because a zero is unlimited and not a ban", () => {
    const unlimited = groupFixture({ id: "a", caps: { max_slots_per_day: 0 } });
    const capped = groupFixture({ id: "b", caps: { max_slots_per_day: 6 } });
    // The club itself unlimited, so the group's 6 is the only bound in the fold and the
    // unlimited group has to drop out of it rather than win it.
    expect(capFor([unlimited, capped], "max_slots_per_day", 0)).toBe(6);
    expect(capFor([unlimited], "max_slots_per_day", 4)).toBe(4);
    expect(capFor([unlimited], "max_slots_per_day", 0)).toBe(UNLIMITED);
  });

  /**
   * <b>Ruling 3 wins over D2 §4.2's formula here, and the difference is reachable.</b> D2
   * writes `min over g of (g.cap ?? tenant)`, which uses the club's value only where a group
   * inherits — so a group override of 8 under a club limit of 4 would RAISE the member to 8.
   * Ruling 3 says a group may lower either cap and never raise one, so the club's own value
   * stays in the fold and the answer is 4. D3 §6.3's example sentence is written the other way
   * round and is wrong for the same reason; `capOverrideIsInert` is what the editor says so
   * with.
   */
  it("lets a group LOWER the club's limit and never raise it above the club's", () => {
    const loose = groupFixture({ id: "a", caps: { max_slots_per_day: 8 } });
    expect(capFor([loose], "max_slots_per_day", 4)).toBe(4);
    expect(capOverrideIsInert(8, 4)).toBe(true);
    expect(capOverrideIsInert(2, 4)).toBe(false);
    // A club with no limit of its own: any override bites, including a large one.
    expect(capOverrideIsInert(8, UNLIMITED)).toBe(false);
    expect(capFor([loose], "max_slots_per_day", UNLIMITED)).toBe(8);
    // An override of "unlimited" under a club limit cannot lift it either.
    expect(capOverrideIsInert(UNLIMITED, 4)).toBe(true);
  });

  it("resolves the two caps against each other, in slots, and the stricter wins", () => {
    // 60 minutes at 15 to a slice is 4 slots; a slot cap of 6 is looser, so 4 stands.
    expect(ceilingSlots(6, 60, 15)).toBe(4);
    // At 30 minutes a slice the same hour is 2 slots. Vary the fixture, not just the code.
    expect(ceilingSlots(6, 60, 30)).toBe(2);
    expect(ceilingSlots(2, 60, 15)).toBe(2);
    expect(ceilingSlots(UNLIMITED, UNLIMITED, 15)).toBe(UNLIMITED);
    expect(ceilingSlots(UNLIMITED, 60, 15)).toBe(4);
    expect(ceilingSlots(4, UNLIMITED, 15)).toBe(4);
  });
});

describe("one day, resolved — what the page actually renders from", () => {
  const club = SETTINGS_FIXTURE;

  it("answers the club's own everything for a member in no group", () => {
    const day = resolveDay([], "tue", { settings: club, courtPrice: 8, slotCap: 4, minuteCap: 60, advanceDays: 14 });
    expect(day.allowed).toEqual([{ start: 360, end: 1320 }]);
    expect(day.slicePrice).toBe(8);
    expect(day.ceilingSlots).toBe(4);
    expect(day.emptyBecause).toBeNull();
  });

  it("intersects, maximises and minimises all at once for a member in two groups", () => {
    const offpeak = restrictedGroupFixture({
      id: "a", name: "Off-peak", caps: { max_slots_per_day: 2 },
      windows: weekdayWindows(["tue"], "06:00", "16:00"),
    });
    const coaching = groupFixture({
      id: "b", name: "Coaching squad",
      pricing: { mode: "flat_per_slice", flat_slice_price_credits: 12 },
      windows: [windowFixture("tue", "10:00", "20:00")],
    });
    const day = resolveDay([offpeak, coaching], "tue", {
      settings: club, courtPrice: 8, slotCap: 4, minuteCap: 60, advanceDays: 14,
    });
    expect(day.allowed).toEqual([{ start: 600, end: 960 }]);
    expect(day.slicePrice).toBe(12);
    expect(day.maxSlotsPerDay).toBe(2);
    expect(day.ceilingSlots).toBe(2);
  });

  it("carries the empty intersection out as names, not as an empty list of windows", () => {
    const early = groupFixture({ id: "a", name: "League members", windows: [windowFixture("tue", "06:00", "09:00")] });
    const late = groupFixture({ id: "b", name: "Non-league members", windows: [windowFixture("tue", "17:00", "21:00")] });
    const day = resolveDay([early, late], "tue", {
      settings: club, courtPrice: 8, slotCap: 4, minuteCap: 60, advanceDays: 14,
    });
    expect(day.allowed).toEqual([]);
    expect(day.emptyBecause).toEqual(["League members", "Non-league members"]);
  });

  /**
   * Vary the fixture, not just the code: a club west of UTC and a club that keeps DST. Nothing
   * in this module touches an instant — a window is a wall-clock face in the club's own day —
   * and that is exactly the property worth pinning, because the moment one of these numbers is
   * turned into a `Date` the answer moves twice a year.
   */
  it("answers the same for a DST club and a club west of UTC, because no instant is involved", () => {
    const chicago = { ...club, timezone: "America/Chicago" };
    const london = { ...club, timezone: "Europe/London" };
    const group = restrictedGroupFixture({ windows: weekdayWindows(["tue"], "06:00", "16:00") });
    const options = { courtPrice: 8, slotCap: 4, minuteCap: 60, advanceDays: 14 };
    const here = resolveDay([group], "tue", { settings: club, ...options });
    expect(resolveDay([group], "tue", { settings: chicago, ...options }).allowed).toEqual(here.allowed);
    expect(resolveDay([group], "tue", { settings: london, ...options }).allowed).toEqual(here.allowed);
  });
});
