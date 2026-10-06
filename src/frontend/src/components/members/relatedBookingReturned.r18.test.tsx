import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { endpoints, type LedgerRow } from "@/lib/api";
import { LEDGER_CATEGORY } from "@/lib/ledgerCopy";
import { RelatedBookingField } from "./RelatedBookingField";

/**
 * R18 E18-9 — the Adjust dialog's booking picker named a RETURNED penalty (a penalty row running
 * into the member) "No-show penalty", the word for the penalty itself. It now says what the ledger
 * page's Category column and the member's Transactions say: "… penalty returned".
 */

afterEach(() => vi.restoreAllMocks());

const MEMBER = "11111111-1111-4111-8111-111111111111";
const BOOKING = "bbbbbbbb-0000-4000-8000-000000000001";

function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    id: "l1", at: "2026-10-01T16:00:00Z", from: "Club", to: "Nomsa", amountMinutes: 15, signedAmountMinutes: 15,
    type: "NoShowPenalty", comment: "", subjectUserId: MEMBER, subjectName: "Nomsa Khumalo", actorUserId: MEMBER,
    actorName: "System", relatedBookingId: BOOKING, ...over,
  };
}

async function shown(rows: LedgerRow[]): Promise<string> {
  vi.spyOn(endpoints, "adminLedger").mockResolvedValue(rows);
  render(<RelatedBookingField userId={MEMBER} value={BOOKING} error={null} onChange={() => undefined} />);
  const trigger = screen.getByRole("combobox");
  await waitFor(() => expect(trigger).toHaveTextContent(BOOKING.slice(0, 8)));
  return trigger.textContent ?? "";
}

describe("E18-9 — a returned penalty is named as returned in the booking picker", () => {
  it("a no-show penalty given back", async () => {
    const text = await shown([row({ type: "NoShowPenalty", signedAmountMinutes: 15 })]);
    expect(text).toContain(LEDGER_CATEGORY.noShowPenaltyReturned);
  });

  it("a late-cancellation penalty given back", async () => {
    const text = await shown([row({ type: "LateCancellationPenalty", signedAmountMinutes: 15 })]);
    expect(text).toContain(LEDGER_CATEGORY.latePenaltyReturned);
  });

  it("the penalty itself (out of the member) keeps its own name", async () => {
    const text = await shown([row({ type: "NoShowPenalty", signedAmountMinutes: -15, from: "Nomsa", to: "Club" })]);
    expect(text).toContain("No-show penalty");
    expect(text).not.toContain("returned");
  });
});
