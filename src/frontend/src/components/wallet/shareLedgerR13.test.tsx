import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { LedgerRow } from "@/lib/api";
import { SHARE_LEDGER_COPY } from "@/lib/walletCopy";
import { renderPage, stubFetch } from "@/test/harness";
import { LedgerTable } from "../LedgerTable";
import { shareBookingsFrom } from "./useShareBookings";

/**
 * R13 J13-3 (lane FC13) — a member the club took off a game (or who pulled out) kept a "View
 * booking" link on their share line that opened "Booking not found". The wallet read says so:
 * `share_bookings[id]` is null when this member can no longer read the booking. No link then; a
 * booking the club did not summarise (absent: an older API, or past the summary cap) keeps it.
 */

const ME = "44444444-4444-4444-4444-444444444444";
const OLIVIA = "77777777-7777-7777-7777-777777777777";

function row(id: string, signed: number, booking = "b1"): LedgerRow {
  return {
    id, at: "2026-10-05T11:03:00Z", from: signed < 0 ? "Sam Partner" : "Olivia Organiser", to: signed < 0 ? "Olivia Organiser" : "Sam Partner",
    amountMinutes: Math.abs(signed), signedAmountMinutes: signed, type: "ShareTransfer", comment: "Share of a split booking",
    subjectUserId: ME, subjectName: "Sam Partner", actorUserId: OLIVIA, actorName: "Olivia Organiser", relatedBookingId: booking,
  };
}

const viewLinks = () => screen.queryAllByRole("link", { name: new RegExp(`^${SHARE_LEDGER_COPY.viewBooking}`) });

afterEach(() => { vi.unstubAllGlobals(); });

describe("R13 J13-3 — no 'View booking' for a game the member is no longer on", () => {
  it("taken off (paid and returned, booking unreadable): the line, no link", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1", -7), row("s2", 7)]} label="Wallet ledger" groupShares shareBookings={shareBookingsFrom({ b1: null })} />);
    expect(await screen.findByRole("button", { name: /paid and returned, / })).toBeInTheDocument();
    expect(viewLinks()).toHaveLength(0);
  });

  it("one share line still on its game keeps its link beside one that is not", async () => {
    stubFetch([]);
    const onIt = {
      booking_id: "b2", court_name: "Court 4", starts_at: "2026-10-05T16:00:00Z",
      organiser: { user_id: OLIVIA, name: "Olivia Organiser", photo_url: null }, partners: [{ user_id: ME, name: "Sam Partner", paid_minutes: 7 }],
    };
    renderPage(<LedgerTable rows={[row("s1", -7), row("s3", -7, "b2")]} label="Wallet ledger" groupShares shareBookings={shareBookingsFrom({ b1: null, b2: onIt })} />);
    await screen.findByRole("button", { name: /^Your share · Court 4/ });
    const links = viewLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/bookings/b2");
  });

  it("a booking the club did not summarise (absent) keeps its link", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1", -7)]} label="Wallet ledger" groupShares shareBookings={shareBookingsFrom(undefined)} />);
    await screen.findByRole("button", { name: /^Your share of a split booking, / });
    expect(viewLinks()).toHaveLength(1);
  });
});
