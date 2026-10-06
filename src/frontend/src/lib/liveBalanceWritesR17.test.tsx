import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { api, tokenStore } from "./api";
import { useLiveBalance, type BalanceDelta, type BalanceFrame, type BalanceTransport } from "./liveBalance";

/**
 * R17 J17-2 follow-through (lane FE17x) — a WRITE's own answer is the same class as a stale read.
 * A booking's `balance_after_minutes` describes the balance at its commit. If a stream frame has
 * arrived since the request was SENT, the frame is at least as new as the answer (the server
 * publishes one after every commit, this booking's included), so the answer must not be put over
 * it — nor measured against it as a movement ("went down 50" when it went up). The reverse order
 * (the answer first, the frames after) takes the answer, then each frame.
 */

type Pending = { path: string; method: string; answer: (body: unknown) => void };

/** Every request waits until the test answers it — a slow booking the frames can overtake. */
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
  const take = (prefix: string) => {
    const at = pending.findIndex((p) => p.path.startsWith(prefix));
    expect(at, `a request to ${prefix}`).toBeGreaterThanOrEqual(0);
    return pending.splice(at, 1)[0];
  };
  return { pending, take };
}

function fakeTransport() {
  let deliver: ((frame: BalanceFrame, origin?: "unnamed") => void) | null = null;
  const transport: BalanceTransport = {
    open: async ({ onFrame }) => { deliver = onFrame; return { close: () => { deliver = null; } }; },
  };
  return { transport, push: (frame: BalanceFrame, origin?: "unnamed") => deliver?.(frame, origin) };
}

const tick = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const wallet = (balance: number) => ({ balance_minutes: balance, entries: [], total_entries: 0, offset: 0, limit: 1 });

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
});

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
  await act(async () => { net.take("/api/v1/wallet").answer(wallet(opening)); });
  await tick(5);
  expect(hook.result.current.balance).toBe(opening);
  return { hook, seen, net, push: wire.push };
}

/**
 * The booking as `Schedule.onBooked` takes it: the POST goes out through the money-moving
 * bracket, and its answer's balance is handed to `apply` once it lands.
 */
async function book(ctx: Awaited<ReturnType<typeof mounted>>) {
  let answered: Promise<void> = Promise.resolve();
  await act(async () => {
    answered = api.post<{ balance_after_minutes: number }>("/api/v1/bookings", { court: 1 })
      .then((r) => { ctx.hook.result.current.apply(r.balance_after_minutes); });
  });
  await tick(2);
  return {
    answer: async (after: number) => {
      await act(async () => { ctx.net.take("/api/v1/bookings").answer({ booking_id: "b1", balance_after_minutes: after }); await answered; });
      await tick(5);
    },
  };
}

const BOOKED = { balance_minutes: 70, delta_minutes: -50, reason: "booking_charge" };
const TOPPED = { balance_minutes: 130, delta_minutes: 60, reason: "admin_adjustment" };
const club = (seen: BalanceDelta[]) => seen.filter((d) => d.source === "club");

describe("a write's own answer never overwrites a newer frame (R17 J17-2, FE17x)", () => {
  it("booking sent → its frame and a desk top-up arrive → the slow answer (70) lands: 130 stands, no false 'went down'", async () => {
    const ctx = await mounted(120);
    const booking = await book(ctx);
    await act(async () => { ctx.push(BOOKED); });
    await tick(40);
    await act(async () => { ctx.push(TOPPED); });
    await booking.answer(70);
    expect(ctx.hook.result.current.balance).toBe(130);
    expect(ctx.seen.map((d) => d.amount)).toEqual([-50, 60]);
    expect(ctx.seen.some((d) => d.amount === -60)).toBe(false);
  });

  it("one frame only — a top-up the server committed after the booking — still wins over the answer", async () => {
    const ctx = await mounted(120);
    const booking = await book(ctx);
    await act(async () => { ctx.push({ balance_minutes: 130, delta_minutes: 60, reason: "admin_adjustment" }); });
    await booking.answer(70);
    expect(ctx.hook.result.current.balance).toBe(130);
    expect(ctx.seen.map((d) => d.amount)).toEqual([60]);
  });

  it("an unnamed twin overtaking the answer counts as a frame too", async () => {
    const ctx = await mounted(120);
    const booking = await book(ctx);
    await act(async () => { ctx.push({ balance_minutes: 130 }, "unnamed"); });
    await booking.answer(70);
    expect(ctx.hook.result.current.balance).toBe(130);
    expect(ctx.seen).toHaveLength(0);
  });

  it("the reverse order — the answer lands first, then the frames — takes the answer, then each frame; nothing said as the club's", async () => {
    const ctx = await mounted(120);
    const booking = await book(ctx);
    await booking.answer(70);
    expect(ctx.hook.result.current.balance).toBe(70);
    await act(async () => { ctx.push(BOOKED); });
    expect(ctx.hook.result.current.balance).toBe(70);
    expect(club(ctx.seen)).toHaveLength(0);
  });

  it("no stream at all (nothing arrives): the answer is the only news and is taken", async () => {
    const ctx = await mounted(120);
    const booking = await book(ctx);
    await booking.answer(70);
    expect(ctx.hook.result.current.balance).toBe(70);
    expect(ctx.seen.map((d) => [d.amount, d.source])).toEqual([[-50, "self"]]);
  });

  it("a frame that landed BEFORE the booking was sent does not block its answer", async () => {
    const ctx = await mounted(120);
    await act(async () => { ctx.push(TOPPED); });
    const booking = await book(ctx);
    await booking.answer(80);
    expect(ctx.hook.result.current.balance).toBe(80);
  });

  it("a marked read: frames counted when sent, an answer overtaken by a frame is dropped (apply with sentAt)", async () => {
    const ctx = await mounted(120);
    const sent = ctx.hook.result.current.frameMark();
    await act(async () => { ctx.push(TOPPED); });
    await act(async () => { ctx.hook.result.current.apply(120, { sentAt: sent }); });
    expect(ctx.hook.result.current.balance).toBe(130);
    expect(ctx.seen.map((d) => d.amount)).toEqual([60]);
    const again = ctx.hook.result.current.frameMark();
    await act(async () => { ctx.hook.result.current.apply(140, { sentAt: again }); });
    expect(ctx.hook.result.current.balance).toBe(140);
  });
});
