import { describe, expect, it } from "vitest";
import { BOOKING_FOR } from "./bookingsCopy";

/**
 * R12 J12-4 — the book-for-member bar read "can spend minus 12 minutes": a debt said as something
 * to spend. Spendable is never below nothing; the bar says 0 and how far under zero (the wallet
 * card's rule, `walletCopy.spendableLine`).
 */
describe("R12 J12-4 — BOOKING_FOR.canSpend", () => {
  it("below zero: can spend 0, and by how much it is under", () => {
    expect(BOOKING_FOR.canSpend(-12)).toBe("can spend 0 minutes — 12 minutes below zero");
    expect(BOOKING_FOR.canSpend(-90)).not.toMatch(/minus|−/);
  });

  it("zero and above unchanged", () => {
    expect(BOOKING_FOR.canSpend(0)).toBe("can spend 0 minutes");
    expect(BOOKING_FOR.canSpend(125)).toBe("can spend 2 hours 5 minutes");
  });
});
