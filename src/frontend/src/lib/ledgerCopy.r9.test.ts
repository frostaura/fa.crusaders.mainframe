import { describe, expect, it } from "vitest";
import { ledgerCategory, type LedgerRowWithActor } from "./ledgerCopy";
import type { LedgerRow } from "./api";

const row = (over: Partial<LedgerRowWithActor> = {}): LedgerRowWithActor => ({
  id: "r1", at: "2026-10-03T10:26:00Z", from: "Uma Nineui", to: "Piet Ninepartner", amountMinutes: 15, signedAmountMinutes: 15,
  type: "ShareTransfer", comment: "", subjectUserId: "u-piet", subjectName: "Piet Ninepartner", actorUserId: "u-uma",
  actorName: "Uma Nineui", relatedBookingId: "b1", ...over,
} as LedgerRowWithActor);

/**
 * R9 J9-7: the club's book showed a share as two rows reading "Uma Nineui → Piet Ninepartner ·
 * Share of a split booking", +15 and −15 — the same words, and nothing saying which wallet each
 * row is. Each leg now says whose wallet it moved.
 */
describe("J9-7 — a share's two legs say whose wallet each is", () => {
  it("the leg into the organiser's wallet and the leg out of the partner's", () => {
    expect(ledgerCategory(row())).toBe("Share of a split booking, into Piet Ninepartner's wallet");
    expect(ledgerCategory(row({ signedAmountMinutes: -15, subjectUserId: "u-uma", subjectName: "Uma Nineui" })))
      .toBe("Share of a split booking, out of Uma Nineui's wallet");
  });

  it("every other type keeps its filter label", () => {
    expect(ledgerCategory(row({ type: "BookingCharge", signedAmountMinutes: -15 }) as LedgerRow)).toBe("Booking charge");
  });
});

/**
 * R9 J9-3: a package the desk gave at no charge read "Package sold at the desk". Where the row says
 * what rand was taken (`zar_paid`), a gift says so.
 */
describe("J9-3 — a desk package given at no charge is not \"sold\"", () => {
  it("names a R0 desk package as given, and a paid one as sold", () => {
    expect(ledgerCategory(row({ type: "AdminTopUp", signedAmountMinutes: 60, zar_paid: 0 }))).toBe("Package given at the desk, at no charge");
    expect(ledgerCategory(row({ type: "AdminTopUp", signedAmountMinutes: 60, zar_paid: 108 }))).toBe("Package sold at the desk");
    // The server's code says it outright (933efada), whatever the rand.
    expect(ledgerCategory(row({ type: "AdminTopUp", signedAmountMinutes: 60, zar_paid: null, reason_code: "package_free" }))).toBe("Package given at the desk, at no charge");
  });
});
