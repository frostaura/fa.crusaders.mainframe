import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TopUpStatusPage from "./TopUpStatus";
import { BalanceProvider } from "../lib/balance";
import { renderPage, signIn, signOut, stubFetch, unreachable, type StubRoute } from "../test/harness";

/**
 * R4 M4-1 (the page's half) — a cancelled or abandoned PayFast checkout used up the member's
 * top-up limit for ever: PayFast sends no ITN for a cancel, so the row stayed Pending, and the
 * cancel return only changed the screen. The page now tells the club
 * (`POST /credit/topup/{id}/cancel`), reads the row back when that reply is lost, and words a
 * checkout the club closed itself (`expired`) as what it is — not "You cancelled".
 */
const ID = "eeee1111-0000-0000-0000-000000000042";
const row = (over: Record<string, unknown>) => ({ id: ID, status: "Pending", amount_zar: 200, conversion_rate: 1, failure_code: null, ...over });

beforeEach(() => {
  vi.stubGlobal("EventSource", class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
  } as unknown as typeof EventSource);
});
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

function show(routes: StubRoute[], search = "?cancelled=1") {
  const stub = stubFetch([
    ...routes,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
  ]);
  renderPage(
    <BalanceProvider>
      <Routes><Route path="/wallet/topup/:topupId" element={<TopUpStatusPage />} /></Routes>
    </BalanceProvider>,
    { initialEntries: [`/wallet/topup/${ID}${search}`] },
  );
  return stub;
}

const topupCalls = (stub: ReturnType<typeof stubFetch>) =>
  stub.calls.filter((c) => c.path.startsWith(`/api/v1/credit/topup/${ID}`)).map((c) => `${c.method} ${c.path.replace(`/api/v1/credit/topup/${ID}`, "")}`);

describe("Top-up status — the cancel return is told to the club (M4-1)", () => {
  it("closes the checkout on the club's side and shows the club's answer", async () => {
    const stub = show([
      { method: "POST", path: `/api/v1/credit/topup/${ID}/cancel`, body: row({ status: "Cancelled", failure_code: "cancelled_at_return" }) },
      { path: `/api/v1/credit/topup/${ID}`, body: row({}) },
    ]);
    expect(await screen.findByText(/You cancelled this payment, so nothing was charged/)).toBeInTheDocument();
    expect(topupCalls(stub)).toEqual(["POST /cancel"]);
  });

  it("reads the row back when the cancel's reply is lost, and believes what it finds", async () => {
    const stub = show([
      unreachable(`/api/v1/credit/topup/${ID}/cancel`, "POST"),
      // The ITN had landed first: the money moved, and the page says so.
      { path: `/api/v1/credit/topup/${ID}`, body: row({ status: "Completed" }) },
    ]);
    expect(await screen.findByText("Your wallet has been credited.")).toBeInTheDocument();
    expect(topupCalls(stub)).toEqual(["POST /cancel", "GET "]);
  });

  it("answers a completion that landed before the cancel as a completion", async () => {
    show([
      { method: "POST", path: `/api/v1/credit/topup/${ID}/cancel`, body: row({ status: "Completed" }) },
      { path: `/api/v1/credit/topup/${ID}`, body: row({ status: "Completed" }) },
    ]);
    expect(await screen.findByText("Your wallet has been credited.")).toBeInTheDocument();
    expect(screen.queryByText(/You cancelled/)).toBeNull();
  });

  it("reads a 404 on the cancel back — a server without the route is not a missing top-up", async () => {
    show([
      { method: "POST", path: `/api/v1/credit/topup/${ID}/cancel`, status: 404, body: null },
      { path: `/api/v1/credit/topup/${ID}`, body: row({}) },
    ]);
    // The row is there and still Pending: on the cancel return that is the member's own cancel.
    expect(await screen.findByText(/You cancelled this payment, so nothing was charged/)).toBeInTheDocument();
  });

  it("says no such top-up when the read back is a 404 too", async () => {
    show([
      { method: "POST", path: `/api/v1/credit/topup/${ID}/cancel`, status: 404, body: null },
      { path: `/api/v1/credit/topup/${ID}`, status: 404, body: null },
    ]);
    expect(await screen.findByText(/We can't find this top-up on your account/)).toBeInTheDocument();
  });

  it("does not tell the club anything without the cancel flag", async () => {
    const stub = show([{ path: `/api/v1/credit/topup/${ID}`, body: row({ status: "Completed" }) }], "");
    await screen.findByText("Your wallet has been credited.");
    expect(topupCalls(stub)).toEqual(["GET "]);
  });
});

describe("Top-up status — a checkout the club closed because nothing came back (M4-1)", () => {
  it("says it was never finished, not that the member cancelled it", async () => {
    show([{ path: `/api/v1/credit/topup/${ID}`, body: row({ status: "Cancelled", failure_code: "expired" }) }], "");
    expect(await screen.findByText("This payment was never finished, so nothing was charged and no credits were added.")).toBeInTheDocument();
    expect(screen.queryByText(/You cancelled/)).toBeNull();
    expect(screen.getByRole("link", { name: "Try again" })).toBeInTheDocument();
  });
});
