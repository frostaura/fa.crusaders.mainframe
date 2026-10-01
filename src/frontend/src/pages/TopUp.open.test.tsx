import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import BuyMinutesPage from "./TopUp";
import BuyMinutesStatusPage from "./TopUpStatus";
import { BalanceProvider } from "../lib/balance";
import { refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import { CANCEL_SAID, OPEN_CHECKOUTS } from "../lib/topUpOpen";
import { minutesShelf, openCheckout, purchaseStatus } from "../test/minutesFixtures";

/**
 * Review round 5, M5-2, carried into P13 — purchases started at PayFast and never finished. The
 * shelf lists them (`open_checkouts`), each with Cancel; the status page's waiting state offers
 * Cancel too. Every cancel ends on what the club's record shows, a lost reply included. With the
 * cap gone (§3.6) nothing here talks about a limit.
 */
const A = "aaaa0000-0000-0000-0000-000000000001";
const B = "bbbb0000-0000-0000-0000-000000000002";
const AT_A = "2026-10-01T12:05:00Z";
const AT_B = "2026-10-01T12:40:00Z";
const ten = openCheckout({ id: B, package_name: "10 hours", minutes: 600, amount_zar: 1000, created_at: AT_B, expires_at: "2026-10-01T13:40:00Z" });
const one = openCheckout({ id: A, package_name: "1 hour", minutes: 60, amount_zar: 120, created_at: AT_A, expires_at: "2026-10-01T13:05:00Z" });
const both = minutesShelf({ open_checkouts: [ten, one] });
const onlyTen = minutesShelf({ open_checkouts: [ten] });
const SHELF = "/api/v1/minutes/packages";
const cancelPath = (id: string) => `/api/v1/minutes/purchase/${id}/cancel`;
const statusPath = (id: string) => `/api/v1/minutes/purchase/${id}`;

beforeEach(() => {
  vi.stubGlobal("EventSource", class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
  } as unknown as typeof EventSource);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

function showShelf(routes: StubRoute[]) {
  const stub = stubFetch([...routes, { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) }]);
  renderPage(<BuyMinutesPage />);
  return stub;
}

const cancelOne = () => screen.findByRole("button", { name: OPEN_CHECKOUTS.cancelLabel(one) });

describe("Buy minutes — purchases waiting on PayFast", () => {
  it("lists each open purchase by package, minutes and rand, with when it started and when it closes", async () => {
    showShelf([{ path: SHELF, body: both }]);
    const list = await screen.findByRole("region", { name: OPEN_CHECKOUTS.title });
    const row = within(list).getByText("1 hour (1 h) for R120.00").closest("li") as HTMLElement;
    expect(within(row).getByText(OPEN_CHECKOUTS.line(AT_A))).toBeInTheDocument();
    expect(within(row).getByText(OPEN_CHECKOUTS.expires(one.expires_at))).toBeInTheDocument();
    expect(within(list).getByText("10 hours (10 h) for R1000.00")).toBeInTheDocument();
    expect(list.textContent).not.toMatch(/limit|credit/i);
  });

  it("draws nothing when nothing is waiting", async () => {
    showShelf([{ path: SHELF, body: minutesShelf() }]);
    await screen.findByRole("radio", { name: "5 hours" });
    expect(screen.queryByRole("region", { name: OPEN_CHECKOUTS.title })).toBeNull();
  });

  it("takes the row away at once (optimistic), cancels it on the club's side and re-reads the shelf", async () => {
    let cancelled = false;
    const stub = showShelf([
      { method: "POST", path: cancelPath(A), respond: () => { cancelled = true; return purchaseStatus({ id: A, status: "Cancelled", failure_code: "cancelled_at_return" }); } },
      { path: SHELF, respond: () => (cancelled ? onlyTen : both) },
    ]);
    fireEvent.click(await cancelOne());
    // Gone before the club answers — the press is the member's word, and a failure puts it back.
    expect(screen.queryByText("1 hour (1 h) for R120.00")).toBeNull();
    expect(await screen.findByText(CANCEL_SAID.cancelled)).toBeInTheDocument();
    await waitFor(() => expect(stub.calls.filter((c) => c.path === SHELF).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText("10 hours (10 h) for R1000.00")).toBeInTheDocument();
  });

  it("puts the row back and says why when the club refuses", async () => {
    showShelf([
      { method: "POST", path: cancelPath(A), status: 500, body: { error: "boom" } },
      { path: statusPath(A), body: purchaseStatus({ id: A }) },
      { path: SHELF, body: both },
    ]);
    fireEvent.click(await cancelOne());
    expect(await screen.findByText(CANCEL_SAID.lostStillWaiting)).toBeInTheDocument();
    expect(await cancelOne()).toBeInTheDocument();
  });

  it("reads the record back when the cancel landed but its reply was lost, and says it landed", async () => {
    let landed = false;
    showShelf([
      { method: "POST", path: cancelPath(A), respond: () => { landed = true; throw new TypeError("Failed to fetch"); } },
      { path: statusPath(A), respond: () => purchaseStatus(landed ? { id: A, status: "Cancelled", failure_code: "cancelled_at_return" } : { id: A }) },
      { path: SHELF, respond: () => (landed ? onlyTen : both) },
    ]);
    fireEvent.click(await cancelOne());
    expect(await screen.findByText(CANCEL_SAID.lostLanded)).toBeInTheDocument();
    expect(landed).toBe(true);
  });

  it("says it cannot tell when neither the cancel nor the read-back answers", async () => {
    showShelf([
      { method: "POST", path: cancelPath(A), respond: () => { throw new TypeError("Failed to fetch"); } },
      { path: statusPath(A), respond: () => refuse(503, {}) },
      { path: SHELF, body: both },
    ]);
    fireEvent.click(await cancelOne());
    expect(await screen.findByText(CANCEL_SAID.lostUnknown)).toBeInTheDocument();
  });

  it("says the minutes landed when the payment completed before the cancel", async () => {
    showShelf([
      { method: "POST", path: cancelPath(A), body: purchaseStatus({ id: A, status: "Completed", minutes: 60 }) },
      { path: SHELF, body: both },
    ]);
    fireEvent.click(await cancelOne());
    expect(await screen.findByText(CANCEL_SAID.completed(60))).toBeInTheDocument();
    expect(CANCEL_SAID.completed(60)).toContain("1 h are in your wallet");
  });
});

describe("Purchase status — waiting offers Cancel (M5-2)", () => {
  function showStatus(routes: StubRoute[]) {
    const stub = stubFetch([
      ...routes,
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    ]);
    renderPage(
      <BalanceProvider>
        <Routes><Route path="/wallet/buy/:purchaseId" element={<BuyMinutesStatusPage />} /></Routes>
      </BalanceProvider>,
      { initialEntries: [`/wallet/buy/${A}`] },
    );
    return stub;
  }

  it("says when the payment was started and cancels it on the club's side", async () => {
    const stub = showStatus([
      { method: "POST", path: cancelPath(A), body: purchaseStatus({ id: A, created_at: AT_A, status: "Cancelled", failure_code: "cancelled_at_return" }) },
      { path: statusPath(A), body: purchaseStatus({ id: A, created_at: AT_A }) },
    ]);
    expect(await screen.findByText(OPEN_CHECKOUTS.line(AT_A))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: OPEN_CHECKOUTS.statusCancel }));
    expect(await screen.findByText(/You cancelled this payment, so nothing was charged/)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST" && c.path === cancelPath(A))).toBe(true);
  });
});
