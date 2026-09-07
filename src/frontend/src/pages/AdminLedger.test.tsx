import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import AdminLedgerPage from "./AdminLedger";
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

  /** The From/To date inputs, in document order. */
  const dateInputs = () => [...document.querySelectorAll<HTMLInputElement>('input[type="date"]')];

  it("omits a cleared bound rather than sending \"T00:00:00Z\"", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminLedgerPage />);

    await screen.findByText("Desk credit");
    fireEvent.change(dateInputs()[0], { target: { value: "" } });

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
    fireEvent.change(dateInputs()[1], { target: { value: "2020-01-01" } });

    // Nothing stale survives: not the rows, and not the totals computed from them.
    await vi.waitFor(() => expect(screen.queryByText("Desk credit")).not.toBeInTheDocument());
    expect(screen.queryByText("Booking charge")).not.toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/ledger")).length).toBeGreaterThan(0);
    // And the member is told, in a sentence that says what to do about it.
    expect(await screen.findByText(/Couldn't load those movements — check the dates and try again\./)).toBeInTheDocument();
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

    // The dates the link named, on the inputs — not today's default window.
    const dates = [...document.querySelectorAll<HTMLInputElement>('input[type="date"]')];
    expect(dates[0].value).toBe("2026-01-01");
    expect(dates[1].value).toBe("2026-01-31");
    expect(screen.getByLabelText("Search (name)")).toHaveValue("Naledi");

    // ...and the member filter is said out loud, because an unexplained short list is the
    // same defect wearing a filter.
    expect(screen.getByText(/Showing one member/)).toBeInTheDocument();
  });

  it("writes a filter chosen in the page back into the URL", async () => {
    const stub = renderAt("/admin/ledger?from=2026-01-01&to=2026-01-31");
    await vi.waitFor(() => expect(ledgerCalls(stub).length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "TopUp" } });
    await vi.waitFor(() => expect(search()).toContain("type=TopUp"));

    fireEvent.change(screen.getByLabelText("Search (name)"), { target: { value: "Naledi" } });
    await vi.waitFor(() => expect(search()).toContain("q=Naledi"));

    // Cleared is cleared: the key goes rather than sitting there empty, which would read
    // back as "unset" and silently restore a default.
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "" } });
    await vi.waitFor(() => expect(search()).not.toContain("type="));
  });

  it("pins the window it is actually showing, so a bookmark means the same thing next week", async () => {
    const stub = renderAt("/admin/ledger");
    await vi.waitFor(() => expect(ledgerCalls(stub).length).toBeGreaterThan(0));

    // "The last 30 days" resolves to a different period every day. What the admin copies
    // has to be the dates on screen.
    const dates = [...document.querySelectorAll<HTMLInputElement>('input[type="date"]')];
    await vi.waitFor(() => expect(search()).toContain(`from=${dates[0].value}`));
    expect(search()).toContain(`to=${dates[1].value}`);
  });
});

function SearchProbe() {
  return <span data-testid="router-search">{useLocation().search}</span>;
}

function search() {
  return screen.getByTestId("router-search").textContent ?? "";
}
