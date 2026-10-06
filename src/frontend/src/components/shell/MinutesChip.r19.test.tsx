import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { flyoutBackNote, flyoutHeldNote } from "@/lib/walletCopy";
import { minutesSigned } from "@/lib/minutes";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "./MinutesChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * R19 L19-4 — the chip's flyout says where the minutes the chip did not show went.
 *
 * <ul>
 *   <li>A partner's share that lands wholly in "held" moves the wallet but not the spendable figure,
 *   so the flyout said nothing at all: it now says "10 min held".</li>
 *   <li>A cancel whose partners' shares went back to them called those minutes "freed" — the toast
 *   says they "went back to Sam for their share". The flyout now says the same ("15 min back to Sam").</li>
 * </ul>
 *
 * L19-2 — the flyout hangs UNDER the chip, anchored to its right edge, and wraps: centred over the
 * chip and nowrap, it ran 37px past a 1024 / 150 % screen and over the avatar, at y < 0.
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
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const node = () => view.container.querySelector<HTMLElement>("[data-balance-flyout]");
  return {
    push: (f: BalanceFrame) => act(async () => { live?.onFrame(f); }),
    node,
    /** The painted words, no-break spaces read as spaces (the paint glues figures to their units). */
    flyout: () => node()?.textContent?.replace(/\u00a0/g, " ") ?? null,
  };
}

const plain = (s: string) => s.replace(/\u00a0/g, " ");

describe("MinutesChip — an incoming share that is only held (R19 L19-4)", () => {
  it("one partner's 10 min, all held: '10 min held', no spendable figure to show", async () => {
    const chip = await mount(200);
    await chip.push({ balance_minutes: 200, held_minutes: 0, spendable_minutes: 200 });
    await chip.push({
      balance_minutes: 210, delta_minutes: 10, reason: "share_transfer", held_minutes: 10, spendable_minutes: 200,
      parts: [{ reason: "share_transfer", delta_minutes: 10, counterparty_name: "Sam Naidoo" }],
    });
    expect(chip.flyout()).toBe(plain(flyoutHeldNote("10 min", true)));
  });

  it("two partners' shares in one frame, all held: '20 min held'", async () => {
    const chip = await mount(200);
    await chip.push({ balance_minutes: 200, held_minutes: 5, spendable_minutes: 195 });
    await chip.push({
      balance_minutes: 220, delta_minutes: 20, reason: "share_transfer", held_minutes: 25, spendable_minutes: 195,
      parts: [
        { reason: "share_transfer", delta_minutes: 10, counterparty_name: "Sam Naidoo" },
        { reason: "share_transfer", delta_minutes: 10, counterparty_name: "Alex Petersen" },
      ],
    });
    expect(chip.flyout()).toBe(plain(flyoutHeldNote("20 min", true)));
  });
});

describe("MinutesChip — shares that went back on a cancel are not 'freed' (R19 L19-4)", () => {
  it("one named partner: '+1 h · 15 min back to Sam', as the toast says it", async () => {
    const chip = await mount(155);
    await chip.push({ balance_minutes: 155, held_minutes: 15, spendable_minutes: 140 });
    await chip.push({
      balance_minutes: 200, delta_minutes: 45, reason: "cancellation_refund", held_minutes: 0, spendable_minutes: 200,
      parts: [
        { reason: "cancellation_refund", delta_minutes: 60 },
        { reason: "share_transfer", delta_minutes: -15, counterparty_name: "Sam Naidoo" },
      ],
    });
    expect(chip.flyout()).toBe(`${minutesSigned(60)} · ${plain(flyoutBackNote("15 min", ["Sam Naidoo"]))}`);
    expect(chip.flyout()).not.toMatch(/freed/);
    expect(flyoutBackNote("15 min", ["Sam Naidoo"])).toMatch(/back to Sam$/);
  });

  it("two partners: '… 30 min back to your partners'", async () => {
    const chip = await mount(140);
    await chip.push({ balance_minutes: 140, held_minutes: 30, spendable_minutes: 110 });
    await chip.push({
      balance_minutes: 170, delta_minutes: 30, reason: "cancellation_refund", held_minutes: 0, spendable_minutes: 170,
      parts: [
        { reason: "cancellation_refund", delta_minutes: 60 },
        { reason: "share_transfer", delta_minutes: -15, counterparty_name: "Sam Naidoo" },
        { reason: "share_transfer", delta_minutes: -15, counterparty_name: "Alex Petersen" },
      ],
    });
    expect(chip.flyout()).toBe(`${minutesSigned(60)} · ${plain(flyoutBackNote("30 min", ["Sam Naidoo", "Alex Petersen"]))}`);
    expect(flyoutBackNote("30 min", ["Sam Naidoo", "Alex Petersen"])).toMatch(/back to your partners$/);
  });

  it("an older server's burst — the refund frame, then the share frame: still 'back to', never 'freed'", async () => {
    const chip = await mount(155);
    await chip.push({ balance_minutes: 155, held_minutes: 15, spendable_minutes: 140 });
    await chip.push({ balance_minutes: 215, delta_minutes: 60, reason: "cancellation_refund", held_minutes: 15, spendable_minutes: 200 });
    await chip.push({ balance_minutes: 200, delta_minutes: -15, reason: "share_transfer", held_minutes: 0, spendable_minutes: 200 });
    expect(chip.flyout()).toBe(`${minutesSigned(60)} · ${plain(flyoutBackNote("15 min", [null]))}`);
    expect(flyoutBackNote("15 min", [null])).toMatch(/back to your partner$/);
  });

  it("held minutes released by the game starting (no share left the wallet) are still 'freed'", async () => {
    const chip = await mount(200);
    await chip.push({ balance_minutes: 200, held_minutes: 30, spendable_minutes: 170 });
    await chip.push({ balance_minutes: 210, delta_minutes: 10, reason: "admin_adjustment", held_minutes: 0, spendable_minutes: 210 });
    expect(chip.flyout()).toBe(`${minutesSigned(40)} · ${plain(flyoutHeldNote("30 min", false))}`);
  });
});

describe("MinutesChip — the flyout's place (R19 L19-2)", () => {
  it("hangs under the chip from its right edge and may wrap; never centred, never nowrap, never above the bar", async () => {
    const chip = await mount(155);
    await chip.push({ balance_minutes: 155, held_minutes: 15, spendable_minutes: 140 });
    await chip.push({
      balance_minutes: 200, delta_minutes: 45, reason: "cancellation_refund", held_minutes: 0, spendable_minutes: 200,
      parts: [{ reason: "cancellation_refund", delta_minutes: 60 }, { reason: "share_transfer", delta_minutes: -15, counterparty_name: "Sam Naidoo" }],
    });
    const fly = chip.node()!;
    expect(fly.className).toMatch(/\bright-0\b/);
    expect(fly.className).toMatch(/\btop-full\b/);
    expect(fly.className).not.toMatch(/left-1\/2|-translate-x-1\/2|whitespace-nowrap|-top-1/);
    // A figure never splits from its unit when it wraps.
    expect(fly.textContent).toMatch(/15\u00a0min/);
  });
});
