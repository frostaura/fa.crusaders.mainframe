import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "../shell/MinutesChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * R12 — the chip's money toasts.
 * X12-1: the club cancelled a shared booking and the organiser got two toasts ("put 30 minutes
 * back", then "15 minutes went back to a partner"). Contract C1: one frame, its `parts` and the
 * net, `cancelled_by`; an older server's two frames inside a second are merged into one sentence.
 * E12-2: a partner's late scan reversed the no-show and the organiser read "you were checked in
 * after all" — contract C2's `checked_in_by_name` names the scanner.
 * X12-3: a partner withdrew; the organiser's toast said "a partner" with no reason.
 */

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); signOut(); localStorage.clear(); });

const ME = "44444444-4444-4444-4444-444444444444";
const BOOKING = "b0000000-0000-0000-0000-0000000000b1";
const PRIYA = "55555555-5555-5555-5555-555555555555";

function mount(extra: { path: string; body: unknown }[] = []) {
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

describe("R12 X12-1 — one toast for a cancelled shared booking", () => {
  it("contract C1: one frame with parts says the club cancelled, both rows and the net", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({
      balance_minutes: 215, delta_minutes: 15, reason: "cancellation_refund", cancelled_by: "club",
      parts: [{ reason: "cancellation_refund", delta_minutes: 30 }, { reason: "share_transfer", delta_minutes: -15 }],
    });
    await wait(1_300);
    const said = toasts();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("The club cancelled your booking");
    expect(said[0]).toContain("30 minutes came back");
    expect(said[0]).toContain("15 minutes went back to your partner for their share,");
    expect(said[0]).toContain("so 15 minutes came back to your wallet");
  }, 15_000);

  it("an older server's two frames 70 ms apart are said as one sentence", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 230, delta_minutes: 30, reason: "cancellation_refund" });
    await wait(70);
    await push({ balance_minutes: 215, delta_minutes: -15, reason: "share_transfer", share_cause: "booking_cancelled" });
    await wait(1_500);
    const said = toasts();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("30 minutes came back");
    expect(said[0]).toContain("15 minutes went back to your partner for their share,");
    expect(said[0]).toContain("so 15 minutes came back to your wallet");
  }, 15_000);

  it("a lone cancellation refund is still said, once", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 230, delta_minutes: 30, reason: "cancellation_refund", cancelled_by: "member" });
    await wait(1_500);
    expect(toasts()).toEqual([expect.stringContaining("A cancelled booking put 30 minutes back in your wallet.")]);
  }, 15_000);
});

describe("R12 E12-2 — a reversal names who checked in", () => {
  const parts = [{ reason: "penalty", delta_minutes: 4 }, { reason: "cancellation_refund", delta_minutes: -15 }];
  it("checked_in_by_name set: the scanner is named, never 'you were checked in'", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 189, delta_minutes: -11, reason: "no_show_reversed", parts, checked_in_by_name: "Dan Splitter" });
    await wait(400);
    const said = toasts();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Dan Splitter checked in");
    expect(said[0]).not.toMatch(/you were checked in/);
  }, 15_000);

  it("an outage refund reversed by a partner's scan names them too", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 170, delta_minutes: -30, reason: "outage_refund_reversed", checked_in_by_name: "Dan Splitter" });
    await wait(400);
    expect(toasts()[0]).toContain("Dan Splitter checked in");
    expect(toasts()[0]).not.toMatch(/you were checked in/);
  }, 15_000);

  it("null: their own scan — 'you were checked in after all'", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 189, delta_minutes: -11, reason: "no_show_reversed", parts, checked_in_by_name: null });
    await wait(400);
    expect(toasts()[0]).toMatch(/you were checked in after all/);
  }, 15_000);
});

describe("R12 X12-3 — a partner withdrew", () => {
  it("the organiser's toast names the partner who left and says why", async () => {
    const row = {
      id: "r9", at: "2026-10-03T08:00:00Z", from: "Thandi Probe", to: "Priya Partnerly",
      amountMinutes: 15, signedAmountMinutes: -15, type: "ShareTransfer", comment: "",
      subjectUserId: ME, subjectName: "Thandi Probe", actorUserId: PRIYA, actorName: "Priya Partnerly", relatedBookingId: BOOKING,
    };
    const detail = {
      booking_id: BOOKING, court_name: "Court 1", starts_at: "2030-09-10T16:00:00Z",
      organiser: { user_id: ME, name: "Thandi Probe", photo_url: null }, players: [],
    };
    const { club, push } = mount([{ path: `/api/v1/bookings/${BOOKING}`, body: detail }]);
    await push({ balance_minutes: 200 });
    await wait(120);
    club.balance_minutes = 185; club.entries = [row]; club.total_entries = 1;
    await push({ balance_minutes: 185, delta_minutes: -15, reason: "share_transfer", share_cause: "share_returned" });
    await wait(600);
    const said = toasts();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Priya");
    expect(said[0]).toMatch(/withdrew/);
  }, 15_000);
});
