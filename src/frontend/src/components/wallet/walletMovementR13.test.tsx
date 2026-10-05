import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "../shell/MinutesChip";
import { signIn, signOut, stubFetch, type StubRoute } from "../../test/harness";

/**
 * R13 — the chip's money toasts, through the real chip (lane FC13).
 * X13-2: the organiser's club-cancel toast named nobody and said "partners" for one.
 * X13-3: the partner's toast on a club cancel did not say the club cancelled (the frame says so).
 * J13-4: a member the club took off a game got "A share of a split booking moved 10 minutes…".
 */

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); signOut(); localStorage.clear(); });

const ME = "44444444-4444-4444-4444-444444444444";
const OLIVIA = "77777777-7777-7777-7777-777777777777";
const BOOKING = "b0000000-0000-0000-0000-0000000000c4";

function mount(extra: StubRoute[] = []) {
  const whoami = signIn({ isAdmin: false });
  const club = { balance_minutes: 200, entries: [] as unknown[], total_entries: 0, offset: 0, limit: 100 };
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    ...extra,
    { path: "/api/v1/wallet", respond: () => ({ ...club }) },
  ]);
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = {
    open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); },
  };
  render(
    <MemoryRouter initialEntries={["/bookings"]}>
      <AuthProvider>
        <BalanceProvider transport={transport}>
          <ToastProvider><MinutesChip /></ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  const push = (f: BalanceFrame) => act(async () => { live?.onFrame(f); });
  return { club, push };
}

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const toasts = () => [...document.querySelectorAll("[role=status]")].map((n) => n.textContent ?? "").filter((t) => /minute/.test(t));

/** The partner's share row as the wallet's newest entries carry it (r13e13/frames-par.jsonl's +7). */
const shareBack = (n: number) => ({
  id: "r1", at: "2026-10-05T08:39:32Z", from: "Olivia Organiser", to: "Sam Partner", amountMinutes: n, signedAmountMinutes: n,
  type: "ShareTransfer", comment: "Share of a split booking", subjectUserId: ME, subjectName: "Sam Partner",
  actorUserId: OLIVIA, actorName: "Olivia Organiser", relatedBookingId: BOOKING,
});

describe("R13 X13-2 — the organiser's club-cancel toast names each partner", () => {
  it("two partners named: one toast, each by name and figure", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({
      balance_minutes: 216, delta_minutes: 16, reason: "cancellation_refund", cancelled_by: "club",
      parts: [
        { reason: "cancellation_refund", delta_minutes: 30 },
        { reason: "share_transfer", delta_minutes: -7, counterparty_name: "Sam Partner" },
        { reason: "share_transfer", delta_minutes: -7, counterparty_name: "Nomsa Dube" },
      ],
    });
    await wait(400);
    expect(toasts()).toEqual([
      "The club cancelled your booking: 30 minutes came back, 7 minutes went back to Sam and 7 minutes to Nomsa for their shares, so 16 minutes came back to your wallet.",
    ]);
  }, 15_000);

  it("one partner named: singular", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({
      balance_minutes: 223, delta_minutes: 23, reason: "cancellation_refund", cancelled_by: "club",
      parts: [{ reason: "cancellation_refund", delta_minutes: 30 }, { reason: "share_transfer", delta_minutes: -7, counterparty_name: "Sam Partner" }],
    });
    await wait(400);
    const said = toasts();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("7 minutes went back to Sam for their share,");
    expect(said[0]).not.toMatch(/partners|shares/);
  }, 15_000);
});

