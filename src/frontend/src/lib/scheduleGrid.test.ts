import { describe, expect, it } from "vitest";
import type { ScheduleDay, ScheduleSlot } from "./api";
import { buildTimeSlices, groupSlotsByCourt, isSlotHead, peakRestricted, slotAt } from "./scheduleGrid";
import { cancellationOutcome } from "./bookingErrors";

/**
 * F2 and F3 — the grid arithmetic, on its own.
 *
 * <p>
 * Both findings were arithmetic rather than rendering, so they are pinned here where a
 * failure names the maths instead of a DOM query. The grid used to index slots by their
 * exact start instant, so a booking painted its FIRST cell and no other: a 30-minute
 * booking read "Mine" at 19:00 and "Available" at 19:15, and tapping 19:15 returned 409
 * for ever. A walk-up bought at the box stamps `StartsAt = now`, which is almost never on
 * a slice boundary, so a lit court in active use painted NO cell at all and showed as
 * free to the member AND to the admin.
 * </p>
 */

const COURT = "11111111-1111-1111-1111-111111111111";
const OTHER_COURT = "22222222-2222-2222-2222-222222222222";

/** 2026-09-05 is the Saturday finder B ran; SAST is UTC+2 with no DST, so the maths is stable. */
function day(overrides: Partial<ScheduleDay> = {}, slots: ScheduleSlot[] = []): ScheduleDay {
  return {
    date: "2026-09-05",
    timezone: "Africa/Johannesburg",
    sliceMinutes: 15,
    dayStartMinute: 7 * 60,
    dayEndMinute: 20 * 60,
    advanceBookingDays: 14,
    penaltyPct: 30,
    penaltyWindowMinutes: 15,
    courts: [{ id: COURT, courtNumber: 1, name: "Court 1", slicePriceCredits: 50 }],
    slots,
    ...overrides,
  };
}

function slot(startsAtUtc: string, endsAtUtc: string, overrides: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    courtId: COURT,
    courtNumber: 1,
    startsAtUtc,
    endsAtUtc,
    status: "booked",
    ownerUserId: "44444444-4444-4444-4444-444444444444",
    ownerFirstName: "Naledi",
    ownerPhotoUrl: null,
    isMine: true,
    bookingId: "99999999-9999-9999-9999-999999999999",
    blockLabel: null,
    checkedIn: false,
    amountChargedMinutes: 50,
    ...overrides,
  };
}

/** The UTC instant of a local (SAST) wall-clock time on the fixture's day. */
const sast = (hh: number, mm = 0, ss = 0) =>
  new Date(Date.UTC(2026, 8, 5, hh - 2, mm, ss)).toISOString();

describe("slotAt — a booking occupies every cell it covers", () => {
  it("paints all four cells of an hour-long booking, not only the first", () => {
    // Finder B's exact case, scaled up: 19:00-20:00 SAST across four 15-minute cells.
    const booking = slot(sast(19), sast(20));
    const byCourt = groupSlotsByCourt(day({}, [booking]));

    for (const minute of [0, 15, 30, 45]) {
      const cell = Date.parse(sast(19, minute));
      expect(slotAt(byCourt, COURT, cell, 15), `19:${minute} should be occupied`).toBe(booking);
    }
    // …and nothing either side of it.
    expect(slotAt(byCourt, COURT, Date.parse(sast(18, 45)), 15)).toBeUndefined();
    expect(slotAt(byCourt, COURT, Date.parse(sast(20, 0)), 15)).toBeUndefined();
  });

  it("shows a walk-up that started mid-slice, which used to be invisible entirely", () => {
    // The box stamps StartsAt = now. 12:51:05 -> 13:21:05 is a real row from the finding:
    // relay B closed, 100.00 credits charged, and BOTH 13:00 and 13:15 read "Available"
    // for the member and for the admin, while the court was lit and in use.
    const walkUp = slot(sast(12, 51, 5), sast(13, 21, 5), { isMine: false, checkedIn: null, amountChargedMinutes: null });
    const byCourt = groupSlotsByCourt(day({}, [walkUp]));

    expect(slotAt(byCourt, COURT, Date.parse(sast(12, 45)), 15)).toBe(walkUp);
    expect(slotAt(byCourt, COURT, Date.parse(sast(13, 0)), 15)).toBe(walkUp);
    expect(slotAt(byCourt, COURT, Date.parse(sast(13, 15)), 15)).toBe(walkUp);
    expect(slotAt(byCourt, COURT, Date.parse(sast(13, 30)), 15)).toBeUndefined();
  });

  it("keeps courts apart", () => {
    const mine = slot(sast(19), sast(20));
    const theirs = slot(sast(19), sast(20), { courtId: OTHER_COURT, isMine: false });
    const byCourt = groupSlotsByCourt(day({}, [mine, theirs]));

    expect(slotAt(byCourt, COURT, Date.parse(sast(19)), 15)).toBe(mine);
    expect(slotAt(byCourt, OTHER_COURT, Date.parse(sast(19)), 15)).toBe(theirs);
  });

  it("treats an adjacent booking as adjacent, not overlapping", () => {
    // 19:00-19:15 and 19:15-19:30 are two bookings back to back. A half-open comparison
    // is what keeps the boundary cell belonging to exactly one of them.
    const first = slot(sast(19), sast(19, 15));
    const second = slot(sast(19, 15), sast(19, 30), { bookingId: "88888888-8888-8888-8888-888888888888" });
    const byCourt = groupSlotsByCourt(day({}, [first, second]));

    expect(slotAt(byCourt, COURT, Date.parse(sast(19)), 15)).toBe(first);
    expect(slotAt(byCourt, COURT, Date.parse(sast(19, 15)), 15)).toBe(second);
  });
});

