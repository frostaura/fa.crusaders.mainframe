import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import WalletPage from "./Wallet";
import { BalanceProvider } from "../lib/balance";
import { ledgerRowFixture, renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The wallet, on the screen a member opens when they are arguing about their balance.
 *
 * <p>
 * The header chip follows the live wallet stream. This page fetched once on mount and
 * never again, so an admin crediting a member while they watched left <b>517.01</b> in
 * the chip and <b>510.01</b> in the card underneath it, with no +7.00 row between them
 * and no refresh control anywhere on the page. Two balances, both from the same server,
 * disagreeing in front of the person least able to explain why.
 * </p>
 *
 * <p>
 * It also asked for a member's ENTIRE history in one call, so the page grew without
 * bound with the ledger. The count now says what it is showing out of what exists.
 * </p>
 */
describe("Wallet — one balance, and a way to refresh it", () => {
  const page = (balance: number, entries: unknown[], total = entries.length) => ({
    balance_credits: balance, entries, total_entries: total, offset: 0, limit: 100,
  });

  beforeEach(() => {
    vi.stubGlobal("EventSource", class { close() {} } as unknown as typeof EventSource);
  });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const ROW = ledgerRowFixture();

  it("re-reads the ledger when the live balance moves, instead of leaving two numbers on screen", async () => {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      {
        path: "/api/v1/wallet",
        body: null,
        // First answer: what the page loaded with. Second: after the desk credit, which
        // is the state the live chip was already showing while the card said 510.01.
        sequence: [
          page(510.01, [ROW]),
          page(517.01, [ROW, ledgerRowFixture({ id: "66", signedAmountCredits: 7, amountCredits: 7, type: "AdminAdjustment", comment: "Desk credit" })], 2),
        ],
      },
    ]);
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>);

    expect(await screen.findByText("510.01")).toBeInTheDocument();

    // The control that did not exist. Pressing it is the member's own answer to "the
    // number at the top and the number in the middle do not match".
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("517.01")).toBeInTheDocument();
    expect(screen.queryByText("510.01")).not.toBeInTheDocument();
    // And the movement that explains the difference is now on the page, not missing.
    expect(screen.getByText("Desk credit")).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path.startsWith("/api/v1/wallet?")).length).toBeGreaterThan(1);
  });

  it("asks for a page of movements, not the member's whole history", async () => {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: page(510.01, [ROW], 240) },
    ]);
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>);

    await screen.findByText("510.01");

    // Bounded. The endpoint returned every row a member had ever had, and the page
    // rendered all of them.
    const call = stub.calls.find((c) => c.path.startsWith("/api/v1/wallet?"))!;
    expect(call.path).toContain("limit=100");
    expect(call.path).toContain("offset=0");

    // The count is honest about being a window, and there is a way to the rest of it.
    expect(screen.getByText("1 of 240 movements")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show older \(239 more\)/ })).toBeInTheDocument();
  });

  it("says nothing about a ledger it could not load", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", status: 500, body: { error: "server_error" } },
    ]);
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>);

    expect(await screen.findByText("Couldn't load wallet.")).toBeInTheDocument();
    // "No movements yet" over a failed fetch tells a member their history is gone.
    expect(screen.queryByText(/No movements yet/)).not.toBeInTheDocument();
  });
});
