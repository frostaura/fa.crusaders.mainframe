import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import AdminLedgerPage from "./AdminLedger";
import { formatClubDayLabel } from "../components/ui/date-picker-day";
import { LEDGER_TYPE_LABEL } from "../lib/creditAdjustment";
import { LEDGER_COPY } from "../lib/ledgerCopy";
import { ledgerRowFixture, renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { forgetClubZone, rememberClubZone } from "../lib/clubZone";

/**
 * Clearing a date on the admin ledger.
 *
 * <p>
 * An empty date input means <b>unbounded</b>. The page sent the empty string straight
 * into a template and produced <code>"T00:00:00Z"</code> — a malformed range the API
 * answered 400 to. The screen then pushed a toast and <i>kept the previous result on
 * screen</i>: the table and all four totals still showed the 52 rows of the filter that
 * had been cleared, so a filter that failed looked exactly like one that had applied and
 * found the same thing. On a money screen an admin reconciles against, that is worse
 * than an error.
 * </p>
 */
describe("Admin ledger — an empty date is unbounded, not malformed", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const ROWS = [
    ledgerRowFixture({ id: "r1", comment: "Booking charge", signedAmountMinutes: -24, amountMinutes: 24 }),
    ledgerRowFixture({ id: "r2", comment: "Desk goodwill", type: "AdminAdjustment", signedAmountMinutes: 40, amountMinutes: 40 }),
  ];

  const routes = (over: Parameters<typeof stubFetch>[0] = []) => [
    ...over,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/admin/ledger", body: ROWS },
  ];


  it("omits a cleared bound rather than sending \"T00:00:00Z\"", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminLedgerPage />);

    await screen.findByText("Desk goodwill");
    // The date filters are club-day DatePickers (P3, R7); "unbounded" is their clear ×.
    fireEvent.click(screen.getByRole("button", { name: "Clear From" }));

    await vi.waitFor(() => {
      const last = stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/ledger")).at(-1)!;
      // The malformed value, gone — and the parameter gone with it, because "no lower
      // bound" is an absent parameter, not an empty one.
      expect(last.path).not.toContain("T00%3A00%3A00Z&");
      expect(last.path).not.toMatch(/from=T/);
      expect(last.path).not.toContain("from=&");
    });
  });

  it("clears the table when a filter fails, instead of leaving the last answer on screen", async () => {
    stubFetch(routes());
    renderPage(<AdminLedgerPage />);
    await screen.findByText("Desk goodwill");

    // Re-stubbed rather than sequenced, because the second answer differs in STATUS and a
    // sequence entry cannot carry one. This is the rejected range the API really returns.
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/ledger", status: 400, body: { error: "bad_range" } },
    ]);
    // Any change of filter re-reads; clearing a bound is the one a DatePicker offers in one press.
    fireEvent.click(screen.getByRole("button", { name: "Clear To" }));

    // Nothing stale survives: not the rows, and not the totals computed from them.
    await vi.waitFor(() => expect(screen.queryByText("Desk goodwill")).not.toBeInTheDocument());
    expect(screen.queryByText("Booking charge")).not.toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/ledger")).length).toBeGreaterThan(0);
    // And the admin is told ON THE PAGE, where the table was, in a sentence that says what to
    // do about it — with a retry. (It was a toast, which floats away and leaves an empty table
    // reading "no movements"; R12 — a failed read shows retry.)
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Check the dates and try again\./);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText("No movements match these filters.")).not.toBeInTheDocument();
  });
});

/**
 * A report an admin can send to somebody.
 *
 * <p>
 * <code>reporting.md</code> § Filters: <i>"Filter state lives in the URL query string so a
 * report can be shared / bookmarked."</i> It did not. Opening
 * <code>/admin/ledger?userId=&lt;a member&gt;</code> returned all 73 movements in the tenant
 * rather than that member's 29; adding <code>&amp;type=TopUp</code> changed nothing. The
 * in-page controls filtered correctly and wrote nothing back, so the URL stayed
 * <code>/admin/ledger</code> whatever was on screen — the filters worked and were simply
 * not addressable.
 * </p>
 */
