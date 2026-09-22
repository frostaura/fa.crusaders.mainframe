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
  //
  // Wednesday also carries a −160.00 PaymentReversal, which is the shape the verifier put on
  // a live stack: `LedgerEntryType.PaymentReversal` reached no bucket of this row, so the
  // totals card printed 161.50 — the five buckets it did have — under a sentence claiming it
  // was "every ledger movement in the club summed". The true movement is 1.50.
  const ADMIN_DAYS = [
    { date: "2026-09-01", top_ups_credits: 160, booking_charges_credits: 24, refunds_credits: 8, penalties_credits: 2.4, adjustments_credits: 25.5, reversals_credits: 0, net_movement_credits: 167.1, bookings: 3, no_shows: 1 },
    { date: "2026-09-02", top_ups_credits: 0, booking_charges_credits: 0, refunds_credits: -8, penalties_credits: -2.4, adjustments_credits: 0, reversals_credits: -160, net_movement_credits: -165.6, bookings: 0, no_shows: 0 },
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
    expect(table.getByText("R8.00")).toBeInTheDocument();
    expect(table.getByText("-R8.00")).toBeInTheDocument();
    expect(table.getByText("R2.40")).toBeInTheDocument();
    expect(table.getByText("-R2.40")).toBeInTheDocument();

    // No NaN anywhere — the number went through a formatter, not a subtraction.
    expect(table.queryByText(/NaN/)).not.toBeInTheDocument();

    // And the sentence that says what a negative day is.
    expect(table.getByText(/Refunds, penalties, adjustments and reversals are net/)).toBeInTheDocument();
    expect(table.getByText(/opposite-sign row on the day it lands/)).toBeInTheDocument();
  });

  /**
   * <b>The second place the two quantities meet</b>, and the reason this card needed more
   * than a formatter change.
   *
   * <p>
   * <code>net_zar</code> is money the gateway actually settled. <code>gross_topups_credits</code>
   * is what those same payments became in member wallets, which at 1.6 is 60% bigger. They
   * used to be told apart by their units; they are now both written <code>R…</code>, so an
   * admin reading "R100.00" beside "R160.00" has nothing but the labels to go on.
   * </p>
   */
  it("says which of two figures in the same symbol is card money and which is wallet money", async () => {
    stubFetch(routes(true));
    renderPage(<ReportsPage />);

    // The old labels were "Net revenue" and "Top-ups" — two nouns that do not say which side
    // of the conversion they are on.
    // Each label appears twice — on the tile, and as the <strong> in the note that explains
    // it — so the tile is the one whose own element is the label paragraph.
    const tile = (label: string) => {
      const p = screen.getAllByText(label).find((el) => el.tagName === "P");
      if (!p?.parentElement) throw new Error(`No tile for ${label}`);
      return within(p.parentElement);
    };

    await screen.findByText("R100.00");
    // The gateway leg, settled net of fees, and the wallet leg it became at 1.6. Read inside
    // their own tiles: R160.00 is also a day in the table below, which is the whole hazard.
    expect(tile("Received by the club").getByText("R100.00")).toBeInTheDocument();
    expect(tile("Added to wallets").getByText("R160.00")).toBeInTheDocument();
    expect(screen.getAllByText("Received by the club")).toHaveLength(2);
    expect(screen.getAllByText("Added to wallets")).toHaveLength(2);

    // …and the sentence that says why the second is bigger, rather than leaving an admin to
    // conclude the report is broken.
    expect(screen.getByText(/what the payment gateway settled/)).toBeInTheDocument();
    expect(screen.getByText(/at each member-class rate/)).toBeInTheDocument();
  });

  /** A member sees neither figure, so the note that explains them must not be there either. */
  it("keeps the gateway-versus-wallet note off a member's own report", async () => {
    stubFetch(routes(false));
    renderPage(<ReportsPage />);

    await screen.findByText("My wallet — totals");
    expect(screen.queryByText("Received by the club")).toBeNull();
    expect(screen.queryByText(/what the payment gateway settled/)).toBeNull();
  });

  /**
   * The club's own report, and the two things that were not on it.
   *
   * <p>
   * There was no adjustments figure anywhere, tenant-wide — a club that had handed out
   * 2,525.50 credits at the desk could read that number on a member's own report and on
   * Transactions, and on no screen describing the club. And in the middle of the club-wide
   * report sat "My wallet — totals": the ADMIN'S wallet, all zeros, permanently, because a
   * desk account's balance is zero by design (`feature-spec.md` §8) — ending in the
   * sentence "it is exactly what your balance moved by".
   * </p>
   */
  it("gives the admin the club's money, including what the desk adjusted — and not their own empty wallet", async () => {
    stubFetch(routes(true));
    renderPage(<ReportsPage />);

    // The card itself, not the page: the daily table below carries the same column labels.
    const heading = await screen.findByRole("heading", { name: "Club money — totals" });
    const card = heading.parentElement!;
    const stats = within(card.querySelector("dl")!);

    expect(stats.getByText("Adjustments")).toBeInTheDocument();
    expect(stats.getByText("+R25.50")).toBeInTheDocument();
    expect(within(card).getByText(/what the desk added or took back by hand/)).toBeInTheDocument();

    // The desk's own wallet is gone from the club's report.
    expect(screen.queryByRole("heading", { name: "My wallet — totals" })).not.toBeInTheDocument();
    expect(screen.queryByText(/is exactly what your balance moved by/)).not.toBeInTheDocument();
  });

  /**
   * The card's closing sentence, kept.
   *
   * <p>
   * "top-ups − charges + refunds − penalties + adjustments, which is every ledger movement
   * in the club summed" was false: `PaymentReversal` was in no bucket of the daily row, so a
   * −160.00 clawback inside the window left the card printing +161.50 over a true movement
   * of +1.50, and the member's own report — which sums every type — disagreed with it by
   * exactly the reversals. The sentence is a promise; this is the promise being kept.
   * </p>
   */
  it("sums every ledger movement in the club, reversals included, and says so truthfully", async () => {
    stubFetch(routes(true));
    renderPage(<ReportsPage />);

    const heading = await screen.findByRole("heading", { name: "Club money — totals" });
    const card = heading.parentElement!;
    const stats = within(card.querySelector("dl")!);

    // The bucket that was on no screen, with its sign.
    expect(stats.getByText("Reversals")).toBeInTheDocument();
    expect(stats.getByText("−R160.00")).toBeInTheDocument();

    // The net, which is the whole point: 160 − 24 + 0 − 0 + 25.5 − 160.
    expect(within(card).getByText("+R1.50")).toBeInTheDocument();
    // And NOT the number the five-bucket sum produced. This is the assertion that fails if
    // the reversal is dropped anywhere between the endpoint and this paragraph.
    expect(within(card).queryByText("+R161.50")).not.toBeInTheDocument();

    // The copy names the sixth term, so the arithmetic on the page can be checked by hand.
    expect(within(card).getByText(/\+ reversals, which is every ledger movement in the club summed/)).toBeInTheDocument();
    expect(within(card).getByText(/clawed back after the fact/)).toBeInTheDocument();
  });

  /**
   * The window the page asks for, which is half of the boundary defect.
   *
   * <p>
   * The reports read `from` and `to` as day markers — the UTC calendar date each instant
   * names — and build the club's own days from them. A well-meaning "fix" that localises
   * either marker (`new Date(from).toISOString()` on a machine west of UTC) names the day
   * before, and the club silently gets a report starting a day early. So the exact shape is
   * pinned, against the values in the two date inputs.
   * </p>
   */
  it("asks for the two dates the admin picked, as UTC day markers", async () => {
    const stub = stubFetch(routes(true));
    renderPage(<ReportsPage />);

    await screen.findByRole("heading", { name: "Club money — totals" });
    const call = stub.calls.find((c) => c.path.includes("/admin/reports/daily"))!;
    expect(call, "the daily report was never requested").toBeTruthy();

    const dates = screen.getAllByDisplayValue(/^\d{4}-\d{2}-\d{2}$/) as HTMLInputElement[];
    const [fromDate, toDate] = dates.map((d) => d.value);
    // Decoded, because the colons travel percent-encoded on the wire.
    const query = decodeURIComponent(call.path);
    expect(query).toContain(`from=${fromDate}T00:00:00Z`);
    expect(query).toContain(`to=${toDate}T23:59:59Z`);
  });

  it("shows a reversal in the daily table too, so the table reconciles to the card", async () => {
    stubFetch(routes(true));
    renderPage(<ReportsPage />);

    const table = await tableUnder("Daily breakdown");
    expect(table.getByRole("columnheader", { name: /Reversals/ })).toBeInTheDocument();
    expect(table.getByText("-R160.00")).toBeInTheDocument();
  });

  it("puts the desk's adjustments in the daily table and says which clock each column is on", async () => {
    stubFetch(routes(true));
    renderPage(<ReportsPage />);

    const table = await tableUnder("Daily breakdown");
    expect(table.getByRole("columnheader", { name: /Adjustments/ })).toBeInTheDocument();
    expect(table.getByText("R25.50")).toBeInTheDocument();

    // "Charges R2300.00 · Bookings 6" was one row about two different sets of bookings —
    // money on the day it moved, courts on the day they are played — with nothing on the
    // page saying so. The column is renamed and the consequence is spelled out.
    expect(table.getByRole("columnheader", { name: /Courts played/ })).toBeInTheDocument();
    expect(table.queryByRole("columnheader", { name: /^Bookings$/ })).not.toBeInTheDocument();
    expect(table.getByText(/Two dates in one row, on purpose/)).toBeInTheDocument();
    expect(table.getByText(/charged today and plays later/)).toBeInTheDocument();
  });

  it("does the same on the member's own daily breakdown", async () => {
    stubFetch(routes(false));
    renderPage(<ReportsPage />);

    const table = await tableUnder("Daily breakdown");
    expect(table.getByRole("columnheader", { name: /Refunds \(net\)/ })).toBeInTheDocument();
    // A member reading their own statement is the person most likely to read a negative
    // refund as a mistake, and the one with the least context to resolve it.
    expect(table.getByText("-R8.00")).toBeInTheDocument();
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
 * beside a header saying <b>R1,635.00</b>, with nothing on screen accounting for the
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
    expect(w.getByText("+R2500.00")).toBeInTheDocument();
    expect(w.getByText("Penalties")).toBeInTheDocument();
    expect(w.getByText("−R15.00")).toBeInTheDocument();

    // Signs on the buckets, so the reader can add them up without guessing direction.
    expect(w.getByText("−R950.00")).toBeInTheDocument();
    expect(w.getByText("+R100.00")).toBeInTheDocument();

    // And the arithmetic, stated. 1,635.00 is her balance; the page now says so out loud
    // rather than leaving a −850 summary next to a 1,635 header.
    expect(w.getByText("+R1635.00")).toBeInTheDocument();
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
    expect(card.getByText("R50.00")).toBeInTheDocument();
    expect(card.getByText("R15.00")).toBeInTheDocument();

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

/**
 * A period in which nothing moved.
 *
 * <p>
 * "My wallet — totals" hardcoded its own <code>+</code> and <code>−</code> around
 * <code>formatMoney</code> for Top-ups, Spent and Penalties, while going through
 * <code>formatSignedMoney</code> two lines away for Refunds and Adjustments. A member
 * with no spend and no penalties was therefore shown <b>−R0.00</b> twice, on the one
 * card whose whole job is to reconcile. Zero has no direction, and every figure on the
 * card now comes through the same formatter.
 * </p>
 */
describe("Reports — the totals card on a period with no movement", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const EMPTY_WALLET = {
    from: "", to: "",
    top_ups_credits: 0, spent_credits: 0, refunds_credits: 0,
    penalties_credits: 0, adjustments_credits: 0, reversals_credits: 0,
    net_movement_credits: 0,
    penalty_count: 0, attended_bookings: 0, minutes_on_court: 0, count: 0,
  };

  it("shows an unsigned zero rather than a negative one", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/reports/me/wallet", body: EMPTY_WALLET },
      { path: "/api/v1/reports/me/daily", body: [] },
    ]);
    renderPage(<ReportsPage />);

    const title = await screen.findByRole("heading", { name: "My wallet — totals" });
    // The <dl> itself, not the card: the tiles above it carry the same labels.
    const card = within(title.parentElement!.querySelector("dl")!);

    // U+2212 MINUS is what the card actually printed, so look for that as well as a hyphen.
    expect(card.queryByText("−R0.00")).not.toBeInTheDocument();
    expect(card.queryByText("-R0.00")).not.toBeInTheDocument();
    expect(card.queryByText("+R0.00")).not.toBeInTheDocument();

    // Every bucket on the card, all of them zero, all of them unsigned.
    for (const label of ["Top-ups", "Spent", "Refunds (net)", "Penalties", "Adjustments"]) {
      const term = card.getByText(label);
      expect(term.parentElement).toHaveTextContent(`${label}R0.00`);
    }
  });

  it("still shows the direction of a figure that has one", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/reports/me/wallet", body: { ...EMPTY_WALLET, top_ups_credits: 160, spent_credits: 24, net_movement_credits: 136 } },
      { path: "/api/v1/reports/me/daily", body: [] },
    ]);
    renderPage(<ReportsPage />);

    const title = await screen.findByRole("heading", { name: "My wallet — totals" });
    // The <dl> itself, not the card: the tiles above it carry the same labels.
    const card = within(title.parentElement!.querySelector("dl")!);

    expect(card.getByText("Top-ups").parentElement).toHaveTextContent("Top-ups+R160.00");
    // Spend leaves the wallet, so it is negated — not merely labelled with a minus.
    expect(card.getByText("Spent").parentElement).toHaveTextContent("Spent−R24.00");
  });
});
