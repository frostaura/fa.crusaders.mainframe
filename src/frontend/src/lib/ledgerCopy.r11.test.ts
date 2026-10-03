import { describe, expect, it } from "vitest";
import { ledgerCategory, LEDGER_CATEGORY, type LedgerRowWithActor } from "./ledgerCopy";

const row = (over: Partial<LedgerRowWithActor> = {}): LedgerRowWithActor => ({
  id: "r1", at: "2026-10-03T10:26:00Z", from: "Ben Payer", to: "Club treasury", amountMinutes: 30, signedAmountMinutes: -30,
  type: "BookingCharge", comment: "Booking charge", subjectUserId: "u-ben", subjectName: "Ben Payer", actorUserId: "",
  actorName: "", relatedBookingId: "b1", ...over,
} as LedgerRowWithActor);

/**
 * R11 E11-5: the payer's leg of a pay-for at the court (`BookingService`, stream `pay_for_charge`,
 * stored reason "Paid at court on behalf of another member — …") read plain "Booking charge" on
 * Transactions, beside its refund leg's "Pay-for refund — another member paid at the court". It
 * names itself in the same family; an ordinary charge keeps its plain label.
 */
describe("E11-5 — the payer's pay-for charge says what it was", () => {
  it("names the pay-for charge from its stored reason", () => {
    expect(ledgerCategory(row({ comment: "Paid at court on behalf of another member — Court 1 · Thu 1 Oct 18:00" })))
      .toBe(LEDGER_CATEGORY.payForCharge);
    expect(LEDGER_CATEGORY.payForCharge).toBe("Pay-for charge — paid at the court for another member");
  });

  it("leaves an ordinary booking charge as it was", () => {
    expect(ledgerCategory(row())).toBe("Booking charge");
  });
});
