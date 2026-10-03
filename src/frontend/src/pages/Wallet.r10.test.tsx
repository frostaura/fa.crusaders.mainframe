import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import WalletPage from "./Wallet";
import { BalanceProvider } from "../lib/balance";
import { BALANCE_SENTENCE } from "../lib/walletCopy";
import { ledgerRowFixture, renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * R10 J10-3 / E10-6 — the Wallet card judged by what the member can SPEND against the club's
 * shortest court, and a stored reason said to the member in their own voice.
 */
describe("Wallet — R10 the card answers 'can I book?'", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", class { close() {} } as unknown as typeof EventSource);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query.includes("reduce"), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

  function open(wallet: Record<string, unknown>, sliceMinutes = 15) {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { entries: [], total_entries: 0, offset: 0, limit: 100, ...wallet } },
      { path: "/api/v1/schedule", body: { date: "2026-10-03", timezone: "Africa/Johannesburg", sliceMinutes, courts: [] } },
    ]);
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>, { initialEntries: ["/wallet"] });
    return stub;
  }
  const sentence = () => document.querySelector("[data-balance-sentence]")?.textContent ?? "";

  it("says 10 minutes cannot book a court of 15, and offers Buy as the way on", async () => {
    open({ balance_minutes: 10 });
    await waitFor(() => expect(sentence()).toBe("You can't book a court with 10 minutes — the shortest booking is 15 minutes. Buy minutes to book."));
    expect(sentence()).not.toContain(BALANCE_SENTENCE.low);
    expect(document.querySelector("[data-balance-level]")?.getAttribute("data-balance-level")).toBe("short");
    expect(screen.getAllByRole("link", { name: "Buy minutes to start booking" }).length).toBeGreaterThan(0);
  });

  it("keeps 'enough for a short game' for a spendable figure that does book a slot", async () => {
    open({ balance_minutes: 40 });
    await waitFor(() => expect(sentence()).toBe(BALANCE_SENTENCE.low));
  });

  it("reads SPENDABLE, not the whole balance: −2 to spend (held for partners) is the empty card", async () => {
    open({ balance_minutes: 40, held_minutes: 42, spendable_minutes: -2, held_until: "2026-10-05T10:00:00Z" });
    await waitFor(() => expect(sentence()).toBe(BALANCE_SENTENCE.zero));
    expect(document.querySelector("[data-balance-level]")?.getAttribute("data-balance-level")).toBe("zero");
  });

  it("E10-6: says the outage reversal's stored club sentence to the member as 'you'", async () => {
    open({
      balance_minutes: 120, total_entries: 1,
      entries: [ledgerRowFixture({ type: "CancellationRefund", signedAmountMinutes: -15, amountMinutes: 15,
        comment: "Outage refund reversed — the member was checked in after all" })],
    });
    expect(await screen.findAllByText("Outage refund reversed — you were checked in after all")).not.toHaveLength(0);
    expect(screen.queryByText(/the member was checked in/)).toBeNull();
  });
});
