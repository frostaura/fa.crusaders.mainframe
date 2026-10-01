import { describe, expect, it } from "vitest";
import type { ScheduleDay } from "./api";
import {
  bookedKey, freeCount, gridBookingOf, parseSelectionKey, selectionKey, toGridBookings, toSelectedSlots, withinRectangle,
} from "./gridSelection";

const at = (hh: number, mm = 0) => new Date(Date.UTC(2030, 8, 9, hh - 2, mm)).toISOString();

const DAY = {
  date: "2030-09-09", timezone: "Africa/Johannesburg", sliceMinutes: 15,
  dayStartMinute: 960, dayEndMinute: 1080, advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
  courts: [
    { id: "a", courtNumber: 1, name: "Court 1", slicePriceCredits: 50 },
    { id: "b", courtNumber: 2, name: "Court 2", slicePriceCredits: 40 },
  ],
  slots: [{
    courtId: "b", courtNumber: 2, startsAtUtc: at(17), endsAtUtc: at(17, 30), status: "booked",
    ownerUserId: "u", ownerFirstName: "Thandi", ownerPhotoUrl: "p.jpg", isMine: false,
    bookingId: "bk", blockLabel: null, checkedIn: null, amountChargedMinutes: null,
  }],
} as ScheduleDay;

describe("selection keys", () => {
  it("round-trips both kinds, and refuses what it did not write", () => {
    expect(parseSelectionKey(selectionKey("a", at(16)))).toEqual({ kind: "free", courtId: "a", startsAtUtc: at(16) });
    expect(parseSelectionKey(bookedKey("bk"))).toEqual({ kind: "booked", bookingId: "bk" });
    expect(parseSelectionKey("nonsense")).toBeNull();
    expect(freeCount([selectionKey("a", at(16)), bookedKey("bk")])).toBe(1);
  });

  it("measures a rectangle, not a reading-order run", () => {
    const a = { row: 0, col: 1 };
    const b = { row: 2, col: 1 };
    expect(withinRectangle(a, b, { row: 1, col: 1 })).toBe(true);
    expect(withinRectangle(a, b, { row: 1, col: 0 })).toBe(false);
  });
});

describe("toSelectedSlots — what a BookSheet is handed", () => {
  it("merges adjacent slices on one court into one booking, costing its playing minutes (P13 §1.1)", () => {
    const keys = [selectionKey("a", at(16, 15)), selectionKey("a", at(16)), selectionKey("b", at(16)), selectionKey("a", at(16, 30))];
    // The fixture's courts still carry the old per-court prices (50, 40): they must change nothing.
    expect(toSelectedSlots(keys, DAY)).toEqual([
      { courtId: "a", courtName: "Court 1", startsAt: at(16), sliceCount: 3, priceMinutes: 45 },
      { courtId: "b", courtName: "Court 2", startsAt: at(16), sliceCount: 1, priceMinutes: 15 },
    ]);
  });

  it("prices by the day's slice length — vary it, and the minutes follow", () => {
    const halfHours = { ...DAY, sliceMinutes: 30 } as ScheduleDay;
    const keys = [selectionKey("a", at(16)), selectionKey("a", at(16, 30))];
    expect(toSelectedSlots(keys, halfHours)).toEqual([
      { courtId: "a", courtName: "Court 1", startsAt: at(16), sliceCount: 2, priceMinutes: 60 },
    ]);
  });

  it("breaks a run at a gap", () => {
    const keys = [selectionKey("a", at(16)), selectionKey("a", at(16, 30))];
    expect(toSelectedSlots(keys, DAY).map((s) => s.sliceCount)).toEqual([1, 1]);
  });

  it("ignores bookings, and answers nothing without a day", () => {
    expect(toSelectedSlots([bookedKey("bk")], DAY)).toEqual([]);
    expect(toSelectedSlots([selectionKey("a", at(16))], null)).toEqual([]);
  });
});

describe("toGridBookings — what a CancelSheet is handed", () => {
  it("resolves a booking against the day, first name and photo only, in the club's clock", () => {
    const [b] = toGridBookings([bookedKey("bk"), bookedKey("gone"), selectionKey("a", at(16))], DAY);
    expect(b).toEqual(gridBookingOf(DAY.slots[0], DAY));
    expect(b).toMatchObject({
      bookingId: "bk", courtName: "Court 2", mine: false, memberFirstName: "Thandi", memberPhotoUrl: "p.jpg",
      timezone: "Africa/Johannesburg",
    });
    expect(b.whenLabel).toMatch(/17:00/);
    expect(toGridBookings([bookedKey("bk")], DAY)).toHaveLength(1);
  });
});
