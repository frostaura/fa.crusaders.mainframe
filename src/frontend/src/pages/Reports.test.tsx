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
    { date: "2026-09-01", top_ups_credits: 160, spent_credits: 24, refunds_credits: 8, bookings: 1, attended: 1, minutes_on_court: 45, balance_credits: 136 },
    { date: "2026-09-02", top_ups_credits: 0, spent_credits: 0, refunds_credits: -8, bookings: 0, attended: 0, minutes_on_court: 0, balance_credits: 128 },
  ];

  const WALLET = {
    from: "", to: "",
    top_ups_credits: 160, spent_credits: 24, refunds_credits: -8,
    penalties_credits: 0, adjustments_credits: 0, reversals_credits: 0,
    net_movement_credits: 128,
    penalty_count: 1, attended_bookings: 1, minutes_on_court: 45, count: 4,
  };

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

/**
 * The member's own summary, on the ledger the finder actually had in front of her.
 *
 * <p>
 * Naledi's 30-day window covers her entire history: 0.00 in, 950.00 of court spend,
 * 100.00 refunded, one 15.00 penalty and 2,500.00 of `AdminAdjustment` — the 500 seed
 * opening balance and a 2,000 desk credit. The page showed top-ups, spend, refunds and a
 * penalty COUNT and nothing else, so it read as <b>0 in, 950 out, 100 back = −850</b>
 * beside a header saying <b>1,635.00 cr</b>, with nothing on screen accounting for the
 * gap. The 2,500 was not small print; it was most of her balance.
 * </p>
 *
 * <p>
 * So the test is arithmetic, not layout: every bucket a movement can land in is on the
 * page, and their sum is stated and equals what the balance moved by. A summary a member
 * cannot reconcile is the summary they phone the club about.
 * </p>
 */
describe("Reports — the member's summary reconciles to their balance", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const NALEDI = {
    from: "", to: "",
    top_ups_credits: 0,
    spent_credits: 950,
    refunds_credits: 100,
    penalties_credits: 15,
    adjustments_credits: 2500,
    reversals_credits: 0,
    // 0 − 950 + 100 − 15 + 2500. Her balance is 1,635.00 and this is what it moved by.
    net_movement_credits: 1635,
    penalty_count: 1,
    attended_bookings: 14,
    minutes_on_court: 225,
    count: 23,
  };

  const ME_DAYS = [
    { date: "2026-09-01", top_ups_credits: 0, spent_credits: 50, refunds_credits: 0, bookings: 2, attended: 1, minutes_on_court: 45, balance_credits: 1635 },
  ];

  // A function, not a constant: `signIn` writes the token to storage, and `afterEach`
  // clears it. Built once, the second test in this block would render signed out.
  const routes = () => [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/reports/me/wallet.csv", body: "at,type,amount\n", headers: { "content-disposition": 'attachment; filename="wallet-2026-09.csv"' } },
    { path: "/api/v1/reports/me/wallet", body: NALEDI },
    { path: "/api/v1/reports/me/daily", body: ME_DAYS },
  ];

  it("shows every bucket, the penalty TOTAL, and a net that equals the balance move", async () => {
    stubFetch(routes());
    renderPage(<ReportsPage />);

    await screen.findByRole("heading", { name: "My wallet — totals" });
    const card = screen.getByRole("heading", { name: "My wallet — totals" }).parentElement!;
    const w = within(card);

    // The two that were invisible. Without the adjustments line the page is off by 2,500
    // and says nothing about it; without the penalty total the 15.00 appears NOWHERE in
    // the product, only its count does — `reporting.md` asks for count AND total.
    expect(w.getByText("Adjustments")).toBeInTheDocument();
    expect(w.getByText("+2500.00 cr")).toBeInTheDocument();
    expect(w.getByText("Penalties")).toBeInTheDocument();
    expect(w.getByText("−15.00 cr")).toBeInTheDocument();

    // Signs on the buckets, so the reader can add them up without guessing direction.
    expect(w.getByText("−950.00 cr")).toBeInTheDocument();
    expect(w.getByText("+100.00 cr")).toBeInTheDocument();

    // And the arithmetic, stated. 1,635.00 is her balance; the page now says so out loud
    // rather than leaving a −850 summary next to a 1,635 header.
    expect(w.getByText("+1635.00 cr")).toBeInTheDocument();
    expect(w.getByText(/is exactly what your balance moved by/)).toBeInTheDocument();
  });

  it("shows attendance, which nothing in the product showed anywhere", async () => {
    stubFetch(routes());
    renderPage(<ReportsPage />);

    // `reporting.md` has promised "Time on court" since it was written, and a checked-in
    // slot rendered identically to one that cost a no-show penalty. 225 minutes is 3 h 45.
    expect(await screen.findByText("Time on court")).toBeInTheDocument();
    expect(screen.getByText("3 h 45 min")).toBeInTheDocument();
    expect(screen.getByText("14 · 3 h 45 min")).toBeInTheDocument();
  });

  it("fetches the wallet CSV with the session token rather than navigating to it", async () => {
    // jsdom implements neither, and the point of the fix is that the file arrives as a
    // blob the page saves rather than as a navigation the browser makes unauthenticated.
    const created: unknown[] = [];
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: (b: unknown) => { created.push(b); return "blob:wallet"; },
      revokeObjectURL: () => {},
    }));
    const stub = stubFetch(routes());
    renderPage(<ReportsPage />);

    (await screen.findByRole("button", { name: "Download wallet CSV" })).click();
    await vi.waitFor(() => {
      const csv = stub.calls.find((c) => c.path.includes("/wallet.csv"));
      expect(csv, "the CSV endpoint was never called").toBeTruthy();
    });

    // The whole defect in one assertion: the request carries an Authorization header.
    // The control was an `<a href download>`, so the browser issued this itself with no
    // header, the API could not resolve a tenant, and it answered 400 tenant_unresolved
    // as JSON — the download started, cancelled itself, and left the page identical.
    const call = stub.calls.find((c) => c.path.includes("/wallet.csv"))!;
    expect(call.headers.authorization).toBe("Bearer test.token.value");
    expect(call.method).toBe("GET");

    // And a blob was actually produced, so the anchor had a file to save.
    await vi.waitFor(() => expect(created.length).toBe(1));
  });
});

