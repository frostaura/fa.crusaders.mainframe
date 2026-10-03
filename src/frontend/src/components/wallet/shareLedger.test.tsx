import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import type { LedgerRow, ShareBookingSummary } from "@/lib/api";
import { SHARE_LEDGER_COPY, shareGroupSentence, shareRowSentence } from "@/lib/walletCopy";
import { renderPage, stubFetch } from "@/test/harness";
import { LedgerTable } from "../LedgerTable";
import { shareBookingsFrom } from "./useShareBookings";

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
    amountMinutes: 25, signedAmountMinutes: 25, type: "ShareTransfer", comment: "Share of a split booking",
    subjectUserId: ME, subjectName: "Nomsa Khumalo", actorUserId: SAM, actorName: "Sam Petersen",
    relatedBookingId: "b1", ...over,
  };
}

/** The club's summary of booking b1, as the wallet read carries it (`share_bookings`). */
function summary(over: Partial<ShareBookingSummary> = {}): ShareBookingSummary {
  return {
    booking_id: "b1", court_name: "Court 1", starts_at: "2026-09-30T16:00:00Z",
    organiser: { user_id: ME, name: "Nomsa Khumalo", photo_url: null },
    partners: [{ user_id: SAM, name: "Sam Petersen", paid_minutes: 25 }, { user_id: ALEX, name: "Alex Naidoo", paid_minutes: 25 }],
    ...over,
  };
}
const SAM_ORGANISES = { organiser: { user_id: SAM, name: "Sam Petersen", photo_url: null }, partners: [{ user_id: ME, name: "Nomsa Khumalo", paid_minutes: 25 }] };
const known = (s: ShareBookingSummary | null) => shareBookingsFrom({ b1: s });

const TOPUP = row("t1", { type: "TopUp", relatedBookingId: null, comment: "Wallet top-up", at: "2026-09-29T10:00:00Z", signedAmountMinutes: 200, amountMinutes: 200 });

afterEach(() => { vi.unstubAllGlobals(); });

describe("the wallet ledger's share lines", () => {
  it("gathers the organiser's shares under one line, with the court, the day and who paid", async () => {
    const stub = stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1"), TOPUP, row("s2", { actorUserId: ALEX, actorName: "Alex Naidoo", at: "2026-09-30T11:00:00Z" })]} label="Wallet ledger" groupShares shareBookings={known(summary())} />);

    const expected = shareGroupSentence({ side: "organiser", net: 50, place: { courtName: "Court 1", startsAt: "2026-09-30T16:00:00Z" }, partners: 2 });
    // D10 — no amount in the sentence: the Amount column carries it.
    expect(expected).toBe("Shares for Court 1 · Wed 30 Sep from 2 partners");
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
    expect(within(shareRows[0] as HTMLElement).getByText(/^Alex paid you 25 minutes for their share of Court 1/)).toBeInTheDocument();
    expect(within(shareRows[1] as HTMLElement).getByText(/^Sam paid you 25 minutes/)).toBeInTheDocument();

    const link = screen.getByRole("link", { name: new RegExp(`^${SHARE_LEDGER_COPY.viewBooking}`) });
    expect(link).toHaveAttribute("href", "/bookings/b1");
    // Perf round: the lines come from the wallet read's own summaries — no read per booking.
    expect(stub.calls).toHaveLength(0);
  });

  it("says the partner's side as their share, with what moved to whom", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1", { signedAmountMinutes: -25, from: "Nomsa Khumalo", to: "Club treasury", actorUserId: ME })]} label="Wallet ledger" groupShares shareBookings={known(summary(SAM_ORGANISES))} />);

    const toggle = await screen.findByRole("button", { name: /^Your share · Court 1 · Wed 30 Sep, / });
    // D10 — the amount is said once, in its column; the To column names the organiser.
    expect(toggle).not.toHaveTextContent("25 min");
    const line = document.querySelector("[data-share-group]") as HTMLElement;
    expect(within(line).getByText(SHARE_LEDGER_COPY.organiserNamed("Sam Petersen"))).toBeInTheDocument();
    // In its column — and, for the one-column form (a phone at 200 % text), under the words too:
    // jsdom draws both; a real engine shows exactly one of them by the table's box (R5 F5-1).
    expect(line.querySelector("td.text-right")).toHaveTextContent("−25 min");
    expect(line.querySelector("[data-stacked-amount]")).toHaveTextContent("−25 min");
    fireEvent.click(toggle);
    expect(screen.getByText(/^25 minutes moved to Sam for your share of Court 1/)).toBeInTheDocument();
  });

  it("still makes sense when the booking cannot be read (a partner who pulled out reads it as a stranger)", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1", { signedAmountMinutes: -25 })]} label="Wallet ledger" groupShares shareBookings={known(null)} />);
    expect(await screen.findByRole("button", { name: /^Your share of a split booking, / })).toBeInTheDocument();
  });

  it("says the same when the club summarised nothing for that booking (an older API)", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1", { signedAmountMinutes: -25 })]} label="Wallet ledger" groupShares shareBookings={shareBookingsFrom(undefined)} />);
    expect(await screen.findByRole("button", { name: /^Your share of a split booking, / })).toBeInTheDocument();
  });

  it("is off unless asked for: the club's book shows every row as it is", () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1"), row("s2")]} label="Club ledger" />);
    expect(screen.queryByRole("button", { name: /Shares for/ })).toBeNull();
    expect(screen.getAllByText("Share of a split booking")).toHaveLength(2);
  });
});

