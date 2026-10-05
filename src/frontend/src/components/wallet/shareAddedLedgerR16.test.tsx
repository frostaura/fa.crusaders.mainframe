import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { LedgerRow } from "@/lib/api";
import { renderPage, stubFetch } from "@/test/harness";
import { LedgerTable } from "../LedgerTable";
import { shareBookingsFrom } from "./useShareBookings";

/** R16 J16-2 — the wallet's own line for a share that came back because a player was added. */

const ME = "44444444-4444-4444-4444-444444444444";
const OWEN = "55555555-5555-5555-5555-555555555555";

afterEach(() => { vi.unstubAllGlobals(); });

function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    id: "s1", at: "2026-10-01T10:00:00Z", from: "Owen Organiser", to: "Mia Partner", amountMinutes: 5, signedAmountMinutes: 5,
    type: "ShareTransfer", comment: "Share refunded", subjectUserId: ME, subjectName: "Mia Partner",
    actorUserId: OWEN, actorName: "Owen Organiser", relatedBookingId: "b1", counterparty_name: "Owen Organiser", ...over,
  };
}

const booking = shareBookingsFrom({ b1: {
  booking_id: "b1", court_name: "Court 1", starts_at: "2026-10-08T06:00:00Z",
  organiser: { user_id: OWEN, name: "Owen Organiser", photo_url: null }, partners: [{ user_id: ME, name: "Mia Partner", paid_minutes: 10 }],
} });

describe("R16 J16-2 — the ledger line", () => {
  it.each([
    ["the organiser added", { share_cause: "player_added", actor_name: "Owen Organiser" }, /came back — Owen added a player, so the split went down$/],
    ["the club added", { share_cause: "player_added", actor_name: null }, /came back — the club added a player, so the split went down$/],
    ["an older API (no cause)", {}, /^5 minutes of your share of Court 1 came back from Owen$/],
  ])("%s", async (_n, over, said) => {
    stubFetch([]);
    // The partner's wallet: 10 paid at accept, 5 back when the split went down.
    const paid = row({ id: "s0", at: "2026-09-30T10:00:00Z", from: "Mia Partner", to: "Owen Organiser", signedAmountMinutes: -10, amountMinutes: 10, actorUserId: ME, actorName: "Mia Partner", comment: "Share of a split booking" });
    renderPage(<LedgerTable rows={[row(over), paid]} label="Wallet ledger" groupShares shareBookings={booking} />);
    await screen.findAllByText(/Court 1/);
    fireEvent.click(document.querySelector<HTMLElement>("[data-share-toggle]")!);
    expect(screen.getAllByText(said).length).toBeGreaterThan(0);
  });
});
