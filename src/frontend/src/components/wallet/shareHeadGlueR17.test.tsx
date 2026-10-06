import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { LedgerRow } from "@/lib/api";
import { renderPage, stubFetch } from "@/test/harness";
import { LedgerTable } from "../LedgerTable";
import { shareBookingsFrom } from "./useShareBookings";

/**
 * R17 (CI class, FE17s's sweep) — a share group's head paints its sentence inside a span, so the
 * Button-style glue never reached it: "15 / minutes" and "9 / Oct" could split at 200 % text. The
 * paint keeps each figure with its unit; the name a reader hears is the plain sentence and its count.
 */

const ME = "44444444-4444-4444-4444-444444444444";
const OWEN = "55555555-5555-5555-5555-555555555555";

afterEach(() => { vi.unstubAllGlobals(); });

const row: LedgerRow = {
  id: "s1", at: "2026-10-01T10:00:00Z", from: "Mia Partner", to: "Owen Organiser", amountMinutes: 15, signedAmountMinutes: -15,
  type: "ShareTransfer", comment: "Share of a split booking", subjectUserId: ME, subjectName: "Mia Partner",
  actorUserId: ME, actorName: "Mia Partner", relatedBookingId: "b1", counterparty_name: "Owen Organiser",
};

const booking = shareBookingsFrom({ b1: {
  booking_id: "b1", court_name: "Court 1", starts_at: "2026-10-08T06:00:00Z",
  organiser: { user_id: OWEN, name: "Owen Organiser", photo_url: null }, partners: [{ user_id: ME, name: "Mia Partner", paid_minutes: 15 }],
} });

describe("a share group's head keeps figures whole (R17)", () => {
  it("paints no breakable space between a figure and its unit; the name stays plain", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row]} label="Wallet ledger" groupShares shareBookings={booking} />);
    await screen.findAllByText(/Court 1/);
    const toggle = document.querySelector<HTMLElement>("[data-share-toggle]")!;
    const painted = toggle.textContent ?? "";
    expect(painted).toMatch(/\d/);
    expect(painted).not.toMatch(/\d (?=\p{L})/u);
    expect(toggle.getAttribute("aria-label") ?? "").toMatch(/\d \p{L}/u);
    expect(toggle.getAttribute("aria-label")).not.toMatch(/\u00a0/);
  });
});
