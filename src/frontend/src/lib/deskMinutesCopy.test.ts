import { describe, expect, it } from "vitest";
import { REASON_MISSING, SELL_COPY } from "./deskMinutesCopy";

describe("R7 J7-6 — the sell sheet's payment step asks the question it shows", () => {
  it("a missing payment method is said as the payment, never as a reason", () => {
    expect(SELL_COPY.paymentMissing).toBe("Choose how it was paid.");
    expect(SELL_COPY.paymentMissing).not.toBe(REASON_MISSING.code);
    expect(SELL_COPY.paymentMissing).not.toMatch(/why/i);
  });
});

describe("R7 J7-10 — a package sold for nothing is not money the club took", () => {
  it("says a paid sale counts as revenue, in the club's money", () => {
    expect(SELL_COPY.revenueFor(495)).toMatch(/^R\s?495\.00 counts as money the club took/);
  });

  it("says a R0.00 sale adds nothing to revenue, and never calls it money taken", () => {
    const line = SELL_COPY.revenueFor(0);
    expect(line).not.toMatch(/counts as money/);
    expect(line).not.toMatch(/R\s?0\.00/);
    expect(line).toMatch(/revenue/);
  });

  it("asks to give a free package, rather than to sell it for R0.00", () => {
    expect(SELL_COPY.confirmFor("Thandi", "Welcome hour", 0)).toBe(
      "Give Welcome hour to Thandi at no charge? This goes on the ledger and cannot be deleted.",
    );
    expect(SELL_COPY.confirmFor("Thandi", "Five hours", 495)).toMatch(/^Sell Five hours to Thandi for R\s?495\.00\?/);
  });

  it("has a note to stand where the payment questions would be", () => {
    expect(SELL_COPY.freeNote).toMatch(/nothing to pay/i);
    expect(SELL_COPY.freeNote).not.toMatch(/cash/i);
  });
});
