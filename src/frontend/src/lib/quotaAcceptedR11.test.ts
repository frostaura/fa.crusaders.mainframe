import { describe, expect, it } from "vitest";
import type { ScheduleDay } from "./api";
import { quotaBannerBody, quotaBannerTitle } from "./gridCopy";
import { acceptedSlotsOn, ruleNotice } from "./gridExplain";
import { readViewerRules } from "./gridRules";

/**
 * R11 E11-6 — a member whose four slots were all games they SAID YES TO (accepted invites) read
 * "You've booked your 4 slots for Saturday. Cancel one of them…" — he booked nothing and cannot
 * cancel somebody else's booking. The banner counts accepted games and words them.
 */

const slot = (role: "organiser" | "partner" | null, isMine = true) => ({
  courtId: "c1", courtNumber: 1, startsAtUtc: "2026-10-03T08:00:00Z", endsAtUtc: "2026-10-03T08:15:00Z",
  status: "booked", ownerUserId: null, ownerFirstName: null, ownerPhotoUrl: null, isMine, role,
  bookingId: "b", blockLabel: null, checkedIn: false, amountChargedMinutes: 15,
});

function day(slots: ReturnType<typeof slot>[]): ScheduleDay {
  return {
    date: "2026-10-03", timezone: "Africa/Johannesburg", sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: [], slots,
    rules: { clubDay: "2026-10-03", maxSlotsPerDay: 4, bookedSlotsToday: 4, remainingToday: 0 },
  } as unknown as ScheduleDay;
}

describe("R11 E11-6 — games said yes to, on the quota banner", () => {
  it("counts the member's accepted seats, not their own bookings or other people's", () => {
    expect(acceptedSlotsOn(day([slot("partner"), slot("partner"), slot("organiser"), slot(null), slot("partner", false)]))).toBe(2);
    expect(acceptedSlotsOn(null)).toBe(0);
  });

  it("all four were games said yes to: never 'You've booked' and never 'Cancel one of them'", () => {
    const d = day([slot("partner"), slot("partner"), slot("partner"), slot("partner")]);
    const notice = ruleNotice(readViewerRules(d), "2026-10-03", true, acceptedSlotsOn(d))!;
    expect(notice.title).toBe("Your 4 slots for Saturday are games you said yes to.");
    expect(notice.body).toBe("Games you said yes to count toward your daily limit of 4 slots, so everyone gets court time. Pick another day.");
    expect(`${notice.title} ${notice.body}`).not.toMatch(/You've booked|Cancel one/);
  });

  it("some were said yes to: cancel one of YOUR bookings, and the yes-games named", () => {
    expect(quotaBannerTitle(4, "2026-10-03", 1)).toBe("You've booked your 4 slots for Saturday — 1 of them is a game you said yes to.");
    expect(quotaBannerBody(4, 1)).toBe("Cancel one of your own bookings, or pick another day. Games you said yes to count toward your daily limit of 4 slots, so everyone gets court time.");
  });

  it("none were: the words are as before", () => {
    expect(quotaBannerTitle(4, "2026-10-03")).toBe("You've booked your 4 slots for Saturday.");
    expect(quotaBannerBody(4)).toBe("Cancel one of them, or pick another day. Your daily limit is 4 slots, so everyone gets court time.");
  });
});
