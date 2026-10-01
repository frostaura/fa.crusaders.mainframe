import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminLedgerPage from "./AdminLedger";
import { ledgerRowFixture, refuse, renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";

/**
 * R4 (integrator, after lane D): Refresh that fails over the book already on screen keeps the
 * rows and the totals, under "Couldn't refresh — showing what we had at …". New filters that fail
 * still take the rows away (R12): the last answer under filters it does not answer is wrong.
 */
describe("Transactions after a failed refresh", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  it("keeps the movements it had and says when they are from", async () => {
    let failing = false;
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      {
        path: "/api/v1/admin/ledger",
        respond: () => (failing ? refuse(503, { error: "busy" }) : [ledgerRowFixture({ id: "r1", comment: "Desk credit" })]),
      },
    ]);
    renderPage(<AdminLedgerPage />, { initialEntries: ["/admin/transactions?from=2026-09-01&to=2026-09-30"] });
    expect(await screen.findAllByText("Desk credit")).not.toHaveLength(0);

    failing = true;
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(await screen.findByText(OFFLINE_COPY.refreshFailedTitle)).toBeInTheDocument();
    expect(screen.getAllByText("Desk credit")).not.toHaveLength(0);
    expect(document.querySelectorAll("[data-ledger-total]").length).toBe(4);
    expect(screen.queryByText(/Couldn.t read those movements/)).not.toBeInTheDocument();
  });

  it("drops the rows when NEW filters fail, and says the read failed", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      {
        path: "/api/v1/admin/ledger",
        respond: (req) => (req.path.includes("type=TopUp") ? refuse(503, { error: "busy" }) : [ledgerRowFixture({ id: "r1", comment: "Desk credit" })]),
      },
    ]);
    renderPage(<AdminLedgerPage />, { initialEntries: ["/admin/transactions?from=2026-09-01&to=2026-09-30&type=TopUp"] });
    await waitFor(() => expect(screen.getByText(/Couldn.t read those movements/)).toBeInTheDocument());
    expect(screen.queryByText("Desk credit")).not.toBeInTheDocument();
    expect(screen.queryByText(OFFLINE_COPY.refreshFailedTitle)).not.toBeInTheDocument();
  });
});