/**
 * The club's utilisation table, which contradicted the ledger and mixed units.
 *
 * <p>
 * "Revenue" was the price quoted at booking, so a no-showed 50.00 court counted as 50.00
 * of revenue on the same dashboard whose ledger said the club took the 15.00 penalty —
 * and settlement-model S5 agrees with the ledger. "Slices" counted a 60-minute walk-up
 * (SliceCount 1) the same as a 15-minute booking, so the column added quarter-hours to
 * hours and reported the total as a number.
 * </p>
 */
describe("Reports — utilisation says what it counts", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const WALLET = {
    from: "", to: "", top_ups_credits: 0, spent_credits: 0, refunds_credits: 0,
    penalties_credits: 0, adjustments_credits: 0, reversals_credits: 0,
    net_movement_credits: 0, penalty_count: 0, attended_bookings: 0, minutes_on_court: 0, count: 0,
  };

  it("separates what was quoted from what the club kept, and counts minutes not slices", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/reports/me/wallet", body: WALLET },
      { path: "/api/v1/reports/me/daily", body: [] },
      { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 0, reversals_zar: 0, net_zar: 0, gross_topups_credits: 0, reversals_credits: 0, net_credits: 0 } },
      {
        path: "/api/v1/admin/reports/utilisation",
        body: {
          from: "", to: "",
          // Court 1: one 50.00 booking, no-showed. Quoted 50.00; the club kept the 15.00
          // penalty, which is what its own ledger rows for that booking sum to.
          by_court: [{ court_id: "c1", court_number: 1, court_name: "Court 1", slices: 1, booked_minutes: 60, bookings: 1, revenue_credits: 15, quoted_credits: 50 }],
        },
      },
      { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 1, no_show: 1, no_show_pct: 100 } },
      { path: "/api/v1/admin/reports/daily", body: [] },
    ]);
    renderPage(<ReportsPage />);

    const title = await screen.findByRole("heading", { name: "Utilisation by court" });
    const card = within(title.closest("div")!.parentElement!);

    // Two columns, because they are two different numbers and the old single "Revenue"
    // column was the wrong one of them.
    expect(card.getByRole("columnheader", { name: /Quoted/ })).toBeInTheDocument();
    expect(card.getByRole("columnheader", { name: /Kept/ })).toBeInTheDocument();
    expect(card.getByText("50.00 cr")).toBeInTheDocument();
    expect(card.getByText("15.00 cr")).toBeInTheDocument();

    // Minutes, said as a person says them. "Slices" is gone: 1 there meant either 15
    // minutes or 60 depending on the row, and the column summed the two.
    expect(card.queryByRole("columnheader", { name: /Slices/ })).not.toBeInTheDocument();
    expect(card.getByRole("columnheader", { name: /Booked/ })).toBeInTheDocument();
    expect(card.getByText("1 h")).toBeInTheDocument();

    // And a sentence saying which is which, because "Kept" below "Quoted" reads as an
    // error to anyone who has not been told about no-shows.
    expect(card.getByText(/for a no-show that is the penalty, not the price/)).toBeInTheDocument();
  });
});
