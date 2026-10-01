import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TopUpPage from "./TopUp";
import TopUpStatusPage from "./TopUpStatus";
import { BalanceProvider } from "../lib/balance";
import { renderPage, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import { CANCEL_SAID, OPEN_CHECKOUTS, TOP_UP_SPLIT } from "../lib/topUpOpen";
import { formatMoney } from "../lib/utils";

/**
 * Review round 5, M5-2 (HIGH) — back from PayFast twice without paying, a member read "You've
 * topped up R1000.00, the most the club takes" with R0 paid, for up to an hour, and had nothing to
 * cancel. The page lists the checkouts still waiting, each with Cancel; the limit says paid and
 * waiting apart; the status page's Pending state offers Cancel. Every cancel ends on what the
 * club's record shows, a lost reply included.
 */
const OPTIONS = { block_zar: 100, min_zar: 100, max_zar: 1000, presets_zar: [100, 200, 500, 1000], conversion_rate: 1.6, rate_group: null };
const A = "aaaa0000-0000-0000-0000-000000000001";
const B = "bbbb0000-0000-0000-0000-000000000002";
const AT_A = "2026-10-01T12:05:00Z";
const AT_B = "2026-10-01T12:40:00Z";
const twoOpen = [
  { id: B, amount_zar: 800, created_at: AT_B, counts_until: "2026-10-01T13:40:00Z" },
  { id: A, amount_zar: 200, created_at: AT_A, counts_until: "2026-10-01T13:05:00Z" },
];
const held = { ...OPTIONS, already_zar: 1000, remaining_zar: 0, paid_zar: 0, waiting_zar: 1000, open_checkouts: twoOpen };
const freed = { ...OPTIONS, already_zar: 800, remaining_zar: 200, paid_zar: 0, waiting_zar: 800, open_checkouts: [twoOpen[0]] };
const status = (id: string, over: Record<string, unknown>) =>
  ({ id, status: "Pending", amount_zar: 200, conversion_rate: 1.6, failure_code: null, created_at: AT_A, ...over });

beforeEach(() => {
  vi.stubGlobal("EventSource", class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
  } as unknown as typeof EventSource);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

function showTopUp(routes: StubRoute[]) {
  const stub = stubFetch([...routes, { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) }]);
  renderPage(<TopUpPage />);
  return stub;
}

const rowFor = (amount: number) => screen.getByText(formatMoney(amount)).closest("li") as HTMLElement;

describe("Top-up — payments waiting on PayFast (M5-2)", () => {
  it("lists each open checkout with when it was started, and says the limit is held, not used", async () => {
    showTopUp([{ path: "/api/v1/credit/topup/options", body: held }]);
    expect(await screen.findByText(OPEN_CHECKOUTS.title)).toBeInTheDocument();
    expect(within(rowFor(800)).getByText(OPEN_CHECKOUTS.line(AT_B))).toBeInTheDocument();
    expect(within(rowFor(200)).getByText(OPEN_CHECKOUTS.line(AT_A))).toBeInTheDocument();
    expect(screen.getByText(TOP_UP_SPLIT.heldTitle)).toBeInTheDocument();
    expect(screen.getByText(TOP_UP_SPLIT.held(formatMoney(0), formatMoney(1000), formatMoney(1000)))).toBeInTheDocument();
    expect(screen.queryByText(/You've topped up/)).not.toBeInTheDocument();
  });

  it("words part of the limit as paid and waiting, never unpaid money as used", async () => {
    showTopUp([{ path: "/api/v1/credit/topup/options", body: freed }]);
    const parts = { paid: formatMoney(0), waiting: formatMoney(800) };
    expect(await screen.findByText(TOP_UP_SPLIT.limits(formatMoney(100), formatMoney(200), parts, formatMoney(1000), formatMoney(100)))).toBeInTheDocument();
    expect(screen.queryByText(/used\)/)).not.toBeInTheDocument();
  });

  it("cancels one, re-reads the club, and the freed amount is offered at once", async () => {
    let cancelled = false;
    const stub = showTopUp([
      {
        method: "POST", path: `/api/v1/credit/topup/${A}/cancel`,
        respond: () => { cancelled = true; return status(A, { status: "Cancelled", failure_code: "cancelled_at_return" }); },
      },
      { path: "/api/v1/credit/topup/options", respond: () => (cancelled ? freed : held) },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: OPEN_CHECKOUTS.cancelLabel(200, AT_A) }));
    expect(await screen.findByText(CANCEL_SAID.cancelled(200))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(OPEN_CHECKOUTS.line(AT_A))).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Continue to PayFast" })).toBeInTheDocument();
    // The list and the limit are the club's after the cancel, re-read — not this screen's guess.
    expect(stub.calls.filter((c) => c.path === "/api/v1/credit/topup/options").length).toBeGreaterThanOrEqual(2);
  });

  it("reads the record back when the cancel landed but its reply was lost, and says it landed", async () => {
    let landed = false;
    showTopUp([
      { method: "POST", path: `/api/v1/credit/topup/${A}/cancel`, respond: () => { landed = true; throw new TypeError("Failed to fetch"); } },
      { path: `/api/v1/credit/topup/${A}`, respond: () => status(A, landed ? { status: "Cancelled", failure_code: "cancelled_at_return" } : {}) },
      { path: "/api/v1/credit/topup/options", respond: () => (landed ? freed : held) },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: OPEN_CHECKOUTS.cancelLabel(200, AT_A) }));
    expect(await screen.findByText(CANCEL_SAID.lostLanded(200))).toBeInTheDocument();
    expect(landed).toBe(true);
  });

  it("says nothing was cancelled when the read-back still shows it waiting", async () => {
    showTopUp([
      { method: "POST", path: `/api/v1/credit/topup/${A}/cancel`, respond: () => { throw new TypeError("Failed to fetch"); } },
      { path: `/api/v1/credit/topup/${A}`, body: status(A, {}) },
      { path: "/api/v1/credit/topup/options", body: held },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: OPEN_CHECKOUTS.cancelLabel(200, AT_A) }));
    expect(await screen.findByText(CANCEL_SAID.lostStillWaiting)).toBeInTheDocument();
  });

  it("says the money moved when the payment completed before the cancel", async () => {
    showTopUp([
      { method: "POST", path: `/api/v1/credit/topup/${A}/cancel`, body: status(A, { status: "Completed" }) },
      { path: "/api/v1/credit/topup/options", body: held },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: OPEN_CHECKOUTS.cancelLabel(200, AT_A) }));
    expect(await screen.findByText(CANCEL_SAID.completed(200))).toBeInTheDocument();
  });
});

describe("Top-up status — Pending offers Cancel (M5-2)", () => {
  function showStatus(routes: StubRoute[]) {
    const stub = stubFetch([
      ...routes,
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    ]);
    renderPage(
      <BalanceProvider>
        <Routes><Route path="/wallet/topup/:topupId" element={<TopUpStatusPage />} /></Routes>
      </BalanceProvider>,
      { initialEntries: [`/wallet/topup/${A}`] },
    );
    return stub;
  }

  it("says when the payment was started and cancels it on the club's side", async () => {
    const stub = showStatus([
      { method: "POST", path: `/api/v1/credit/topup/${A}/cancel`, body: status(A, { status: "Cancelled", failure_code: "cancelled_at_return" }) },
      { path: `/api/v1/credit/topup/${A}`, body: status(A, {}) },
    ]);
    expect(await screen.findByText(OPEN_CHECKOUTS.line(AT_A))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: OPEN_CHECKOUTS.statusCancel }));
    expect(await screen.findByText(/You cancelled this payment, so nothing was charged/)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST" && c.path === `/api/v1/credit/topup/${A}/cancel`)).toBe(true);
  });
});