describe("R1 F2.14 — a refunded share", () => {
  it("nets to zero in neutral ink, never the green of money in, and the whole line opens it", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[
      row("s2", { signedAmountMinutes: 25, at: "2026-09-30T11:00:00Z", actorUserId: SAM }),
      row("s1", { signedAmountMinutes: -25, from: "Nomsa Khumalo", to: "Club treasury", actorUserId: ME }),
    ]} label="Wallet ledger" groupShares shareBookings={known(summary(SAM_ORGANISES))} />);
    const toggle = await screen.findByRole("button", { name: /paid and returned/ });
    const line = toggle.closest("tr") as HTMLElement;
    const amount = line.querySelector("td.text-right") as HTMLElement;
    expect(amount).toHaveTextContent("0 minutes");
    expect(amount.className).not.toMatch(/text-success/);
    const stacked = line.querySelector("[data-stacked-amount] > span") as HTMLElement;
    expect(stacked).toHaveTextContent("0 minutes");
    expect(stacked.className).not.toMatch(/text-success/);
    // The disclosure is stretched over its line (a phone shows only the words and the amount).
    expect(toggle.className).toMatch(/after:absolute/);
    expect(line.className).toMatch(/relative/);
  });
});

describe("the share sentences", () => {
  const place = { courtName: "Court 1", startsAt: "2026-09-30T16:00:00Z" };
  it("never speaks of debt: shares move, and come back", () => {
    expect(shareRowSentence({ side: "partner", signed: -25, place, other: "Nomsa Khumalo" })).toBe("25 minutes moved to Nomsa for your share of Court 1");
    expect(shareRowSentence({ side: "partner", signed: 25, place, other: "Nomsa Khumalo" })).toBe("25 minutes of your share of Court 1 came back from Nomsa");
    expect(shareRowSentence({ side: "organiser", signed: -25, place, other: null })).toBe("25 minutes went back to a partner from their share of Court 1");
    for (const s of [shareGroupSentence({ side: "partner", net: -25, place, partners: null })]) expect(s).not.toMatch(/owe|debt/i);
  });

  it("says a paid-and-returned booking plainly", () => {
    expect(shareGroupSentence({ side: "organiser", net: 0, place, partners: 1 })).toBe("Shares for Court 1 · Wed 30 Sep — paid and returned");
  });

  it("R1 F2.14: a partner's share that came back in full says so, too", () => {
    expect(shareGroupSentence({ side: "partner", net: 0, place, partners: null })).toBe("Your share · Court 1 · Wed 30 Sep — paid and returned");
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("the share line's layout (R4 V4-10)", () => {
  it("keeps the sentence on the cells' baseline, and puts the date under it before the link", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1")]} label="Wallet ledger" groupShares shareBookings={known(summary())} />);
    const toggle = await screen.findByRole("button", { name: /^Shares for Court 1/ });
    // No padding or touch floor of its own: the row is its target, so its words sit where every
    // other cell's words sit (it was 8px low beside the amount).
    expect(toggle.className).not.toMatch(/\bpy-2\b/);
    expect(toggle.className).not.toMatch(/\bmin-h-touch\b/);
    // On a phone the date belongs to its title: it comes before "View booking", not after it.
    const cell = toggle.closest("td")!;
    const time = cell.querySelector("time")!;
    const link = within(cell).getByRole("link", { name: new RegExp(`^${SHARE_LEDGER_COPY.viewBooking}`) });
    expect(time.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
