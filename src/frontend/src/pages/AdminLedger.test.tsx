import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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
