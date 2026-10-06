import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "./MinutesChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * M-1 (review round 3) — the flyout over the minutes chip says the NET change the chip just made.
 *
 * <p>
 * A split booking's cancel lands as a burst of frames: the organiser's refund, then each partner's
 * share going back to them. The flyout read only the LAST frame's `delta_minutes`, so the chip
 * counted 235 → 335 while the number floating over it said "−33" — the opposite direction.
 * </p>
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

function mount(startingBalance: number) {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_minutes: startingBalance, entries: [], total_entries: 0, offset: 0, limit: 100 } },
  ]);
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = {
    open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); },
  };
  const view = render(
    <MemoryRouter>
      <AuthProvider>
        <BalanceProvider transport={transport}>
          <ToastProvider><MinutesChip /></ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  const push = (f: BalanceFrame) => act(async () => { live?.onFrame(f); });
  // R19 L19-2 — the paint glues each figure to its unit (no-break spaces); the words are compared plain.
  const flyout = () => view.container.querySelector("[data-balance-flyout]")?.textContent?.replace(/\u00a0/g, " ") ?? null;
  return { push, flyout };
}

describe("MinutesChip — the flyout", () => {
  it("shows the net of a burst of frames, not the last frame's delta", async () => {
    const chip = mount(235);
    await chip.push({ balance_minutes: 235 });
    // Refund of the whole court to the organiser, then a partner's share handed back to them.
    await chip.push({ balance_minutes: 368, delta_minutes: 133, reason: "cancellation_refund" });
    await chip.push({ balance_minutes: 335, delta_minutes: -33, reason: "share_transfer" });
    expect(chip.flyout()).toBe("+1 h 40 min");
  });

  it("shows a single movement as itself", async () => {
    const chip = mount(200);
    await chip.push({ balance_minutes: 200 });
    await chip.push({ balance_minutes: 150, delta_minutes: -50, reason: "booking_charge" });
    expect(chip.flyout()).toBe("−50 min");
  });

  it("starts a new burst once the last one has settled", async () => {
    const chip = mount(200);
    await chip.push({ balance_minutes: 200 });
    await chip.push({ balance_minutes: 150, delta_minutes: -50, reason: "booking_charge" });
    await act(async () => { await new Promise((r) => setTimeout(r, 1_700)); });
    expect(chip.flyout()).toBeNull();
    await chip.push({ balance_minutes: 170, delta_minutes: 20, reason: "share_transfer" });
    expect(chip.flyout()).toBe("+20 min");
  });

  it("says nothing when the burst nets to nothing the chip shows", async () => {
    const chip = mount(200);
    await chip.push({ balance_minutes: 200 });
    await chip.push({ balance_minutes: 250, delta_minutes: 50, reason: "cancellation_refund" });
    await chip.push({ balance_minutes: 200, delta_minutes: -50, reason: "share_transfer" });
    expect(chip.flyout()).toBeNull();
  });
});
