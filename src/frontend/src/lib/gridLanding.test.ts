import { describe, expect, it } from "vitest";
import type { ScheduleDay, ScheduleSlot } from "./api";
import { readViewerRules } from "./gridRules";
import { LAND_AT_END, landingRow, rowBookable } from "./gridLanding";
import { buildTimeSlices, groupSlotsByCourt } from "./scheduleGrid";

const COURTS = [{ id: "c1", courtNumber: 1, name: "Court 1" }, { id: "c2", courtNumber: 2, name: "Court 2" }];

function day(overrides: Partial<ScheduleDay> = {}): ScheduleDay {
  return {
    date: "2026-10-06", timezone: "UTC", sliceMinutes: 30, dayStartMinute: 8 * 60, dayEndMinute: 22 * 60,
    advanceBookingDays: 14, penaltyPct: 0, penaltyWindowMinutes: 0, courts: COURTS, slots: [], ...overrides,
  };
}

function taken(courtId: string, from: string, to: string): ScheduleSlot {
  return {
    courtId, courtNumber: 1, startsAtUtc: `2026-10-06T${from}:00Z`, endsAtUtc: `2026-10-06T${to}:00Z`, status: "Confirmed",
    ownerUserId: "x", ownerFirstName: "X", ownerPhotoUrl: null, isMine: false, bookingId: "b", blockLabel: null, checkedIn: null,
  } as ScheduleSlot;
}

const at = (hhmm: string) => Date.parse(`2026-10-06T${hhmm}:00Z`);

/** The board's own wiring: the past threshold is the start of the last row that has begun. */
function land(d: ScheduleDay, now: string, from = 0, rules = readViewerRules(d)) {
  const slices = buildTimeSlices(d);
  const nowMs = at(now);
  const started = slices.filter((t) => Date.parse(t.utc) <= nowMs);
  const pastThresholdMs = started.length ? Date.parse(started[started.length - 1].utc) : -Infinity;
  const bySlot = groupSlotsByCourt(d);
  const row = landingRow(slices, from, pastThresholdMs, nowMs, d.sliceMinutes,
    (i) => rowBookable(d, rules, bySlot, slices[i], pastThresholdMs, nowMs));
  return row === LAND_AT_END ? "end" : slices[row]?.label;
}

describe("landingRow — where the grid opens", () => {
  it("late in the day, opens on the first row that has not started", () => {
    expect(land(day(), "18:40")).toBe("19:00");
  });

  it("skips rows that have not started but are booked on every court", () => {
    const d = day({ slots: [taken("c1", "19:00", "20:00"), taken("c2", "19:00", "19:30")] });
    // 19:00 is full; 19:30 still has Court 2.
    expect(land(d, "18:40")).toBe("19:30");
  });

  it("a retired court's empty cells are not bookable", () => {
    const d = day({ courts: [{ ...COURTS[0], isActive: false }, COURTS[1]], slots: [taken("c2", "19:00", "20:30")] });
    expect(land(d, "18:40")).toBe("20:30");
  });

  it("skips rows outside the member's group hours", () => {
    const d = day({ rules: { allowedWindows: [{ start: "20:00", end: "22:00" }] } as ScheduleDay["rules"] });
    expect(land(d, "18:40")).toBe("20:00");
  });

  it("nothing left to book today: the now-line's row", () => {
    const d = day({ slots: [taken("c1", "18:00", "22:00"), taken("c2", "18:00", "22:00")] });
    expect(land(d, "18:40")).toBe("18:30");
  });

  it("a member at the daily cap lands on the now-line, not on the morning", () => {
    const d = day({ rules: { remainingToday: 0 } as ScheduleDay["rules"] });
    expect(land(d, "12:10")).toBe("12:00");
  });

  it("a day still to come opens at its first open row", () => {
    expect(land(day(), "06:00")).toBe("08:00");
  });

  it("a day still to come whose first rows are full opens on the first free one", () => {
    const d = day({ slots: [taken("c1", "08:00", "10:00"), taken("c2", "08:00", "09:00")] });
    expect(land(d, "06:00")).toBe("09:00");
  });

  it("a day wholly over keeps its foot", () => {
    expect(land(day(), "23:30")).toBe("end");
  });

  it("never lands on a row collapsed behind 'Earlier today'", () => {
    const d = day({ slots: [taken("c1", "08:00", "22:00"), taken("c2", "08:00", "22:00")] });
    // Every row is full and it is 18:40: the now row (index 21) is past the 20 collapsed rows.
    expect(land(d, "18:40", 20)).toBe("18:30");
  });
});
