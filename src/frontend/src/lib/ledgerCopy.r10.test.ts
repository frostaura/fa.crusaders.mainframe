import { describe, expect, it } from "vitest";
import { ledgerCategory, LEDGER_CATEGORY, type LedgerRowWithActor } from "./ledgerCopy";
import { formatMoney } from "./utils";

const row = (over: Partial<LedgerRowWithActor> = {}): LedgerRowWithActor => ({
  id: "r1", at: "2026-10-03T10:26:00Z", from: "Club treasury", to: "Ava Organiser", amountMinutes: 60, signedAmountMinutes: 60,
  type: "CancellationRefund", comment: "Cancellation refund", subjectUserId: "u-ava", subjectName: "Ava Organiser", actorUserId: "",
  actorName: "", relatedBookingId: "b1", ...over,
} as LedgerRowWithActor);

/**
 * R10 E10-5: on Transactions an outage refund, its reversal (−15) and a pay-for refund all read
 * "Cancellation refund" — nothing had been cancelled. The row's type is shared; its stored reason
 * (the server's words, `LedgerEntry.Reason`) and its sign say which it was. The reasons below are
 * the server's own (NoShowWorker.RefundReason, BookingService.RefundReversalReason, the pay-for
 * reassignment, the displaced-tail refund and its reinstatement).
 */
describe("E10-5 — a refund row says which refund it was", () => {
  it.each([
    ["Court 2 was offline — booking refunded in full", 60, LEDGER_CATEGORY.outageRefund],
    ["Outage refund reversed — the member was checked in after all", -15, LEDGER_CATEGORY.outageRefundReversed],
    // The wording stored before R10 E10-6 (the member's "you") — same refund, same label.
    ["Outage refund reversed — you were checked in after all, net of the desk's own adjustment", -15, LEDGER_CATEGORY.outageRefundReversed],
    ["Payer changed at court — refunded, Court 1 · Thu 1 Oct 18:00", 60, LEDGER_CATEGORY.payForRefund],
    ["No-show — booking refunded", 60, LEDGER_CATEGORY.noShowRefund],
    ["No-show refund reversed — attendance recorded after the sweep", -60, LEDGER_CATEGORY.noShowRefundReversed],
    ["ResoldTailRefunded — refunded in full: the court was already in use by an earlier booking whose attendance arrived late", 60, LEDGER_CATEGORY.displacedRefund],
    ["Booking reinstated — the earlier court went dark before this slot", -60, LEDGER_CATEGORY.reinstated],
    ["Cancellation refund", 60, "Cancellation refund"],
  ])("%s (%i)", (comment, signed, label) => {
    expect(ledgerCategory(row({ comment, signedAmountMinutes: signed, amountMinutes: Math.abs(signed) }))).toBe(label);
  });

  it("a refund taken back for a reason this build does not know is still not called a cancellation refund", () => {
    expect(ledgerCategory(row({ comment: "Something new", signedAmountMinutes: -20, amountMinutes: 20 }))).toBe(LEDGER_CATEGORY.refundReversed);
  });

  it("every label is its own words", () => {
    expect(LEDGER_CATEGORY).toMatchObject({
      outageRefund: "Outage refund — the court's box was offline",
      outageRefundReversed: "Outage refund reversed — checked in after all",
      payForRefund: "Pay-for refund — another member paid at the court",
      noShowRefund: "No-show refund",
      noShowRefundReversed: "No-show refund reversed — attendance arrived late",
      displacedRefund: "Refund — the court was already in use",
      reinstated: "Refund taken back — booking reinstated",
      refundReversed: "Refund reversed",
    });
  });
});

/**
 * R10 J10-5: a desk sale's rand was nowhere on the club's book — Transactions' details and the
 * member's admin ledger said "Package sold at the desk" whatever was taken. The row's `zar_paid`
 * now rides in its category; a gift keeps "at no charge".
 */
describe("J10-5 — a desk sale says the rand the club took", () => {
  it("a paid sale names the rand received; a gift says no charge; an older server's row keeps the plain label", () => {
    expect(ledgerCategory(row({ type: "AdminTopUp", comment: "Receipt 7 — 1 hour", zar_paid: 96 }))).toBe(`Package sold at the desk, ${formatMoney(96)} received`);
    expect(ledgerCategory(row({ type: "AdminTopUp", comment: "Gift — 1 hour", zar_paid: 0 }))).toBe("Package given at the desk, at no charge");
    expect(ledgerCategory(row({ type: "AdminTopUp", comment: "Receipt 7 — 1 hour" }))).toBe("Package sold at the desk");
  });
});