describe("Admin ledger — the filters are the URL", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const ROWS = [ledgerRowFixture({ id: "r1", comment: "Booking charge" })];

  const routes = () => [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/admin/ledger", body: ROWS },
  ];

  /** Renders the page beside a probe that prints the router's current query string. */
  function renderAt(entry: string) {
    const stub = stubFetch(routes());
    renderPage(
      <>
        <AdminLedgerPage />
        <SearchProbe />
      </>,
      { initialEntries: [entry] },
    );
    return stub;
  }

  const ledgerCalls = (stub: ReturnType<typeof stubFetch>) =>
    stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/ledger"));

  it("honours every filter a shared link carries, including the one with no control", async () => {
    rememberClubZone("Africa/Johannesburg");
    const stub = renderAt("/admin/ledger?from=2026-01-01&to=2026-01-31&type=TopUp&userId=abc-123&q=Naledi");

    await vi.waitFor(() => expect(ledgerCalls(stub).length).toBeGreaterThan(0));
    const call = ledgerCalls(stub).at(-1)!;

    // `userId` is answered by the API and had no way in from the screen at all, so a link
    // to one member's movements silently showed the whole club's.
    expect(call.path).toContain("userId=abc-123");
    expect(call.path).toContain("type=TopUp");
    // Club days, in the club's zone (R4 A4-7), half-open to the next midnight — never UTC days.
    expect(call.path).toContain("from=2025-12-31T22%3A00%3A00.000Z");
    expect(call.path).toContain("to=2026-01-31T22%3A00%3A00.000Z");
    // And paged (R4 carry-over): the presence of `cursor` asks for a page.
    expect(call.path).toContain("cursor=");

    // The dates the link named, on the pickers — not today's default window.
    expect(screen.getByRole("button", { name: /^From: / })).toHaveAccessibleName(`From: ${formatClubDayLabel("2026-01-01")}`);
    expect(screen.getByRole("button", { name: /^To: / })).toHaveAccessibleName(`To: ${formatClubDayLabel("2026-01-31")}`);
    expect(screen.getByLabelText("Search (name)")).toHaveValue("Naledi");

    // ...and the member filter is said out loud, because an unexplained short list is the
    // same defect wearing a filter.
    expect(screen.getByText(/Showing one member/)).toBeInTheDocument();
  });

  it("writes a filter chosen in the page back into the URL", async () => {
    const stub = renderAt("/admin/ledger?from=2026-01-01&to=2026-01-31");
    await vi.waitFor(() => expect(ledgerCalls(stub).length).toBeGreaterThan(0));

    pickType(LEDGER_TYPE_LABEL.TopUp);
    await vi.waitFor(() => expect(search()).toContain("type=TopUp"));

    fireEvent.change(screen.getByLabelText("Search (name)"), { target: { value: "Naledi" } });
    await vi.waitFor(() => expect(search()).toContain("q=Naledi"));

    // Cleared is cleared: the key goes rather than sitting there empty, which would read
    // back as "unset" and silently restore a default.
    pickType("All types");
    await vi.waitFor(() => expect(search()).not.toContain("type="));
  });

  it("pins the window it is actually showing, so a bookmark means the same thing next week", async () => {
    const stub = renderAt("/admin/ledger");
    await vi.waitFor(() => expect(ledgerCalls(stub).length).toBeGreaterThan(0));

    // "The last 30 days" resolves to a different period every day. What the admin copies
    // has to be the dates on screen.
    await vi.waitFor(() => expect(search()).toContain("from="));
    const pinned = new URLSearchParams(search());
    expect(screen.getByRole("button", { name: /^From: / })).toHaveAccessibleName(`From: ${formatClubDayLabel(pinned.get("from"))}`);
    expect(screen.getByRole("button", { name: /^To: / })).toHaveAccessibleName(`To: ${formatClubDayLabel(pinned.get("to"))}`);
  });
});

/**
 * Zero is neither money in nor money out.
 *
 * <p>
 * The four totals above the club's book were composed as a literal sign wrapped around an
 * unsigned formatter, so the sign was decided by which tile it was rather than by the figure in
 * it. A filter that matched nothing therefore rendered a "+0" and a "−0", side by side, on the one screen in the product whose entire job is reconciling money. A signed zero
 * reads as a movement that did not happen, and an admin chasing a discrepancy reads two of
 * them.
 * </p>
 *
 * <p>
 * The totals go through the signed minutes formatter (`<Minutes signed>`, P13), whose zero has no
 * sign, rather than around it. Fixing it at the
 * formatter boundary is also what makes a genuine zero-valued row right, rather than only the
 * empty filter that made it visible.
 * </p>
 */