describe("isSlotHead — one booking carries its label once", () => {
  it("is the cell the start falls inside, and only that one", () => {
    const booking = slot(sast(19), sast(20));
    expect(isSlotHead(booking, Date.parse(sast(19)), 15)).toBe(true);
    expect(isSlotHead(booking, Date.parse(sast(19, 15)), 15)).toBe(false);
    expect(isSlotHead(booking, Date.parse(sast(19, 45)), 15)).toBe(false);
  });

  it("puts a mid-slice walk-up's head in the cell containing its start", () => {
    const walkUp = slot(sast(12, 51, 5), sast(13, 21, 5));
    expect(isSlotHead(walkUp, Date.parse(sast(12, 45)), 15)).toBe(true);
    expect(isSlotHead(walkUp, Date.parse(sast(13, 0)), 15)).toBe(false);
  });

  it("lets the first row adopt a booking that began before the grid", () => {
    // A booking that started on the previous local day would otherwise have no head on
    // this grid at all, so it would render as a continuation nobody can act on.
    const overnight = slot(sast(-1), sast(1));
    expect(isSlotHead(overnight, Date.parse(sast(0)), 15, true)).toBe(true);
    expect(isSlotHead(overnight, Date.parse(sast(0)), 15, false)).toBe(false);
  });
});

describe("buildTimeSlices — the grid is drawn to the club's hours for that day", () => {
  it("starts at opening and stops at closing", () => {
    const rows = buildTimeSlices(day());
    expect(rows[0].label).toBe("07:00");
    expect(rows[rows.length - 1].label).toBe("19:45");
    // 21:45 on a Saturday — the slot finder B was sold and charged 50.00 credits for —
    // is not on the grid at all now that the day carries its own hours.
    expect(rows.some((r) => r.label === "21:45")).toBe(false);
  });

  it("marks rows outside the hours as closed rather than bookable", () => {
    // Hours 07:00-20:00 against a grid that a booking has forced wider (below): the
    // rows outside are rendered so the member can see the club is shut, and inert.
    const rows = buildTimeSlices(day({}, [slot(sast(3), sast(3, 15))]));
    const threeAm = rows.find((r) => r.label === "03:00");
    const nineAm = rows.find((r) => r.label === "09:00");
    expect(threeAm?.outOfHours).toBe(true);
    expect(nineAm?.outOfHours).toBe(false);
  });

  it("stretches to reach a booking that sits outside opening hours", () => {
    // The sharpest edge of the operating-hours finding: a member was sold 03:00 on a
    // Sunday through the API, the grid began at 06:00, and the booking they had paid for
    // appeared on NO screen in the product — so they could not see it, cancel it, or get
    // it back. Enforcement stops new ones; this stops the existing ones being invisible.
    const strayBooking = slot(sast(3), sast(3, 15));
    const rows = buildTimeSlices(day({}, [strayBooking]));

    expect(rows[0].label).toBe("03:00");
    expect(rows.some((r) => r.label === "19:45")).toBe(true);
  });

  it("honours a slice length other than fifteen minutes", () => {
    const rows = buildTimeSlices(day({ sliceMinutes: 30, dayStartMinute: 8 * 60, dayEndMinute: 10 * 60 }));
    expect(rows.map((r) => r.label)).toEqual(["08:00", "08:30", "09:00", "09:30"]);
  });
});

