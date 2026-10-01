import { afterEach, describe, expect, it, vi } from "vitest";
import { prefetchNavChunks, preloadAtSessionCheck, preloadRouteChunk, routeChunks } from "./routeChunks";

/** Perf lane (2026-09-30) — a page's code fetched before it is opened, as a hint and nothing more. */
const never = () => new Promise<never>(() => {});
function watch() {
  return Object.fromEntries(Object.keys(routeChunks).map((name) => [
    name, vi.spyOn(routeChunks, name as keyof typeof routeChunks).mockImplementation(never),
  ])) as Record<keyof typeof routeChunks, ReturnType<typeof vi.spyOn>>;
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("preloadRouteChunk — at boot, beside the session check", () => {
  it("asks for the opened page's code, the most specific route first", () => {
    const spies = watch();
    expect(preloadRouteChunk("/bookings")).toBe(true);
    expect(preloadRouteChunk("/bookings/invites")).toBe(true);
    expect(preloadRouteChunk("/bookings/b0000000-0000-0000-0000-000000000001")).toBe(true);
    expect(preloadRouteChunk("/wallet")).toBe(true);
    expect(spies.schedule).toHaveBeenCalledTimes(1);
    expect(spies.invites).toHaveBeenCalledTimes(1);
    expect(spies.bookingDetail).toHaveBeenCalledTimes(1);
    expect(spies.wallet).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing on a page in the entry, or offline", () => {
    const spies = watch();
    expect(preloadRouteChunk("/my-code")).toBe(false);
    expect(preloadRouteChunk("/")).toBe(false);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(preloadRouteChunk("/bookings")).toBe(false);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("swallows a chunk that will not come — the real open explains it", async () => {
    vi.spyOn(routeChunks, "schedule").mockRejectedValue(new TypeError("Failed to fetch dynamically imported module"));
    expect(preloadRouteChunk("/bookings")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("prefetchNavChunks — the tab bar's pages, once idle", () => {
  it("fetches them one after another — Bookings, Wallet, Profile — and an admin's console last", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    for (const name of ["schedule", "wallet", "profile"] as const) {
      vi.spyOn(routeChunks, name).mockImplementation(async () => { order.push(name); return { default: () => null }; });
    }
    // With nothing of the club's in flight (R4: Wallet and Profile wait for the open page's reads).
    prefetchNavChunks(10, false, async () => undefined);
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(["schedule", "wallet", "profile"]);
  });

  it("fetches Bookings, Wallet and Profile after the delay, and nothing if cancelled first", async () => {
    vi.useFakeTimers();
    const spies = watch();
    const cancel = prefetchNavChunks(1_000, false, async () => undefined);
    await vi.advanceTimersByTimeAsync(999);
    expect(spies.schedule).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.runOnlyPendingTimers();
    await vi.advanceTimersByTimeAsync(0);
    // One at a time, Bookings first: Wallet waits for Bookings' code.
    expect(spies.schedule).toHaveBeenCalledTimes(1);
    expect(spies.wallet).not.toHaveBeenCalled();
    expect(spies.inbox).not.toHaveBeenCalled();
    cancel();

    const cancelled = prefetchNavChunks(1_000, false, async () => undefined);
    cancelled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spies.schedule).toHaveBeenCalledTimes(1);
  });
});

/**
 * R4 — the first-Bookings regression: the tab bar's prefetch came after the tap, and Wallet's and
 * Profile's code could queue in front of the open page's own reads.
 */
describe("preloadAtSessionCheck — the opened page, then Bookings once the page has settled", () => {
  /** A quiet signal the test releases by hand. */
  function held() {
    let release: () => void = () => undefined;
    const quiet = vi.fn(() => new Promise<void>((r) => { release = r; }));
    return { quiet, release: async () => { release(); await new Promise((r) => setTimeout(r, 0)); } };
  }

  it("asks for Bookings' code from My Code only once My Code's reads have settled", async () => {
    const spies = watch();
    const q = held();
    expect(preloadAtSessionCheck("/my-code", q.quiet)).toBe(true);
    expect(spies.schedule, "not beside the door page's own reads").not.toHaveBeenCalled();
    await q.release();
    expect(spies.schedule).toHaveBeenCalledTimes(1);
    expect(spies.wallet).not.toHaveBeenCalled();
  });

  it("asks for the opened page's code at once, and Bookings' after", async () => {
    const spies = watch();
    const q = held();
    expect(preloadAtSessionCheck("/wallet", q.quiet)).toBe(true);
    expect(spies.wallet).toHaveBeenCalledTimes(1);
    expect(spies.schedule).not.toHaveBeenCalled();
    await q.release();
    expect(spies.schedule).toHaveBeenCalledTimes(1);
  });

  it("asks once on Bookings itself, and nothing offline", async () => {
    const spies = watch();
    const q = held();
    expect(preloadAtSessionCheck("/bookings", q.quiet)).toBe(true);
    await q.release();
    expect(spies.schedule).toHaveBeenCalledTimes(1);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(preloadAtSessionCheck("/my-code", q.quiet)).toBe(false);
    expect(spies.schedule).toHaveBeenCalledTimes(1);
  });
});

describe("prefetchNavChunks — every page waits for the open page's reads", () => {
  it("does not start Bookings' ~25 files while the open page's reads are in flight (P5-4)", async () => {
    // Review round 5: a cold /wallet on Fast 3G was usable at 8.3 s — the Schedule group started
    // beside the wallet's own reads, on HTTP/1.1's six connections.
    vi.useFakeTimers();
    const spies = watch();
    let quietNow: () => void = () => undefined;
    const quiet = vi.fn(() => new Promise<void>((r) => { quietNow = r; }));
    prefetchNavChunks(10, false, quiet);
    await vi.advanceTimersByTimeAsync(20);
    expect(quiet).toHaveBeenCalled();
    expect(spies.schedule).not.toHaveBeenCalled();
    quietNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(spies.schedule).toHaveBeenCalledTimes(1);
  });

  it("fetches nothing after Bookings until the club's reads are back", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    for (const name of ["schedule", "wallet", "profile"] as const) {
      vi.spyOn(routeChunks, name).mockImplementation(async () => { order.push(name); return { default: () => null }; });
    }
    let quietNow: () => void = () => undefined;
    const quiet = vi.fn(() => new Promise<void>((r) => { quietNow = r; }));
    prefetchNavChunks(10, false, quiet);
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual([]);
    quietNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["schedule"]);
    quietNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["schedule", "wallet"]);
    quietNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["schedule", "wallet", "profile"]);
  });
});
