import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import type { LedgerRow } from "@/lib/api";
import { SHARE_LEDGER_COPY, shareGroupSentence, shareRowSentence } from "@/lib/walletCopy";
import { renderPage, stubFetch } from "@/test/harness";
import { LedgerTable } from "../LedgerTable";

/**
 * D11 — the member's own ledger: a booking's shares under one line that says what they came to,
 * opens to the rows it gathers, and links to the booking.
 */

const ME = "44444444-4444-4444-4444-444444444444";
const SAM = "55555555-5555-5555-5555-555555555555";
const ALEX = "66666666-6666-6666-6666-666666666666";

function row(id: string, over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id, at: "2026-09-30T10:00:00Z", from: "Club treasury", to: "Nomsa Khumalo",
    amountCredits: 25, signedAmountCredits: 25, type: "ShareTransfer", comment: "Share of a split booking",
    subjectUserId: ME, subjectName: "Nomsa Khumalo", actorUserId: SAM, actorName: "Sam Petersen",
    relatedBookingId: "b1", ...over,
  };
}

function detail(over: Record<string, unknown> = {}) {
  const seat = (userId: string, name: string, paid: number, kind = "member") => ({
    participant_id: `p-${userId}`, seat: 2, team: "A", kind, user_id: userId, name, photo_url: null, status: "accepted",
    share_credits: 25, weight: 1, consented_credits: paid, paid_credits: paid, target_credits: paid, unpaid_credits: 0,
    needs_consent: false, settled_outside: false, lapsed: false, checked_in_at: null, invited_at: null, responded_at: null,
  });
  return {
    booking_id: "b1", court_id: "c1", court_name: "Court 1",
    starts_at: "2026-09-30T16:00:00Z", ends_at: "2026-09-30T16:45:00Z", sold_ends_at: "2026-09-30T16:45:00Z",
    status: "booked", split_mode: "equal", viewer: { role: "organiser", participant_id: `p-${ME}` },
    organiser: { user_id: ME, name: "Nomsa Khumalo", photo_url: null },
    players: [seat(ME, "Nomsa Khumalo", 0, "organiser"), seat(SAM, "Sam Petersen", 25), seat(ALEX, "Alex Naidoo", 25)],
    money: { price_credits: 100, organiser_owed_credits: 100, shares_received_credits: 50, organiser_net_credits: 50, unpaid_credits: 0, share_deadline: "2026-10-02T16:45:00Z", is_split: true },
    attendance: { checked_in_at: null, players_checked_in: 0 },
    permissions: { can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false, can_withdraw: false, withdraw_closes_at: "2026-09-30T15:00:00Z" },
    ...over,
  };
}

const TOPUP = row("t1", { type: "TopUp", relatedBookingId: null, comment: "Wallet top-up", at: "2026-09-29T10:00:00Z", signedAmountCredits: 200, amountCredits: 200 });

afterEach(() => { vi.unstubAllGlobals(); });

describe("the wallet ledger's share lines", () => {
  it("gathers the organiser's shares under one line, with the court, the day and who paid", async () => {
    stubFetch([{ path: "/api/v1/bookings/b1", body: detail() }]);
    renderPage(<LedgerTable rows={[row("s1"), TOPUP, row("s2", { actorUserId: ALEX, actorName: "Alex Naidoo", at: "2026-09-30T11:00:00Z" })]} label="Wallet ledger" groupShares />);

    const expected = shareGroupSentence({ side: "organiser", net: 50, place: { courtName: "Court 1", startsAt: "2026-09-30T16:00:00Z" }, partners: 2 });
    expect(expected).toBe("Shares for Court 1 · Wed 30 Sep: +50.00 cr from 2 partners");
    const toggle = await screen.findByRole("button", { name: new RegExp(`^${escape(expected)}`) });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Closed: the gathered rows are in the DOM but hidden, and the top-up is its own row.
    const shareRows = document.querySelectorAll("[data-share-row]");
    expect(shareRows).toHaveLength(2);
    shareRows.forEach((tr) => expect(tr).not.toBeVisible());
    expect(toggle.getAttribute("aria-controls")!.split(" ")).toEqual([...shareRows].map((tr) => tr.id));
    expect(screen.getByText("Wallet top-up")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    shareRows.forEach((tr) => expect(tr).toBeVisible());
    // Newest first, as the ledger sorts: Alex's payment, then Sam's.
    expect(within(shareRows[0] as HTMLElement).getByText(/^Alex paid you 25\.00 cr for their share of Court 1/)).toBeInTheDocument();
    expect(within(shareRows[1] as HTMLElement).getByText(/^Sam paid you 25\.00 cr/)).toBeInTheDocument();

    const link = screen.getByRole("link", { name: new RegExp(`^${SHARE_LEDGER_COPY.viewBooking}`) });
    expect(link).toHaveAttribute("href", "/bookings/b1");
  });

  it("says the partner's side as their share, with what moved to whom", async () => {
    stubFetch([{ path: "/api/v1/bookings/b1", body: detail({ organiser: { user_id: SAM, name: "Sam Petersen", photo_url: null } }) }]);
    renderPage(<LedgerTable rows={[row("s1", { signedAmountCredits: -25, from: "Nomsa Khumalo", to: "Club treasury", actorUserId: ME })]} label="Wallet ledger" groupShares />);

    const toggle = await screen.findByRole("button", { name: /^Your share · Court 1 · Wed 30 Sep: −25\.00 cr/ });
    fireEvent.click(toggle);
    expect(screen.getByText(/^25\.00 cr moved to Sam for your share of Court 1/)).toBeInTheDocument();
  });

  it("still makes sense when the booking cannot be read (a partner who pulled out reads it as a stranger)", async () => {
    stubFetch([{ path: "/api/v1/bookings/b1", status: 404, body: { error: "booking_not_found" } }]);
    renderPage(<LedgerTable rows={[row("s1", { signedAmountCredits: -25 })]} label="Wallet ledger" groupShares />);
    expect(await screen.findByRole("button", { name: /^Your share of a split booking: −25\.00 cr/ })).toBeInTheDocument();
  });

  it("is off unless asked for: the club's book shows every row as it is", () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1"), row("s2")]} label="Club ledger" />);
    expect(screen.queryByRole("button", { name: /Shares for/ })).toBeNull();
    expect(screen.getAllByText("Share of a split booking")).toHaveLength(2);
  });
});

describe("the share sentences", () => {
  const place = { courtName: "Court 1", startsAt: "2026-09-30T16:00:00Z" };
  it("never speaks of debt: shares move, and come back", () => {
    expect(shareRowSentence({ side: "partner", signed: -25, place, other: "Nomsa Khumalo" })).toBe("25.00 cr moved to Nomsa for your share of Court 1");
    expect(shareRowSentence({ side: "partner", signed: 25, place, other: "Nomsa Khumalo" })).toBe("25.00 cr of your share of Court 1 came back from Nomsa");
    expect(shareRowSentence({ side: "organiser", signed: -25, place, other: null })).toBe("25.00 cr went back to a partner from their share of Court 1");
    for (const s of [shareGroupSentence({ side: "partner", net: -25, place, partners: null })]) expect(s).not.toMatch(/owe|debt/i);
  });

  it("says a paid-and-returned booking plainly", () => {
    expect(shareGroupSentence({ side: "organiser", net: 0, place, partners: 1 })).toBe("Shares for Court 1 · Wed 30 Sep: 0.00 cr — paid and returned");
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
