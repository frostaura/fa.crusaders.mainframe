import { describe, expect, it } from "vitest";
import type { ScheduleDay } from "./api";
import { quotaBannerTitle } from "./gridCopy";
import { acceptedSlotsOn, ruleNotice } from "./gridExplain";
import { readViewerRules } from "./gridRules";

/**
 * R17 X17-2 — the daily cap counts SLOTS (the server sums each booking's slice count), so the
 * banner's "of them" must too: one 45-minute game said yes to on a 15-minute grid is three of
 * the member's slots, not one.
 */

const row = (role: "organiser" | "partner" | null, minutes: number, isMine = true) => ({
  courtId: "c1", courtNumber: 1, startsAtUtc: "2026-10-03T08:00:00Z",
  endsAtUtc: new Date(Date.parse("2026-10-03T08:00:00Z") + minutes * 60_000).toISOString(),
  status: "booked", ownerUserId: null, ownerFirstName: null, ownerPhotoUrl: null, isMine, role,
  bookingId: "b", blockLabel: null, checkedIn: false, amountChargedMinutes: minutes,
});

function day(slots: ReturnType<typeof row>[], sliceMinutes = 15, max = 4): ScheduleDay {
  return {
    date: "2026-10-03", timezone: "Africa/Johannesburg", sliceMinutes, dayStartMinute: 360, dayEndMinute: 1320,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: [], slots,
    rules: { clubDay: "2026-10-03", maxSlotsPerDay: max, bookedSlotsToday: max, remainingToday: 0 },
  } as unknown as ScheduleDay;
}

describe("the cap banner counts slots, not bookings (R17 X17-2)", () => {
  it("one 45-minute game said yes to on a 15-minute grid is 3 slots", () => {
    expect(acceptedSlotsOn(day([row("partner", 45), row("organiser", 15)]))).toBe(3);
  });

  it("two games said yes to — 30 and 15 minutes — are 3 slots; other people's and own bookings are not counted", () => {
    expect(acceptedSlotsOn(day([row("partner", 30), row("partner", 15), row("organiser", 30), row("partner", 30, false)]))).toBe(3);
  });

  it("a 45-minute slice grid counts a 90-minute game as 2", () => {
    expect(acceptedSlotsOn(day([row("partner", 90)], 45))).toBe(2);
  });

  it("a whole cap of 4 filled by one 60-minute game said yes to: the banner says so, never 'You've booked'", () => {
    const d = day([row("partner", 60)]);
    const notice = ruleNotice(readViewerRules(d), "2026-10-03", true, acceptedSlotsOn(d))!;
    expect(notice.title).toBe("Your 4 slots for Saturday are in games you said yes to.");
    expect(notice.title).not.toMatch(/You've booked/);
  });

  it("2 of 4 slots in one game said yes to are counted as 2", () => {
    expect(quotaBannerTitle(4, "2026-10-03", 2)).toBe("You've booked your 4 slots for Saturday — 2 of them are in games you said yes to.");
    expect(quotaBannerTitle(4, "2026-10-03", 1)).toBe("You've booked your 4 slots for Saturday — 1 of them is in a game you said yes to.");
  });
});
