import { afterEach, describe, expect, it, vi } from "vitest";
import { prefetchNavChunks, preloadRouteChunk, routeChunks } from "./routeChunks";

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
  it("fetches Bookings, Wallet and Profile after the delay, and nothing if cancelled first", () => {
    vi.useFakeTimers();
    const spies = watch();
    const cancel = prefetchNavChunks(1_000);
    vi.advanceTimersByTime(999);
    expect(spies.schedule).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    vi.runOnlyPendingTimers();
    expect(spies.schedule).toHaveBeenCalledTimes(1);
    expect(spies.wallet).toHaveBeenCalledTimes(1);
    expect(spies.profile).toHaveBeenCalledTimes(1);
    expect(spies.inbox).not.toHaveBeenCalled();
    cancel();

    const cancelled = prefetchNavChunks(1_000);
    cancelled();
    vi.advanceTimersByTime(5_000);
    expect(spies.schedule).toHaveBeenCalledTimes(1);
  });
});
