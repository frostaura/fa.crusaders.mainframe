import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { flyoutHeldNote } from "@/lib/walletCopy";
import { minutesSigned } from "@/lib/minutes";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "./MinutesChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * R18 E18-12 — measured: the chip's flyout said "−11" (the spendable figure, which held minutes
 * leave) while the toast said "5 minutes left your wallet" — six minutes unexplained. Where the two
 * differ the flyout now says the difference went into (or came out of) what is held.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

async function mount(balance: number) {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_minutes: balance, entries: [], total_entries: 0, offset: 0, limit: 100 } },
  ]);
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = { open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); } };
  const view = render(
    <MemoryRouter>
      <AuthProvider>
        <BalanceProvider transport={transport}>
          <ToastProvider><MinutesChip /></ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  // The stream opens after the first read: a frame pushed before it would be dropped.
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return {
    push: (f: BalanceFrame) => act(async () => { live?.onFrame(f); }),
    flyout: () => view.container.querySelector("[data-balance-flyout]")?.textContent ?? null,
  };
}

describe("MinutesChip — the flyout explains held minutes (R18 E18-12)", () => {
  it("wallet −5, spendable −11: '−11 min · 6 min held'", async () => {
    const chip = await mount(200);
    await chip.push({ balance_minutes: 200, held_minutes: 0, spendable_minutes: 200 });
    await chip.push({ balance_minutes: 195, delta_minutes: -5, reason: "share_transfer", held_minutes: 6, spendable_minutes: 189 });
    expect(chip.flyout()).toBe(`${minutesSigned(-11)} · ${flyoutHeldNote("6 min", true)}`);
  });

  it("held minutes released: the spendable figure rises more than the wallet — '… freed'", async () => {
    const chip = await mount(200);
    await chip.push({ balance_minutes: 200, held_minutes: 30, spendable_minutes: 170 });
    await chip.push({ balance_minutes: 210, delta_minutes: 10, reason: "admin_adjustment", held_minutes: 0, spendable_minutes: 210 });
    expect(chip.flyout()).toBe(`${minutesSigned(40)} · ${flyoutHeldNote("30 min", false)}`);
  });

  it("nothing held moved: the flyout is the figure alone", async () => {
    const chip = await mount(200);
    await chip.push({ balance_minutes: 200 });
    await chip.push({ balance_minutes: 150, delta_minutes: -50, reason: "booking_charge" });
    expect(chip.flyout()).toBe(minutesSigned(-50));
  });
});
