import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { movementSentence } from "@/lib/movementCopy";
import WalletPage from "@/pages/Wallet";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "../shell/MinutesChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * R11 X11-1 — on /wallet ONE club movement raised TWO toasts worded differently: the chip's
 * "The club added 7 minutes to your wallet." and the page's "Xavi Adminworth added 7 minutes…".
 * The chip (mounted on every page, worded from the stream's reason) owns a movement the stream
 * brought; the page announces only what no stream frame told the chip (its own Refresh read).
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

const ROW = {
  id: "r7", at: "2026-10-03T08:00:00Z", from: "Club", to: "Thandi Probe",
  amountMinutes: 7, signedAmountMinutes: 7, type: "AdminAdjustment", comment: "Desk",
  subjectUserId: "44444444-4444-4444-4444-444444444444", subjectName: "Thandi Probe",
  actorUserId: "u-admin", actorName: "Xavi Adminworth", relatedBookingId: null,
};

function mount() {
  const whoami = signIn({ isAdmin: false });
  const club = { balance_minutes: 200, entries: [] as unknown[], total_entries: 0, offset: 0, limit: 100 };
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", respond: () => ({ ...club }) },
  ]);
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = {
    open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); },
  };
  render(
    <MemoryRouter initialEntries={["/wallet"]}>
      <AuthProvider>
        <BalanceProvider transport={transport}>
          <ToastProvider><MinutesChip /><WalletPage /></ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  const push = (f: BalanceFrame) => act(async () => { live?.onFrame(f); });
  return { club, push };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 120)); });

describe("R11 X11-1 — one announcement per wallet movement on /wallet", () => {
  it("a club adjustment the stream brings is said once, in the stream's words", async () => {
    const { club, push } = mount();
    await push({ balance_minutes: 200 });
    await settle();
    club.balance_minutes = 207; club.entries = [ROW]; club.total_entries = 1;
    await push({ balance_minutes: 207, delta_minutes: 7, reason: "admin_adjustment" });
    await settle(); await settle();
    const statuses = [...document.querySelectorAll("[role=status]")].map((n) => n.textContent ?? "");
    const money = statuses.filter((t) => /7 minutes/.test(t));
    expect(money).toHaveLength(1);
    expect(money[0]).toContain(movementSentence(7, "admin_adjustment"));
    expect(screen.queryByText(/Xavi Adminworth added/)).toBeNull();
  });

  it("a club take is said once too", async () => {
    const { club, push } = mount();
    await push({ balance_minutes: 200 });
    await settle();
    club.balance_minutes = 193; club.entries = [{ ...ROW, signedAmountMinutes: -7 }]; club.total_entries = 1;
    await push({ balance_minutes: 193, delta_minutes: -7, reason: "admin_adjustment" });
    await settle(); await settle();
    const money = [...document.querySelectorAll("[role=status]")].map((n) => n.textContent ?? "").filter((t) => /7 minutes/.test(t));
    expect(money).toEqual([movementSentence(-7, "admin_adjustment")].map((s) => expect.stringContaining(s)));
  });
});
