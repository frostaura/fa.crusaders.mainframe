import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { api, tokenStore } from "./api";
import { useLiveBalance, type BalanceDelta, type BalanceFrame, type BalanceTransport } from "./liveBalance";

/**
 * R18 X18-2 — a movement counts as the member's own only when its frame is what the write in
 * flight makes. Measured: an admin adjusting a member's wallet 0.8–1.8 s after that member booked
 * a court raised NO toast, 6 times out of 6 — the "own" window was opened by any money-moving
 * request and swallowed every frame inside it plus three seconds. Adjustments have no inbox row,
 * so the member was never told.
 */

type Pending = { path: string; method: string; answer: (body: unknown) => void };

function controlledFetch() {
  const pending: Pending[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise((resolveFetch) => {
    const path = typeof input === "string" ? input : input.toString();
    pending.push({
      path, method: (init?.method ?? "GET").toUpperCase(),
      answer: (body: unknown) => {
        const wire = JSON.stringify(body);
        resolveFetch({
          ok: true, status: 200, headers: { get: () => null },
          text: () => Promise.resolve(wire), json: () => Promise.resolve(JSON.parse(wire)),
        } as unknown as Response);
      },
    });
  })));
  const take = (prefix: string, method = "POST") => {
    const at = pending.findIndex((p) => p.path.startsWith(prefix) && p.method === method);
    expect(at, `a ${method} to ${prefix}`).toBeGreaterThanOrEqual(0);
    return pending.splice(at, 1)[0];
  };
  return { take };
}

function fakeTransport() {
  let deliver: ((frame: BalanceFrame, origin?: "unnamed") => void) | null = null;
  const transport: BalanceTransport = {
    open: async ({ onFrame }) => { deliver = onFrame; return { close: () => { deliver = null; } }; },
  };
  return { transport, push: (frame: BalanceFrame) => deliver?.(frame) };
}

const tick = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

afterEach(() => { vi.unstubAllGlobals(); tokenStore.clear(); });

async function mounted(opening: number) {
  tokenStore.set("member.jwt.value");
  const net = controlledFetch();
  const wire = fakeTransport();
  const seen: BalanceDelta[] = [];
  const hook = renderHook(() => {
    const live = useLiveBalance({ enabled: true, identity: "m1", transport: wire.transport });
    if (live.delta && !seen.includes(live.delta)) seen.push(live.delta);
    return live;
  });
  await tick(5);
  await act(async () => { net.take("/api/v1/wallet", "GET").answer({ balance_minutes: opening, entries: [], total_entries: 0, offset: 0, limit: 1 }); });
  await tick(5);
  let balance = opening;
  /** A frame that moves the balance by `delta` from where the last one left it. */
  const frame = async (delta: number, rest: Omit<BalanceFrame, "balance_minutes" | "delta_minutes">) => {
    balance += delta;
    await act(async () => { wire.push({ balance_minutes: balance, delta_minutes: delta, ...rest }); });
  };
  /** A write through the real money-moving bracket; `settle` answers it. */
  const write = async (path: string, method: "POST" | "PUT" | "DELETE" = "POST") => {
    let done: Promise<unknown> = Promise.resolve();
    await act(async () => {
      done = method === "POST" ? api.post(path, {}) : method === "PUT" ? api.put(path, {}) : api.del(path);
    });
    await tick(2);
    return {
      settle: async (body: unknown = {}) => {
        await act(async () => { net.take(path, method).answer(body); await done; });
        await tick(5);
      },
    };
  };
  const club = () => seen.filter((d) => d.source === "club");
  return { hook, seen, frame, write, club, net };
}

const ADJUST = { reason: "admin_adjustment" } as const;

