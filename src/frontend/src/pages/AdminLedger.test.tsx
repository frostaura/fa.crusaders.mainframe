import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import AdminLedgerPage from "./AdminLedger";
import { formatClubDayLabel } from "../components/ui/date-picker-day";
import { LEDGER_TYPE_LABEL } from "../lib/creditAdjustment";
import { LEDGER_COPY } from "../lib/ledgerCopy";
import { ledgerRowFixture, renderPage, signIn, signOut, stubFetch } from "../test/harness";

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
    ledgerRowFixture({ id: "r1", comment: "Booking charge", signedAmountCredits: -24, amountCredits: 24 }),
    ledgerRowFixture({ id: "r2", comment: "Desk credit", type: "AdminAdjustment", signedAmountCredits: 40, amountCredits: 40 }),
  ];

  const routes = (over: Parameters<typeof stubFetch>[0] = []) => [
    ...over,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/admin/ledger", body: ROWS },
  ];


  it("omits a cleared bound rather than sending \"T00:00:00Z\"", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminLedgerPage />);

    await screen.findByText("Desk credit");
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
    await screen.findByText("Desk credit");

    // Re-stubbed rather than sequenced, because the second answer differs in STATUS and a
    // sequence entry cannot carry one. This is the rejected range the API really returns.
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/ledger", status: 400, body: { error: "bad_range" } },
    ]);
    // Any change of filter re-reads; clearing a bound is the one a DatePicker offers in one press.
    fireEvent.click(screen.getByRole("button", { name: "Clear To" }));

    // Nothing stale survives: not the rows, and not the totals computed from them.
    await vi.waitFor(() => expect(screen.queryByText("Desk credit")).not.toBeInTheDocument());
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
    const stub = renderAt("/admin/ledger?from=2026-01-01&to=2026-01-31&type=TopUp&userId=abc-123&q=Naledi");

    await vi.waitFor(() => expect(ledgerCalls(stub).length).toBeGreaterThan(0));
    const call = ledgerCalls(stub).at(-1)!;

    // `userId` is answered by the API and had no way in from the screen at all, so a link
    // to one member's movements silently showed the whole club's.
    expect(call.path).toContain("userId=abc-123");
    expect(call.path).toContain("type=TopUp");
    expect(call.path).toContain("from=2026-01-01T00%3A00%3A00Z");
    expect(call.path).toContain("to=2026-01-31T23%3A59%3A59Z");

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
 * Zero is neither a credit nor a debit.
 *
 * <p>
 * The four totals above the club's book were composed as a literal sign wrapped around
 * {@link formatCredits} — <code>`+${formatCredits(totals.credits)}`</code> and its minus-sign
 * twin — so the sign was decided by which tile it was rather than by the figure in it. A
 * filter that matched nothing therefore rendered <b>+0.00 cr</b> and <b>−0.00 cr</b>, side by
 * side, on the one screen in the product whose entire job is reconciling money. A signed zero
 * reads as a movement that did not happen, and an admin chasing a discrepancy reads two of
 * them.
 * </p>
 *
 * <p>
 * This is the same defect `formatSignedCredits` was written for, and its own comment records
 * the reports card that hardcoded a minus around `formatCredits` rather than coming through
 * it. That card was fixed; this one was not, because nothing connected them — which is the
 * argument for the totals going through the formatter rather than around it. Fixing it at the
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
   * The four figures above the table, in document order: movements, credits, debits, net.
   * Found by their data attribute (P3 set them in tabular Figtree rather than the monospace
   * face this selected on).
   */
  const totals = () => [...document.querySelectorAll("[data-ledger-total]")].map((p) => p.textContent ?? "");

  /** The same four, as `{ text, className }` — because the colour is the sign said again. */
  const tiles = () => [...document.querySelectorAll("[data-ledger-total]")]
    .map((p) => ({ text: p.textContent ?? "", cls: p.className }));

  it("puts no sign on a total of nothing", async () => {
    stubFetch(routes([]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("No movements match these filters.");
    expect(totals()).toContain("0.00 cr");
    // The two that were there. U+2212 as well as the hyphen, because the minus this screen
    // draws is the typographic one.
    expect(totals()).not.toContain("+0.00 cr");
    expect(totals()).not.toContain("−0.00 cr");
    expect(totals()).not.toContain("-0.00 cr");
  });

  it("signs a genuine zero-valued row the same way, not just the empty filter", async () => {
    // A zero-valued adjustment is a real row the API can return — a desk correction that
    // nets out. It lands in neither the credit nor the debit bucket, so both totals are zero
    // while the table below is emphatically not empty. Special-casing "no rows" would leave
    // this one wrong.
    stubFetch(routes([ledgerRowFixture({ id: "z1", comment: "Nets out", type: "AdminAdjustment", signedAmountCredits: 0, amountCredits: 0 })]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("Nets out");
    expect(totals()).not.toContain("+0.00 cr");
    expect(totals()).not.toContain("−0.00 cr");
  });

  it("does not paint a total of nothing in a direction either", async () => {
    // The "+" one layer down. Credits was unconditionally green, Debits unconditionally
    // amber and Net asked `>= 0`, so a period in which the club had neither taken nor given
    // anything was painted as though it had come out ahead. Leaving that would have put an
    // unsigned figure inside a coloured one, which is the disagreement the sign fix removes.
    stubFetch(routes([]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("No movements match these filters.");
    for (const tile of tiles().filter((t) => t.text === "0.00 cr")) {
      expect(tile.cls).not.toMatch(/text-success-strong|text-warning-strong/);
    }
  });

  it("still signs the figures that have a direction", async () => {
    // The guard against fixing the above by dropping the signs altogether. The sign is the
    // information on this table; it just has to come from the number.
    stubFetch(routes([
      ledgerRowFixture({ id: "r1", comment: "Booking charge", signedAmountCredits: -24, amountCredits: 24 }),
      ledgerRowFixture({ id: "r2", comment: "Desk credit", type: "AdminAdjustment", signedAmountCredits: 40, amountCredits: 40 }),
    ]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("Desk credit");
    expect(totals()).toContain("+40.00 cr");
    expect(totals()).toContain("−24.00 cr");
    // Net: 40 in, 24 out.
    expect(totals()).toContain("+16.00 cr");

    // And the colour still agrees with the sign, in both directions.
    expect(tiles().find((t) => t.text === "+40.00 cr")!.cls).toMatch(/text-success-strong/);
    expect(tiles().find((t) => t.text === "−24.00 cr")!.cls).toMatch(/text-warning-strong/);
  });

  /**
   * The varied setup value: the SIZE of the movements, which ought not to change any of this.
   * A single fixture at 40 against 24 would pass against arithmetic that happened to be right
   * only for two rows of those magnitudes, and a club whose debits outweigh its credits is the
   * period this screen is opened for.
   */
  it("signs a net that has gone the other way", async () => {
    stubFetch(routes([
      ledgerRowFixture({ id: "r1", comment: "Big charge", signedAmountCredits: -1250.5, amountCredits: 1250.5 }),
      ledgerRowFixture({ id: "r2", comment: "Small credit", type: "AdminAdjustment", signedAmountCredits: 0.5, amountCredits: 0.5 }),
    ]));
    renderPage(<AdminLedgerPage />);

    await screen.findByText("Big charge");
    expect(totals()).toContain("+0.50 cr");
    expect(totals()).toContain("−1250.50 cr");
    expect(totals()).toContain("−1250.00 cr");
    expect(tiles().find((t) => t.text === "−1250.00 cr")!.cls).toMatch(/text-warning-strong/);
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
    id: "d1", comment: "R200 cash, receipt 0412", type: "AdminAdjustment", signedAmountCredits: 40, amountCredits: 40,
    actorUserId: "admin-1", actorName: "Review Admin", relatedBookingId: "b-77",
  });
  const OWN = ledgerRowFixture({ id: "o1", comment: "Booking charge", signedAmountCredits: -24, amountCredits: 24 });

  function open() {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/ledger", body: [DESK, { ...OWN, actorUserId: OWN.subjectUserId, actor_name: null }] },
    ]);
    renderPage(<AdminLedgerPage />);
  }

  it("names the admin who made a desk movement, and the member for their own", async () => {
    open();
    await screen.findByText("R200 cash, receipt 0412");
    expect(screen.getByRole("columnheader", { name: /Done by/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Category/ })).toBeInTheDocument();
    expect(screen.getAllByText("Review Admin").length).toBeGreaterThan(0);
    expect(screen.getByText(LEDGER_COPY.themselves)).toBeInTheDocument();
    expect(screen.getAllByText(LEDGER_TYPE_LABEL.AdminAdjustment).length).toBeGreaterThan(0);
  });

  it("opens a row's whole story, with its booking", async () => {
    open();
    await screen.findByText("R200 cash, receipt 0412");
    fireEvent.click(screen.getByRole("button", { name: /Details — Admin adjustment, \+40\.00 cr/ }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent("Review Admin");
    expect(sheet).toHaveTextContent("R200 cash, receipt 0412");
    expect(screen.getByRole("link", { name: LEDGER_COPY.openBooking })).toHaveAttribute("href", "/bookings/b-77");
  });
});
