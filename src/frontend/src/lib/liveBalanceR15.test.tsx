import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { tokenStore } from "./api";
import { useLiveBalance, type BalanceDelta } from "./liveBalance";
import { stubFetch } from "../test/harness";

/**
 * R15 X15-6 / E15-2 / J15-3 — one movement, one toast.
 *
 * The server publishes TWO frames per movement: the legacy unnamed `data:` frame (balance only)
 * and the named `balance` event (balance, delta, reason, parts …). The opening frame of every
 * stream is unnamed too — a snapshot, not a movement. An unnamed frame updates the balance and
 * never raises a movement; whichever order the two arrive in, the member is told once, by the
 * named frame, with its reason.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) { this.listeners.get(type)?.delete(fn); }
  close() { /* nothing to release */ }
  unnamed(body: object) { this.onmessage?.({ data: JSON.stringify(body) } as MessageEvent); }
  named(body: object) {
    for (const fn of this.listeners.get("balance") ?? []) fn({ data: JSON.stringify(body) } as MessageEvent);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
  FakeEventSource.instances = [];
});

async function mounted(httpBalance: number) {
  tokenStore.set("member.jwt.value");
  vi.stubGlobal("EventSource", FakeEventSource);
  stubFetch([
    { method: "GET", path: "/api/v1/wallet", body: { balance_minutes: httpBalance, entries: [], total_entries: 0, offset: 0, limit: 1 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
  ]);
  const seen: BalanceDelta[] = [];
  const hook = renderHook(() => {
    const live = useLiveBalance({ enabled: true, identity: "m1" });
    if (live.delta && !seen.includes(live.delta)) seen.push(live.delta);
    return live;
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(FakeEventSource.instances).toHaveLength(1);
  return { hook, seen, es: FakeEventSource.instances[0] };
}

const NAMED = { balance_minutes: 460, delta_minutes: 10, reason: "admin_credit" };

describe("an unnamed balance frame is never a movement (R15 X15-6)", () => {
  it("unnamed then named: one movement, carrying the named frame's reason", async () => {
    const { hook, seen, es } = await mounted(450);
    await act(async () => { es.unnamed({ balance_minutes: 460 }); });
    await act(async () => { es.named(NAMED); });
    expect(hook.result.current.balance).toBe(460);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ amount: 10, reason: "admin_credit" });
  });

  it("named then unnamed: still one movement", async () => {
    const { hook, seen, es } = await mounted(450);
    await act(async () => { es.named(NAMED); });
    await act(async () => { es.unnamed({ balance_minutes: 460 }); });
    expect(hook.result.current.balance).toBe(460);
    expect(seen).toHaveLength(1);
  });

  it("the opening snapshot differing from the HTTP figure updates the balance and raises nothing", async () => {
    const { hook, seen, es } = await mounted(450);
    await act(async () => { es.unnamed({ balance_minutes: 470, held_minutes: 0 }); });
    expect(hook.result.current.balance).toBe(470);
    expect(seen).toHaveLength(0);
  });

  it("a named frame alone still raises its movement", async () => {
    const { seen, es } = await mounted(450);
    await act(async () => { es.named({ ...NAMED, delta_minutes: -30, balance_minutes: 420, reason: "booking_charge" }); });
    expect(seen).toHaveLength(1);
    expect(seen[0].amount).toBe(-30);
  });
});

describe("the legacy unnamed twin keeps the held part (R15 X15-6)", () => {
  it("a bare unnamed frame after a named one with a hold leaves the hold standing", async () => {
    const { hook, es } = await mounted(450);
    await act(async () => { es.named({ ...NAMED, held_minutes: 20, spendable_minutes: 440 }); });
    await act(async () => { es.unnamed({ balance_minutes: 460 }); });
    expect(hook.result.current.heldFigures).toMatchObject({ held: 20, spendable: 440 });
  });
});
