import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { api } from "@/lib/api";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { movementSentence, shareRowSentence } from "@/lib/walletCopy";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "./MinutesChip";
import { signIn, signOut, stubFetch, type StubRoute } from "../../test/harness";

/**
 * D4 — the chip's toast for a movement, measured in a headed walk against the real stack:
 * "The club took 50 min off your wallet." after the member's OWN booking (the stream's
 * frame overtook the booking's HTTP answer, so the "this was mine" mark came too late), and the
 * same sentence to a partner who had just accepted an invite — money that went to the organiser,
 * not the club. And the organiser, whose partner paid them, was told nothing about who.
 */

const ME = "44444444-4444-4444-4444-444444444444";
const SAM = "55555555-5555-5555-5555-555555555555";

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

function wire() {
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = {
    open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); },
  };
  return { transport, push: (f: BalanceFrame) => act(async () => { live?.onFrame(f); }) };
}

function mount(extra: StubRoute[] = []) {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_minutes: 200, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    ...extra,
  ]);
  const w = wire();
  render(
    <MemoryRouter>
      <AuthProvider>
        <BalanceProvider transport={w.transport}>
          <ToastProvider><MinutesChip /></ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return w;
}

/** Holds POSTs to the booking route until released, so a frame can land mid-request. */
function holdBookingPost() {
  const stubbed = globalThis.fetch;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    (String(input).startsWith("/api/v1/bookings/") && init?.method === "POST" ? gate.then(() => stubbed(input, init)) : stubbed(input, init)));
  return () => release();
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

describe("MinutesChip — whose movement it was", () => {
  it("raises no 'club' toast for the member's own booking, although its frame lands before the answer", async () => {
    const w = mount([{ method: "POST", path: "/api/v1/bookings/", body: { booking_id: "bk-1", balance_after_minutes: 150 } }]);
    await w.push({ balance_minutes: 200 });
    const release = holdBookingPost();
    let booking: Promise<unknown> = Promise.resolve();
    await act(async () => { booking = api.post("/api/v1/bookings/", { courtId: "c1" }); });
    // The server's frame for this very booking, before its HTTP answer.
    await w.push({ balance_minutes: 150, delta_minutes: -50, reason: "booking_charge" });
    release();
    await act(async () => { await booking; });
    await settle();
    expect(screen.queryByText(movementSentence(-50, "booking_charge"))).toBeNull();
    expect(screen.queryByText(/The club took/)).toBeNull();
  });

  it("still marks a frame that lands just AFTER the answer as the member's own", async () => {
    const w = mount([{ method: "POST", path: "/api/v1/invites/TOKEN/accept", body: { status: "accepted" } }]);
    await w.push({ balance_minutes: 200 });
    await act(async () => { await api.post("/api/v1/invites/TOKEN/accept", { expectedShareMinutes: 20 }); });
    await w.push({ balance_minutes: 180, delta_minutes: -20, reason: "share_transfer" });
    await settle();
    expect(screen.queryByText(/The club took|went on a share/)).toBeNull();
  });

  it("names the partner and the court when a partner pays the organiser", async () => {
    const w = mount([
      { path: "/api/v1/wallet?limit=5", body: {
        balance_minutes: 220, total_entries: 1, offset: 0, limit: 5,
        entries: [{
          id: "e1", at: "2026-09-29T10:00:00Z", from: "Sam Petersen", to: "Olivia", amountMinutes: 20, signedAmountMinutes: 20,
          type: "ShareTransfer", comment: "Share of a split booking", subjectUserId: ME, subjectName: "Olivia",
          actorUserId: SAM, actorName: "Sam Petersen", relatedBookingId: "b1",
        }],
      } },
      { path: "/api/v1/bookings/b1", body: {
        booking_id: "b1", court_name: "Court 1", starts_at: "2026-09-29T16:00:00Z",
        organiser: { user_id: ME, name: "Olivia Newton", photo_url: null },
        players: [{ kind: "member", user_id: SAM, name: "Sam Petersen", paid_minutes: 20 }],
      } },
    ]);
    await w.push({ balance_minutes: 200 });
    await w.push({ balance_minutes: 220, delta_minutes: 20, reason: "share_transfer" });
    const expected = shareRowSentence({
      side: "organiser", signed: 20, place: { courtName: "Court 1", startsAt: "2026-09-29T16:00:00Z" }, other: "Sam Petersen",
    });
    expect(expected).toBe("Sam paid you 20 minutes for their share of Court 1");
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(/The club/)).toBeNull();
  });

  it("words an unbidden movement by its reason, and keeps 'the club' for the club's own", async () => {
    const w = mount();
    await w.push({ balance_minutes: 200 });
    await w.push({ balance_minutes: 250, delta_minutes: 50, reason: "cancellation_refund" });
    expect(await screen.findByText(movementSentence(50, "cancellation_refund"))).toBeInTheDocument();
    await w.push({ balance_minutes: 350, delta_minutes: 100, reason: "admin_adjustment" });
    expect(await screen.findByText("The club added 1 hour 40 minutes to your wallet.")).toBeInTheDocument();
  });
});
