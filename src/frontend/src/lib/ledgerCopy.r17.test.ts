import { describe, expect, it } from "vitest";
import { LEDGER_CATEGORY, ledgerCategory, type LedgerRowWithActor } from "./ledgerCopy";

/**
 * R17 E17-5 — Transactions labelled a returned no-show penalty (+4, Club treasury → member) as
 * "No-show penalty", the same words as the −4 it undid. A penalty row's sign says which it was:
 * money INTO the member is a penalty returned. Varied: both penalty types, both signs, and a
 * subject-less row.
 */
const row = (over: Partial<LedgerRowWithActor>): LedgerRowWithActor => ({
  id: "r1", at: "2026-10-05T23:38:27Z", from: "Club treasury", to: "Orla Organiser", amountMinutes: 4, signedAmountMinutes: 4,
  type: "NoShowPenalty", comment: "No-show penalty reversed — attendance recorded after the sweep", subjectUserId: "u-orla",
  subjectName: "Orla Organiser", actorUserId: "", actorName: "", relatedBookingId: "b1", ...over,
} as LedgerRowWithActor);

describe("R17 E17-5 — a penalty row says whether it was taken or given back", () => {
  it.each([
    ["NoShowPenalty", 4, LEDGER_CATEGORY.noShowPenaltyReturned],
    ["NoShowPenalty", -4, "No-show penalty"],
    ["LateCancellationPenalty", 9, LEDGER_CATEGORY.latePenaltyReturned],
    ["LateCancellationPenalty", -9, "Late-cancellation penalty"],
  ] as const)("%s %i", (type, signed, label) => {
    expect(ledgerCategory(row({ type, signedAmountMinutes: signed, amountMinutes: Math.abs(signed) }))).toBe(label);
  });

  it("a returned penalty is never called just a penalty, with or without a subject", () => {
    expect(ledgerCategory(row({ subjectName: null as unknown as string }))).toBe(LEDGER_CATEGORY.noShowPenaltyReturned);
    expect(LEDGER_CATEGORY.noShowPenaltyReturned).toMatch(/returned/);
  });
});