describe("cancellationOutcome — the message names what actually moved", () => {
  it("states the net refund and the penalty separately inside the window", () => {
    // The API posts refund and penalty as two ledger rows, gross and deduction. What the
    // member wants to read is what landed in their wallet, and what was kept.
    expect(cancellationOutcome(50, 15)).toBe(
      "Booking cancelled. 35 min back to your balance, 15 min kept as the late-cancellation penalty.");
  });

  it("states a free cancellation as a plain figure", () => {
    expect(cancellationOutcome(50, 0)).toBe("Booking cancelled. 50 min back to your balance.");
  });

  it("says nothing came back when the lights had been on", () => {
    // This is the case the old copy lied about outright: "Booking cancelled — refund
    // pending." while the member lost the entire price and the court stayed lit.
    expect(cancellationOutcome(0, 0)).toBe(
      "Booking cancelled. Nothing was refunded — the lights had already been on.");
  });
});

/**
 * N-F6 — which cells the peak-hours rule would refuse THIS viewer.
 *
 * <p>
 * Blueprint A.12 reserves the peak window for league and senior members until
 * `peak_advance_hours_for_regular` before a slot starts, and the rule lived only in
 * `BookingService`. A Regular member's grid therefore drew 44 cells a day as green, clickable
 * "Available" — same colour, same cursor, same "Book Court 2 at 17:00 for 50 min" label as a
 * slot they could actually have — and the refusal arrived only after they had read a price and
 * pressed Confirm.
 * </p>
 *
 * <p>
 * Pinned as arithmetic rather than as pixels, and against the boundaries
 * `CheckPeakHoursRule` actually uses: the window is `[start, end)` on the slot's START and the
 * allowance is a strict `hoursUntil > advance`, so a grid that disagreed at either edge would
 * hide a slot the API would sell — the failure this fix must not introduce.
 * </p>
 */
describe("peakRestricted — the peak window as one viewer sees it", () => {
  /** 16:00–19:00 local, a Regular member, an hour's grace. The Crusaders seed's own numbers. */
  const REGULAR = day({
    peakStartMinute: 16 * 60, peakEndMinute: 19 * 60,
    peakAdvanceHoursForRegular: 1, viewerMayBookPeak: false,
  });
  const NOW = Date.parse("2026-09-05T06:00:00Z");
  const hoursAway = (h: number) => NOW + h * 3_600_000;

  it("restricts a peak slot that is further away than the allowance", () => {
    expect(peakRestricted(REGULAR, 17 * 60, hoursAway(5), NOW)).toBe(true);
  });

  it("frees the same slot once the member is inside the allowance", () => {
    // A.12: "inside that window any class can book if free."
    expect(peakRestricted(REGULAR, 17 * 60, hoursAway(0.5), NOW)).toBe(false);
    // Exactly on the allowance is bookable, because the service's test is a strict `>`.
    expect(peakRestricted(REGULAR, 17 * 60, hoursAway(1), NOW)).toBe(false);
  });

  it("uses the same half-open window the booking service does", () => {
    // [16:00, 19:00). 15:45 and 19:00 are outside it; a client that closed the interval would
    // hide a slot the API would sell.
    expect(peakRestricted(REGULAR, 15 * 60 + 45, hoursAway(5), NOW)).toBe(false);
    expect(peakRestricted(REGULAR, 16 * 60, hoursAway(5), NOW)).toBe(true);
    expect(peakRestricted(REGULAR, 18 * 60 + 45, hoursAway(5), NOW)).toBe(true);
    expect(peakRestricted(REGULAR, 19 * 60, hoursAway(5), NOW)).toBe(false);
  });

  it("restricts nothing for a viewer the rule never refuses", () => {
    // A league/senior member, and an admin — A.6/A.11, "admin always bypasses".
    const league = { ...REGULAR, viewerMayBookPeak: true };
    expect(peakRestricted(league, 17 * 60, hoursAway(5), NOW)).toBe(false);
  });

  /**
   * The fixture, varied towards ABSENCE. Every field is optional on the wire, and each missing
   * one has to answer "not restricted": a grid that greyed cells out on an absent field would
   * refuse bookings the club would take, which is a worse defect than the one being fixed.
   */
  it("offers the slot when the payload says nothing about the rule", () => {
    expect(peakRestricted(day(), 17 * 60, hoursAway(5), NOW)).toBe(false);
    expect(peakRestricted({ ...REGULAR, viewerMayBookPeak: undefined }, 17 * 60, hoursAway(5), NOW)).toBe(false);
    // A club that runs no league nights: `peak_hours` is empty, so the window is null.
    expect(peakRestricted({ ...REGULAR, peakStartMinute: null, peakEndMinute: null }, 17 * 60, hoursAway(5), NOW)).toBe(false);
    // An advance allowance the payload omits reads as zero, not as "no rule": the window still
    // applies, which is the stricter half and matches a club that set it to 0.
    expect(peakRestricted({ ...REGULAR, peakAdvanceHoursForRegular: undefined }, 17 * 60, hoursAway(5), NOW)).toBe(true);
  });
});
