import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { ToastProvider } from "../Toast";
import { CreditsChip } from "./CreditsChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * M-1 (review round 3) — the flyout over the credits chip says the NET change the chip just made.
 *
 * <p>
 * A split booking's cancel lands as a burst of frames: the organiser's refund, then each partner's
 * share going back to them. The flyout read only the LAST frame's `delta_credits`, so the chip
 * counted 235 → 335 while the number floating over it said "−33.00" — the opposite direction.
 * </p>
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

function mount(startingBalance: number) {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_credits: startingBalance, entries: [], total_entries: 0, offset: 0, limit: 100 } },
  ]);
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = {
    open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); },
  };
  const view = render(
    <MemoryRouter>
      <AuthProvider>
        <BalanceProvider transport={transport}>
          <ToastProvider><CreditsChip /></ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  const push = (f: BalanceFrame) => act(async () => { live?.onFrame(f); });
  const flyout = () => view.container.querySelector("[data-balance-flyout]")?.textContent ?? null;
  return { push, flyout };
}

describe("CreditsChip — the flyout", () => {
  it("shows the net of a burst of frames, not the last frame's delta", async () => {
    const chip = mount(235);
    await chip.push({ balance_credits: 235 });
    // Refund of the whole court to the organiser, then a partner's share handed back to them.
    await chip.push({ balance_credits: 368, delta_credits: 133, reason: "cancellation_refund" });
    await chip.push({ balance_credits: 335, delta_credits: -33, reason: "share_transfer" });
    expect(chip.flyout()).toBe("+100.00");
  });

  it("shows a single movement as itself", async () => {
    const chip = mount(200);
    await chip.push({ balance_credits: 200 });
    await chip.push({ balance_credits: 150, delta_credits: -50, reason: "booking_charge" });
    expect(chip.flyout()).toBe("−50.00");
  });

  it("starts a new burst once the last one has settled", async () => {
    const chip = mount(200);
    await chip.push({ balance_credits: 200 });
    await chip.push({ balance_credits: 150, delta_credits: -50, reason: "booking_charge" });
    await act(async () => { await new Promise((r) => setTimeout(r, 1_700)); });
    expect(chip.flyout()).toBeNull();
    await chip.push({ balance_credits: 170, delta_credits: 20, reason: "share_transfer" });
    expect(chip.flyout()).toBe("+20.00");
  });

  it("says nothing when the burst nets to nothing the chip shows", async () => {
    const chip = mount(200);
    await chip.push({ balance_credits: 200 });
    await chip.push({ balance_credits: 250, delta_credits: 50, reason: "cancellation_refund" });
    await chip.push({ balance_credits: 200, delta_credits: -50, reason: "share_transfer" });
    expect(chip.flyout()).toBeNull();
  });
});
