import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { LedgerRow } from "@/lib/api";
import { SHARE_LEDGER_COPY } from "@/lib/walletCopy";
import { renderPage, stubFetch } from "@/test/harness";
import { LedgerTable } from "../LedgerTable";
import { shareBookingsFrom } from "./useShareBookings";

/**
 * R14 E14-7 — a member taken off a game read "Your share of a split booking": the summary is null
 * by design (no link), and the wallet read now carries `share_places` (court + start) for it.
 */

const ME = "44444444-4444-4444-4444-444444444444";
const OLIVIA = "77777777-7777-7777-7777-777777777777";

function row(id: string, signed: number, at = "2030-10-05T11:03:00Z"): LedgerRow {
  return {
    id, at, from: signed < 0 ? "Sam Partner" : "Olivia Organiser", to: signed < 0 ? "Olivia Organiser" : "Sam Partner",
    amountMinutes: Math.abs(signed), signedAmountMinutes: signed, type: "ShareTransfer", comment: "Share of a split booking",
    subjectUserId: ME, subjectName: "Sam Partner", actorUserId: OLIVIA, actorName: "Olivia Organiser", relatedBookingId: "b1",
  };
}

const viewLinks = () => screen.queryAllByRole("link", { name: new RegExp(`^${SHARE_LEDGER_COPY.viewBooking}`) });
const PLACES = { b1: { court_name: "Court 1", starts_at: "2030-10-08T16:00:00Z" } };

afterEach(() => { vi.unstubAllGlobals(); });

describe("R14 E14-7 — the share line of a game the member is off names its court and day", () => {
  it.each([
    ["paid and returned", [row("s1", -7), row("s2", 7, "2030-10-06T09:00:00Z")], /^Your share · Court 1 · Tue 8 Oct — paid and returned/],
    ["paid only", [row("s1", -7)], /^Your share · Court 1 · Tue 8 Oct/],
  ])("%s: court and day, still no link", async (_name, rows, name) => {
    stubFetch([]);
    renderPage(<LedgerTable rows={rows} label="Wallet ledger" groupShares shareBookings={shareBookingsFrom({ b1: null }, PLACES)} />);
    expect(await screen.findByRole("button", { name })).toBeInTheDocument();
    expect(viewLinks()).toHaveLength(0);
  });

  it("without share_places (an older API) it says 'a split booking', as before", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1", -7)]} label="Wallet ledger" groupShares shareBookings={shareBookingsFrom({ b1: null })} />);
    expect(await screen.findByRole("button", { name: /^Your share of a split booking/ })).toBeInTheDocument();
    expect(viewLinks()).toHaveLength(0);
  });
});