describe("Admin ledger — the totals are signed by their value, not by their label", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const routes = (rows: unknown[]) => [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/admin/ledger", body: rows },
  ];

  /**
   * The four figures above the table, in document order: movements, minutes in, minutes out,
   * net — as the eye reads them (`<Minutes>` pairs the compact form with a spoken one).
   */
  const shown = (p: Element) => (p.querySelector("[aria-hidden='true']") ?? p).textContent ?? "";
  const totals = () => [...document.querySelectorAll("[data-ledger-total]")].map(shown);

  /** The same four, as `{ text, className }` — because the colour is the sign said again. */
  const tiles = () => [...document.querySelectorAll("[data-ledger-total]")]
    .map((p) => ({ text: shown(p), cls: p.className }));

  it("puts no sign on a total of nothing", async () => {
    stubFetch(routes([]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("No movements match these filters.");
    expect(totals()).toContain("0 min");
    // The two that were there. U+2212 as well as the hyphen, because the minus this screen
    // draws is the typographic one.
    expect(totals()).not.toContain("+0 min");
    expect(totals()).not.toContain("−0 min");
    expect(totals()).not.toContain("-0 min");
    // And a screen reader hears no sign on it either.
    expect(document.querySelector("[data-ledger-total] .sr-only")).toHaveTextContent("0 minutes");
  });

  it("signs a genuine zero-valued row the same way, not just the empty filter", async () => {
    // A zero-valued adjustment is a real row the API can return — a desk correction that
    // nets out. It lands in neither the "in" nor the "out" bucket, so both totals are zero
    // while the table below is emphatically not empty. Special-casing "no rows" would leave
    // this one wrong.
    stubFetch(routes([ledgerRowFixture({ id: "z1", comment: "Nets out", type: "AdminAdjustment", signedAmountMinutes: 0, amountMinutes: 0 })]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("Nets out");
    expect(totals()).not.toContain("+0 min");
    expect(totals()).not.toContain("−0 min");
  });

  it("does not paint a total of nothing in a direction either", async () => {
    // The "+" one layer down. Money in was unconditionally green, money out unconditionally
    // amber and Net asked `>= 0`, so a period in which the club had neither taken nor given
    // anything was painted as though it had come out ahead. Leaving that would have put an
    // unsigned figure inside a coloured one, which is the disagreement the sign fix removes.
    stubFetch(routes([]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("No movements match these filters.");
    for (const tile of tiles().filter((t) => t.text === "0 min")) {
      expect(tile.cls).not.toMatch(/text-success-strong|text-warning-strong/);
    }
  });

  it("still signs the figures that have a direction", async () => {
    // The guard against fixing the above by dropping the signs altogether. The sign is the
    // information on this table; it just has to come from the number.
    stubFetch(routes([
      ledgerRowFixture({ id: "r1", comment: "Booking charge", signedAmountMinutes: -24, amountMinutes: 24 }),
      ledgerRowFixture({ id: "r2", comment: "Desk goodwill", type: "AdminAdjustment", signedAmountMinutes: 40, amountMinutes: 40 }),
    ]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("Desk goodwill");
    expect(totals()).toContain("+40 min");
    expect(totals()).toContain("−24 min");
    // Net: 40 in, 24 out.
    expect(totals()).toContain("+16 min");

    // And the colour still agrees with the sign, in both directions.
    expect(tiles().find((t) => t.text === "+40 min")!.cls).toMatch(/text-success-strong/);
    expect(tiles().find((t) => t.text === "−24 min")!.cls).toMatch(/text-warning-strong/);
  });

  /**
   * The varied setup value: the SIZE of the movements, which ought not to change any of this.
   * A single fixture at 40 against 24 would pass against arithmetic that happened to be right
   * only for two rows of those magnitudes, and a club whose debits outweigh its credits is the
   * period this screen is opened for. Whole minutes, said the way every amount is (P13).
   */
  it("signs a net that has gone the other way", async () => {
    stubFetch(routes([
      ledgerRowFixture({ id: "r1", comment: "Big charge", signedAmountMinutes: -1500, amountMinutes: 1500 }),
      ledgerRowFixture({ id: "r2", comment: "Small goodwill", type: "AdminAdjustment", signedAmountMinutes: 1, amountMinutes: 1 }),
    ]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("Big charge");
    expect(totals()).toContain("+1 min");
    expect(totals()).toContain("−1 d 1 h");
    expect(totals()).toContain("−1 d 59 min");
    expect(tiles().find((t) => t.text === "−1 d 59 min")!.cls).toMatch(/text-warning-strong/);
    expect(totals().join(" ")).not.toMatch(/\.\d|cr\b/);
  });
});

/**
 * Choose a ledger type the way an admin does: open the design-system Select (a Radix combobox,
 * R7 — it was a raw `<select>`) and press the option by its NAME, never the enum.
 */
function pickType(label: string) {
  fireEvent.pointerDown(screen.getByRole("combobox", { name: "Type" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(screen.getByRole("option", { name: label }));
}

function SearchProbe() {
  return <span data-testid="router-search">{useLocation().search}</span>;
}

function search() {
  return screen.getByTestId("router-search").textContent ?? "";
}

/** Review round 1, F3.8: who made each movement, what kind it was, and every row opens. */
describe("Admin ledger — done by, category, and a detail per row", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const DESK = ledgerRowFixture({
    id: "d1", comment: "R200 cash, receipt 0412", type: "AdminAdjustment", signedAmountMinutes: 40, amountMinutes: 40,
    actorUserId: "admin-1", actorName: "Review Admin", relatedBookingId: "b-77",
  });
  const OWN = ledgerRowFixture({ id: "o1", comment: "Booking charge", signedAmountMinutes: -24, amountMinutes: 24 });

  function open() {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/ledger", body: [DESK, { ...OWN, actorUserId: OWN.subjectUserId, actor_name: null, subjectName: "Olivia Own" }] },
    ]);
    renderPage(<AdminLedgerPage />);
  }

  it("names the admin who made a desk movement, and the member for their own", async () => {
    open();
    await screen.findByText("R200 cash, receipt 0412");
    expect(screen.getByRole("columnheader", { name: /Done by/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Category/ })).toBeInTheDocument();
    expect(screen.getAllByText("Review Admin").length).toBeGreaterThan(0);
    // R3 A-13: the member by name, never "The member".
    expect(screen.queryByText(LEDGER_COPY.themselves)).toBeNull();
    expect(screen.getAllByText("Olivia Own").length).toBeGreaterThan(0);
    expect(screen.getAllByText(LEDGER_TYPE_LABEL.AdminAdjustment).length).toBeGreaterThan(0);
  });

  it("opens a row's whole story, with its booking", async () => {
    open();
    await screen.findByText("R200 cash, receipt 0412");
    fireEvent.click(screen.getByRole("button", { name: /^Details — Admin adjustment, / }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent("Review Admin");
    expect(sheet).toHaveTextContent("R200 cash, receipt 0412");
    expect(screen.getByRole("link", { name: LEDGER_COPY.openBooking })).toHaveAttribute("href", "/bookings/b-77");
  });
});

/**
 * Review round 4 carry-over and A4-7: Transactions asked for `limit=1000` and summed what came
 * back — "MOVEMENTS 1000" and credits/debits/net over a truncated set while the range held 1664.
 * It now reads every page of the range, and shows totals only over a complete read.
 */
describe("Admin ledger — totals over the whole range, page by page", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  const row = (n: number) => ledgerRowFixture({
    id: `r${n}`, comment: `Charge ${n}`, signedAmountMinutes: -10, amountMinutes: 10,
  });
  const totalsShown = () => Array.from(document.querySelectorAll("[data-ledger-total]"))
    .map((el) => (el.querySelector("[aria-hidden='true']") ?? el).textContent);

  it("shows the server's totals for the whole range, and the rows a page at a time", async () => {
    rememberClubZone("Africa/Johannesburg");
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      {
        path: "/api/v1/admin/ledger",
        respond: (req) => (req.path.includes("cursor=c1")
          ? { items: [row(3)], next_cursor: null, totals: null }
          : { items: [row(1), row(2)], next_cursor: "c1", totals: { count: 1664, in_minutes: 500, out_minutes: 16640, net_minutes: -16140 } }),
      },
    ]);
    renderPage(<AdminLedgerPage />, { initialEntries: ["/admin/ledger?from=2026-09-01&to=2026-09-30"] });

    await screen.findByText("Charge 2");
    // The range holds 1664 even though two rows are on the page: never a sum over what was read.
    await vi.waitFor(() => expect(totalsShown()[0]).toBe("1664"));
    expect(screen.queryByText("Charge 3")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more movements" }));
    expect(await screen.findByText("Charge 3")).toBeInTheDocument();
    expect(totalsShown()[0]).toBe("1664");
    expect(screen.queryByRole("button", { name: "Show more movements" })).not.toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/ledger"))[1].path).toContain("cursor=c1");
  });

  it("reads an API that sends no totals to the end, and totals all of it", async () => {
    rememberClubZone("Africa/Johannesburg");
    const pages = [
      { items: [row(1), row(2)], next_cursor: "c1" },
      { items: [row(3)], next_cursor: null },
    ];
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      // `body` too: the stub refuses a route with neither body nor respond before it reads `sequence`.
      { path: "/api/v1/admin/ledger", body: pages[1], sequence: pages },
    ]);
    renderPage(<AdminLedgerPage />, { initialEntries: ["/admin/ledger?from=2026-09-01&to=2026-09-30"] });
    await screen.findByText("Charge 3");
    await vi.waitFor(() => expect(totalsShown()[0]).toBe("3"));
    expect(totalsShown()[2]).toBe("−30 min");
  });

  it("shows no total at all when an API with no totals holds too many to read whole", async () => {
    rememberClubZone("Africa/Johannesburg");
    let n = 0;
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/ledger", respond: () => ({ items: Array.from({ length: 500 }, (_, i) => row(n * 500 + i)), next_cursor: `c${++n}` }) },
    ]);
    renderPage(<AdminLedgerPage />, { initialEntries: ["/admin/ledger?from=2020-01-01&to=2026-09-30"] });
    expect(await screen.findByText(/too many movements to total here/, {}, { timeout: 15_000 })).toBeInTheDocument();
    expect(document.querySelector("[data-ledger-total]")).toBeNull();
  }, 30_000);
});
