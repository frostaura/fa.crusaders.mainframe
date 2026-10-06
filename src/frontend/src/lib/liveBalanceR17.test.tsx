import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { tokenStore } from "./api";
import { useLiveBalance, type BalanceDelta, type BalanceFrame, type BalanceTransport } from "./liveBalance";

/**
 * R17 J17-2 — a wallet read that was SENT before a stream frame arrived describes the balance
 * before that frame. Its answer must never overwrite the frame's newer figure, nor raise a
 * movement against it ("went up 20" when it went down 20). Reads are tagged with how many frames
 * had arrived when they were sent; an answer that finds more has arrived is dropped.
 */

type Deferred = { resolve: (balance: number) => void };

/** The wallet GET answers when the test says so: a slow read the frames can overtake. */
function controlledWallet() {
  const pending: Deferred[] = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise((resolveFetch) => {
    pending.push({
      resolve: (balance: number) => {
        const wire = JSON.stringify({ balance_minutes: balance, entries: [], total_entries: 0, offset: 0, limit: 1 });
        resolveFetch({
          ok: true, status: 200, headers: { get: () => null },
          text: () => Promise.resolve(wire), json: () => Promise.resolve(JSON.parse(wire)),
        } as unknown as Response);
      },
    });
  })));
  return pending;
}

/** A transport the test drives: `push` delivers a named frame. */
function fakeTransport() {
  let deliver: ((frame: BalanceFrame, origin?: "unnamed") => void) | null = null;
  const transport: BalanceTransport = {
    open: async ({ onFrame }) => { deliver = onFrame; return { close: () => { deliver = null; } }; },
  };
  return { transport, push: (frame: BalanceFrame, origin?: "unnamed") => deliver?.(frame, origin) };
}

const tick = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
});

async function mounted(opening: number) {
  tokenStore.set("member.jwt.value");
  const wallet = controlledWallet();
  const wire = fakeTransport();
  const seen: BalanceDelta[] = [];
  const hook = renderHook(() => {
    const live = useLiveBalance({ enabled: true, identity: "m1", transport: wire.transport });
    if (live.delta && !seen.includes(live.delta)) seen.push(live.delta);
    return live;
  });
  await tick(5);
  await act(async () => { wallet.shift()!.resolve(opening); });
  await tick(5);
  expect(hook.result.current.balance).toBe(opening);
  return { hook, seen, wallet, push: wire.push };
}

const DOWN_20 = { balance_minutes: 100, delta_minutes: -20, reason: "booking_charge" };
const DOWN_10 = { balance_minutes: 90, delta_minutes: -10, reason: "booking_charge" };

describe("a stale wallet read never overwrites a newer frame (R17 J17-2)", () => {
  it("read sent, two frames 40 ms apart, then the slow read answers the old figure: the frames stand", async () => {
    const { hook, seen, wallet, push } = await mounted(120);
    // The focus read goes out while the balance is still 120.
    await act(async () => { void hook.result.current.refresh(); });
    await tick(2);
    expect(wallet).toHaveLength(1);
    await act(async () => { push(DOWN_20); });
    await tick(40);
    await act(async () => { push(DOWN_10); });
    // …and only now does the server's answer — read before either movement — arrive.
    await act(async () => { wallet.shift()!.resolve(120); });
    await tick(5);
    expect(hook.result.current.balance).toBe(90);
    expect(seen.map((d) => d.amount)).toEqual([-20, -10]);
    expect(seen.some((d) => d.amount > 0)).toBe(false);
  });

  it("read sent after the first frame, overtaken by the second: still dropped", async () => {
    const { hook, seen, wallet, push } = await mounted(120);
    await act(async () => { push(DOWN_20); });
    await act(async () => { void hook.result.current.refresh(); });
    await tick(2);
    await tick(40);
    await act(async () => { push(DOWN_10); });
    await act(async () => { wallet.shift()!.resolve(100); });
    await tick(5);
    expect(hook.result.current.balance).toBe(90);
    expect(seen.map((d) => d.amount)).toEqual([-20, -10]);
  });

  it("the reverse order — the read answers before the frames — takes the read, then each frame once", async () => {
    const { hook, seen, wallet, push } = await mounted(120);
    await act(async () => { void hook.result.current.refresh(); });
    await tick(2);
    await act(async () => { wallet.shift()!.resolve(120); });
    await tick(5);
    await act(async () => { push(DOWN_20); });
    await tick(40);
    await act(async () => { push(DOWN_10); });
    expect(hook.result.current.balance).toBe(90);
    expect(seen.map((d) => d.amount)).toEqual([-20, -10]);
  });

  it("a read sent after the last frame is believed: it can still bring news the stream missed", async () => {
    const { hook, seen, wallet, push } = await mounted(120);
    await act(async () => { push(DOWN_20); });
    await act(async () => { void hook.result.current.refresh(); });
    await tick(2);
    await act(async () => { wallet.shift()!.resolve(150); });
    await tick(5);
    expect(hook.result.current.balance).toBe(150);
    expect(seen.map((d) => d.amount)).toEqual([-20, 50]);
  });

  it("an unnamed twin overtaking the read counts as a frame too", async () => {
    const { hook, seen, wallet, push } = await mounted(120);
    await act(async () => { void hook.result.current.refresh(); });
    await tick(2);
    await act(async () => { push({ balance_minutes: 100 }, "unnamed"); });
    await act(async () => { wallet.shift()!.resolve(120); });
    await tick(5);
    expect(hook.result.current.balance).toBe(100);
    expect(seen).toHaveLength(0);
  });
});