describe("R13 X13-3 — the partner is told the club cancelled", () => {
  it("cancelled_by club on the partner's share frame: named and says the club cancelled", async () => {
    const detail = {
      booking_id: BOOKING, court_name: "Court 4", starts_at: "2030-10-05T10:00:00Z",
      organiser: { user_id: OLIVIA, name: "Olivia Organiser", photo_url: null }, players: [],
    };
    const { club, push } = mount([{ path: `/api/v1/bookings/${BOOKING}`, body: detail }]);
    await push({ balance_minutes: 286 });
    await wait(120);
    club.balance_minutes = 293; club.entries = [shareBack(7)]; club.total_entries = 1;
    await push({
      balance_minutes: 293, delta_minutes: 7, reason: "share_transfer", parts: [{ reason: "share_transfer", delta_minutes: 7 }],
      share_cause: "booking_cancelled", cancelled_by: "club", checked_in_by_name: null,
    });
    await wait(600);
    expect(toasts()).toEqual(["7 minutes of your share of Court 4 came back — the club cancelled the booking"]);
  }, 15_000);

  it("the plain sentence (booking unreadable) says it too", async () => {
    const { club, push } = mount([{ path: `/api/v1/bookings/${BOOKING}`, status: 404, body: { error: "booking_not_found" } }]);
    await push({ balance_minutes: 286 });
    await wait(120);
    club.balance_minutes = 293; club.entries = [shareBack(7)]; club.total_entries = 1;
    await push({ balance_minutes: 293, delta_minutes: 7, reason: "share_transfer", share_cause: "booking_cancelled", cancelled_by: "club" });
    await wait(600);
    expect(toasts()).toEqual(["7 minutes of your share of a split booking came back — the club cancelled the booking."]);
  }, 15_000);
});

describe("R13 J13-4 — a member taken off a game is told their share came back", () => {
  it("the booking 404s for them: 'your share … came back — the club took you off the game'", async () => {
    const { club, push } = mount([{ path: `/api/v1/bookings/${BOOKING}`, status: 404, body: { error: "booking_not_found" } }]);
    await push({ balance_minutes: 290 });
    await wait(120);
    club.balance_minutes = 300; club.entries = [shareBack(10)]; club.total_entries = 1;
    await push({ balance_minutes: 300, delta_minutes: 10, reason: "share_transfer", share_cause: "club_removed" });
    await wait(600);
    const said = toasts();
    expect(said).toHaveLength(1);
    expect(said[0]).toBe("10 minutes of your share of a split booking came back — the club took you off the game.");
    expect(said[0]).not.toMatch(/^A share of a split booking moved/);
  }, 15_000);
});

describe("R13 E13-5 (contract C13-2) — one toast for a sweep or a reversal on a shared booking", () => {
  it("no-show sweep, organiser: one frame, one toast; the share is not the penalty", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({
      balance_minutes: 205, delta_minutes: 5, reason: "no_show_settled",
      parts: [{ reason: "cancellation_refund", delta_minutes: 15 }, { reason: "penalty", delta_minutes: -4 }, { reason: "share_transfer", delta_minutes: -6 }],
      share_cause: "no_show", share_kept_minutes: 1, cancelled_by: null, checked_in_by_name: null,
    });
    await wait(1_300);
    expect(toasts()).toEqual([
      "A missed booking was settled: 15 minutes refunded and 4 minutes charged as a no-show penalty, 6 minutes went back to your partner for their share, so 5 minutes came back to your wallet.",
    ]);
  }, 15_000);

  it("outage refund reversed by the partner's scan: one toast naming them, never 'you were checked in'", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({
      balance_minutes: 192, delta_minutes: -8, reason: "outage_refund_reversed",
      parts: [{ reason: "cancellation_refund", delta_minutes: -15 }, { reason: "share_transfer", delta_minutes: 7 }],
      share_cause: "attended", checked_in_by_name: "Pat Partner", cancelled_by: null,
    });
    await wait(1_300);
    const said = toasts();
    expect(said).toHaveLength(1);
    expect(said[0]).toBe("Pat Partner checked in, so the outage refund was taken back: the 15 minutes refund was taken back, 7 minutes came back from your partner for their share, so 8 minutes left your wallet.");
  }, 15_000);
});