describe("R18 X18-2 — whose movement it was is decided by the frame, not by a window", () => {
  it("own booking: its frame, before or after the answer, raises no club toast (one booking)", async () => {
    const ctx = await mounted(480);
    const book = await ctx.write("/api/v1/bookings/");
    await ctx.frame(-30, { reason: "booking_charge" });
    await book.settle({ booking_id: "b1", balance_after_minutes: 450 });
    const second = await ctx.write("/api/v1/bookings/");
    await second.settle({ booking_id: "b2", balance_after_minutes: 420 });
    await ctx.frame(-30, { reason: "booking_charge" });
    expect(ctx.club()).toHaveLength(0);
  });

  it("the club adjusts 0.8 s after the member's own booking: exactly one club toast, the adjustment's", async () => {
    const ctx = await mounted(480);
    const book = await ctx.write("/api/v1/bookings/");
    await ctx.frame(-30, { reason: "booking_charge" });
    await book.settle({ booking_id: "b1", balance_after_minutes: 450 });
    await tick(800);
    await ctx.frame(5, ADJUST);
    expect(ctx.club().map((d) => [d.amount, d.reason])).toEqual([[5, "admin_adjustment"]]);
  });

  it("the club adjusts WHILE the member's booking is out: the adjustment is the club's, the booking stays theirs", async () => {
    const ctx = await mounted(480);
    const book = await ctx.write("/api/v1/bookings/bulk");
    await ctx.frame(5, ADJUST);
    await ctx.frame(-60, { reason: "booking_charge" });
    await book.settle({ bookings: [] });
    expect(ctx.club().map((d) => d.reason)).toEqual(["admin_adjustment"]);
  });

  it("a desk booking for the member (actor 'The club') during their own booking is the club's", async () => {
    const ctx = await mounted(480);
    const book = await ctx.write("/api/v1/bookings/");
    await ctx.frame(-30, { reason: "booking_charge", actor_name: "The club" });
    await ctx.frame(-30, { reason: "booking_charge" });
    await book.settle({ booking_id: "b1", balance_after_minutes: 420 });
    expect(ctx.club().map((d) => d.amount)).toEqual([-30]);
    expect(ctx.club()[0].actorName).toBe("The club");
  });

  it("own accept (share out, no actor) is theirs; a partner paying them meanwhile (actor named) is not", async () => {
    const ctx = await mounted(200);
    const accept = await ctx.write("/api/v1/invites/TOKEN/accept");
    await ctx.frame(-20, { reason: "share_transfer" });
    await ctx.frame(20, { reason: "share_transfer", actor_name: "Sam Petersen" });
    await accept.settle({ status: "accepted" });
    expect(ctx.club().map((d) => [d.amount, d.actorName])).toEqual([[20, "Sam Petersen"]]);
  });

  it("own cancel (refund + penalty, cancelled by the member) is theirs; a club cancel or adjust in its grace is not", async () => {
    const ctx = await mounted(200);
    const cancel = await ctx.write("/api/v1/bookings/b1/cancel");
    await cancel.settle({ refunded_minutes: 30, penalty_minutes: 10 });
    await ctx.frame(20, { reason: "mixed", cancelled_by: "member" });
    await ctx.frame(30, { reason: "cancellation_refund", cancelled_by: "club" });
    await ctx.frame(-5, ADJUST);
    expect(ctx.club().map((d) => d.amount)).toEqual([30, -5]);
  });

  it("an admin adjusting their OWN wallet hears nothing from the chip; a booking charge in that window is still said", async () => {
    const ctx = await mounted(100);
    const adjust = await ctx.write("/api/v1/admin/minutes/me-id/adjust");
    await ctx.frame(50, ADJUST);
    await ctx.frame(-30, { reason: "booking_charge", actor_name: "The club" });
    await adjust.settle({});
    expect(ctx.club().map((d) => d.reason)).toEqual(["booking_charge"]);
  });

  it("a page that asked for an expect-self read (the cancel sheet) does not silence a club adjustment", async () => {
    const ctx = await mounted(200);
    await act(async () => { void ctx.hook.result.current.refresh({ expectSelf: true }); });
    await ctx.frame(15, ADJUST);
    // The read was overtaken by the frame, so its answer is dropped; answered so it is not left out.
    await act(async () => { ctx.net.take("/api/v1/wallet", "GET").answer({ balance_minutes: 200, entries: [], total_entries: 0, offset: 0, limit: 1 }); });
    await tick(5);
    expect(ctx.club().map((d) => d.amount)).toEqual([15]);
  });

  it("two writes out at once (a booking and an accept): each one's frame is theirs, a no-show settlement is not", async () => {
    const ctx = await mounted(300);
    const book = await ctx.write("/api/v1/bookings/");
    const accept = await ctx.write("/api/v1/bookings/b9/players/p1/accept");
    await ctx.frame(-30, { reason: "booking_charge" });
    await ctx.frame(-15, { reason: "share_transfer" });
    await ctx.frame(-10, { reason: "no_show_settled" });
    await book.settle({ booking_id: "b1", balance_after_minutes: 270 });
    await accept.settle({ status: "accepted" });
    expect(ctx.club().map((d) => d.reason)).toEqual(["no_show_settled"]);
  });

  it("a frame from an older API (no reason) inside the window keeps the old rule: the member's own", async () => {
    const ctx = await mounted(300);
    const book = await ctx.write("/api/v1/bookings/");
    await ctx.frame(-30, {});
    await book.settle({ booking_id: "b1", balance_after_minutes: 270 });
    expect(ctx.club()).toHaveLength(0);
  });
});
