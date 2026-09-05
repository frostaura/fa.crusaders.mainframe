import { describe, expect, it, vi, afterEach } from "vitest";
import { screen, within } from "@testing-library/react";
import ReportsPage from "./Reports";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The daily breakdown, on a day whose bucket is negative.
 *
 * <p>
 * Settlement-model I11: a correction is posted as a new row of the same type with the
 * opposite sign, never as an edit, because a single netted row cannot answer "how much
 * penalty did I pay?" — the question a disputed settlement asks. The accepted
 * consequence is that <code>refunds_credits</code> and <code>penalties_credits</code>
 * are <b>net</b> per day, and a day goes negative whenever a reversal lands in a
 * different day's bucket from the sweep it reverses. The API is right and stays; the
 * screen has to be honest about it.
 * </p>
 *
 * <p>
 * So: the columns say net, the value keeps its sign rather than being shown as a
 * magnitude, and there is a sentence under the table saying what a negative day means.
 * Printing |x| would make the sweep day and the reversal day identical on screen and
 * erase the only trace here that a reversal happened at all.
 * </p>
 */
describe("Reports — net daily buckets", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  // Tuesday the sweep, Wednesday the box's upload landing and reversing it. Wednesday's
  // refund and penalty buckets are the reversal rows alone, and both are negative.
  const ADMIN_DAYS = [
    { date: "2026-09-01", top_ups_credits: 160, booking_charges_credits: 24, refunds_credits: 8, penalties_credits: 2.4, bookings: 3, no_shows: 1 },
    { date: "2026-09-02", top_ups_credits: 0, booking_charges_credits: 0, refunds_credits: -8, penalties_credits: -2.4, bookings: 0, no_shows: 0 },
  ];
  const ME_DAYS = [
    { date: "2026-09-01", top_ups_credits: 160, spent_credits: 24, refunds_credits: 8, bookings: 1, balance_credits: 136 },
    { date: "2026-09-02", top_ups_credits: 0, spent_credits: 0, refunds_credits: -8, bookings: 0, balance_credits: 128 },
  ];

  const WALLET = { from: "", to: "", top_ups_credits: 160, spent_credits: 24, refunds_credits: -8, penalty_count: 1, count: 4 };

  const routes = (isAdmin: boolean) => [
    { path: "/api/v1/whoami", body: signIn({ isAdmin }) },
    { path: "/api/v1/reports/me/wallet", body: WALLET },
    { path: "/api/v1/reports/me/daily", body: ME_DAYS },
    { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 100, reversals_zar: 0, net_zar: 100, gross_topups_credits: 160, reversals_credits: 0, net_credits: 160 } },
    { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [] } },
    { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 3, no_show: 1, no_show_pct: 33.3 } },
    { path: "/api/v1/admin/reports/daily", body: ADMIN_DAYS },
  ];

  /** The table under the given heading, once it has arrived. */
  async function tableUnder(heading: string) {
    const title = await screen.findByRole("heading", { name: heading });
    const card = title.closest("div")?.parentElement;
    if (!card) throw new Error(`No card around "${heading}"`);
    return within(card);
  }

  it("labels the club's refund and penalty columns net, and keeps the sign of a reversal day", async () => {
    stubFetch(routes(true));
    renderPage(<ReportsPage />);

    const table = await tableUnder("Daily breakdown");
    // The headers. "Refunds" alone reads as gross, and a reader who believes that reads
    // Wednesday as a bug in the report rather than as Tuesday's sweep being undone.
    expect(table.getByRole("columnheader", { name: /Refunds \(net\)/ })).toBeInTheDocument();
    expect(table.getByRole("columnheader", { name: /Penalties \(net\)/ })).toBeInTheDocument();

    // Both signs present, and the negative kept as a negative rather than shown as 8.00.
    expect(table.getByText("8.00 cr")).toBeInTheDocument();
    expect(table.getByText("-8.00 cr")).toBeInTheDocument();
    expect(table.getByText("2.40 cr")).toBeInTheDocument();
    expect(table.getByText("-2.40 cr")).toBeInTheDocument();

    // No NaN anywhere — the number went through a formatter, not a subtraction.
    expect(table.queryByText(/NaN/)).not.toBeInTheDocument();

    // And the sentence that says what a negative day is.
    expect(table.getByText(/Refunds and penalties are net/)).toBeInTheDocument();
    expect(table.getByText(/opposite-sign row on the day it lands/)).toBeInTheDocument();
  });

  it("does the same on the member's own daily breakdown", async () => {
    stubFetch(routes(false));
    renderPage(<ReportsPage />);

    const table = await tableUnder("Daily breakdown");
    expect(table.getByRole("columnheader", { name: /Refunds \(net\)/ })).toBeInTheDocument();
    // A member reading their own statement is the person most likely to read a negative
    // refund as a mistake, and the one with the least context to resolve it.
    expect(table.getByText("-8.00 cr")).toBeInTheDocument();
    expect(table.getByText(/Refunds are net/)).toBeInTheDocument();

    // The window totals are the same arithmetic over a longer bucket, so they are
    // labelled the same way rather than left looking gross.
    expect(screen.getAllByText("Refunds (net)").length).toBeGreaterThan(0);
  });
});
