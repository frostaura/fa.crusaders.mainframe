import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { describeBookingError } from "./bookingErrors";

/**
 * R8 J8-1 — a single booking refused 409 `per_day_slot_cap_exceeded` read "Couldn't make that
 * booking. Try again in a moment." — advice that can never work: trying again books nothing. The
 * refusal carries every figure the sentence needs (`BookingEndpoints`), and partner seats a member
 * said yes to count against the limit (the server's `BookingRules.HeldAsync`), which is why a grid
 * that said "2 of 4" could still be refused.
 */
const FALLBACK = "Couldn't make that booking. Try again in a moment.";
const refusal = (extra: Record<string, unknown> = {}) => new ApiError(409, {
  error: "per_day_slot_cap_exceeded", cap_slots: 4, booked_slots: 4, attempted_slots: 1, remaining_slots: 0,
  bound_by: "tenant", group_name: null, club_day: "2026-10-04", ...extra,
});

describe("per_day_slot_cap_exceeded", () => {
  it("says the limit with its numbers, that joined games count, and what to do — never 'try again'", () => {
    const text = describeBookingError(refusal(), FALLBACK);
    expect(text).toBe("You already have 4 of your 4 slots booked for that day — games you've said yes to count too. Cancel one, or pick another day.");
    expect(text).not.toMatch(/try again/i);
  });

  it("a run longer than what is left says how many more fit", () => {
    expect(describeBookingError(refusal({ booked_slots: 2, attempted_slots: 4, remaining_slots: 2 }), FALLBACK))
      .toBe("You can book 2 more slots that day — 2 of your 4 are booked, counting games you've said yes to. Pick fewer, or another day.");
  });

  it("one slot is a slot", () => {
    expect(describeBookingError(refusal({ cap_slots: 1, booked_slots: 1 }), FALLBACK))
      .toBe("You already have 1 of your 1 slot booked for that day — games you've said yes to count too. Cancel one, or pick another day.");
    expect(describeBookingError(refusal({ booked_slots: 3, attempted_slots: 2, remaining_slots: 1 }), FALLBACK))
      .toMatch(/^You can book 1 more slot that day/);
  });

  it("names the group whose limit it is", () => {
    expect(describeBookingError(refusal({ bound_by: "group", group_name: "Juniors" }), FALLBACK))
      .toMatch(/ The limit is the Juniors group's\.$/);
  });

  it("is about the member when the desk books for them", () => {
    expect(describeBookingError(refusal(), FALLBACK, { forName: "Naledi" }))
      .toBe("Naledi already has 4 of their 4 slots booked for that day — games they've said yes to count too. Cancel one, or pick another day.");
  });

  it("without figures still says the limit, not 'try again'", () => {
    expect(describeBookingError(new ApiError(409, { error: "per_day_slot_cap_exceeded" }), FALLBACK))
      .toBe("You've booked all your slots for that day — games you've said yes to count too. Cancel one, or pick another day.");
  });
});
