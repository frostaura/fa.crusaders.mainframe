import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";
import {
  ADMIN_SELF_SHORT_TEXT, MEMBER_SHORT_TEXT, cancellationOutcome, describeBookingError,
} from "./bookingErrors";

afterEach(resetClubCurrencySymbol);

const refusal = (code: string) => new ApiError(409, { error: code });

/**
 * The booking journey's refusals, under the owner's ruling.
 *
 * <p>
 * <b>"Not enough credits" is a unit noun standing where an amount belongs.</b> Every one of
 * these sentences named the wallet's contents by the unit they used to be counted in; with the
 * unit gone, the honest subject is the WALLET, which is the thing the member tops up and the
 * thing a desk account has none of. That keeps each sentence addressed to the person who can
 * act on it — the distinction {@link MEMBER_SHORT_TEXT} and {@link ADMIN_SELF_SHORT_TEXT}
 * exist for.
 * </p>
 */
describe("what a refused booking says about money", () => {
  it("sends a short member to their wallet without naming a unit", () => {
    expect(describeBookingError(refusal("insufficient_balance"), "fallback"))
      .toBe("Not enough in your wallet — top up and try again.");
  });

  it("says a 5xx took nothing, without naming what it did not take", () => {
    const down = describeBookingError(new ApiError(503, {}), "fallback");
    expect(down).toContain("Nothing was booked and nothing was taken from your wallet");
    expect(down).not.toMatch(/credits?/i);
  });

  it("keeps the desk's version addressed to the wallet that is actually short", () => {
    // One error code, two audiences. "Top up your wallet" is right for a member and wrong for
    // a desk account, whose balance is permanently zero because it never plays.
    expect(MEMBER_SHORT_TEXT).toContain("That member doesn't have enough in their wallet");
    expect(ADMIN_SELF_SHORT_TEXT).toContain("You don't have enough in your wallet");
    expect(ADMIN_SELF_SHORT_TEXT).toContain("another member's wallet, not your own");
  });

  it("leaves no 'credit' or 'credits' in any refusal the member can reach", () => {
    const codes = [
      "past_time", "crosses_midnight", "too_far_ahead", "slot_taken", "insufficient_balance",
      "court_not_found", "duplicate_request", "already_started", "booking_not_found",
      "block_not_found", "member_suspended", "member_not_active", "waive_reason_required",
    ];
    for (const code of codes) {
      const said = describeBookingError(refusal(code), "fallback");
      expect(said).not.toMatch(/credits?\b/i);
      expect(said).not.toMatch(/\bcr\b/);
    }
    for (const text of [MEMBER_SHORT_TEXT, ADMIN_SELF_SHORT_TEXT]) {
      expect(text).not.toMatch(/credits?\b/i);
    }
  });
});

/**
 * The message after a cancellation. It replaced "Booking cancelled — refund pending.", which
 * was shown identically whether the whole price came back, part of it came back, or nothing
 * did — and the member had no other way to find out which.
 */
describe("what a cancellation says actually moved", () => {
  it("states the net refund and the penalty separately, in the club's money", () => {
    expect(cancellationOutcome(50, 15))
      .toBe("Booking cancelled. R35.00 back to your wallet, R15.00 kept as the late-cancellation penalty.");
  });

  it("states a free cancellation as one plain figure", () => {
    expect(cancellationOutcome(50, 0)).toBe("Booking cancelled. R50.00 back to your wallet.");
  });

  it("names whose wallet moved when an admin cancelled on somebody else's behalf", () => {
    // §7: refunds always go to the booking's player, never the acting admin. The sentence used
    // to speak in the first person about another person's money, with the member never named.
    expect(cancellationOutcome(50, 0, "Priya"))
      .toBe("Booking cancelled. R50.00 back to Priya's wallet.");
    expect(cancellationOutcome(50, 15, "Priya"))
      .toBe("Booking cancelled. R35.00 back to Priya's wallet, R15.00 kept as the late-cancellation penalty.");
  });

  it("says nothing came back once the lights had been on, and does not invent a figure", () => {
    expect(cancellationOutcome(0, 0))
      .toBe("Booking cancelled. Nothing was refunded — the lights had already been on.");
    expect(cancellationOutcome(0, 0, "Priya"))
      .toContain("Priya had already checked in");
  });

  it("follows the club's own symbol on both figures", () => {
    setClubCurrencySymbol("CHF");
    expect(cancellationOutcome(50, 15))
      .toBe("Booking cancelled. CHF35.00 back to your wallet, CHF15.00 kept as the late-cancellation penalty.");
  });

  it("behaves exactly as the default when the club has said nothing usable", () => {
    setClubCurrencySymbol(42);
    const absent = cancellationOutcome(50, 0);
    resetClubCurrencySymbol();
    expect(absent).toBe(cancellationOutcome(50, 0));
  });

  it("carries no unit noun in any arm", () => {
    for (const args of [[50, 15], [50, 0], [0, 0]] as const) {
      for (const who of [null, "Priya"]) {
        const said = cancellationOutcome(args[0], args[1], who);
        expect(said).not.toMatch(/credits?\b/i);
        expect(said).not.toMatch(/\bcr\b/);
      }
    }
  });
});
