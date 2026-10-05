import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import WalletPage from "./Wallet";
import { BalanceProvider } from "../lib/balance";
import { showOlderLabel } from "../lib/walletCopy";
import { ledgerRowFixture, renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * R14 X14-1 — the wallet's last "Show older" takes its button away with it; focus must land on the
 * first movement that page brought, never `<body>` (the class R12 X12-2 / R13 X13-1 closed list by
 * list). One older movement and two.
 */

beforeEach(() => {
  vi.stubGlobal("EventSource", class { close() {} } as unknown as typeof EventSource);
  signOut();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

const row = (id: string, at: string) => ledgerRowFixture({ id, at });
const page = (entries: unknown[], total: number) => ({ balance_minutes: 510, entries, total_entries: total, offset: 0, limit: 100 });

describe("Wallet — the last Show older", () => {
  it.each([
    ["one older movement", [row("w2", "2026-09-29T08:00:00Z")]],
    ["two older movements", [row("w2", "2026-09-29T08:00:00Z"), row("w3", "2026-09-28T08:00:00Z")]],
  ])("focuses the first movement it brought with %s", async (_name, older) => {
    const first = row("w1", "2026-09-30T08:00:00Z");
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet?limit=100", body: page([first], 1 + older.length) },
      { path: "/api/v1/wallet?limit=101", body: page([first, ...older], 1 + older.length) },
    ]);
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>);
    const button = await screen.findByRole("button", { name: showOlderLabel(older.length) }, { timeout: 5000 });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("button", { name: showOlderLabel(older.length) })).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toHaveAttribute("data-ledger-row", "w2");
  }, 30_000);
});
