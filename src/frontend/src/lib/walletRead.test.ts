import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpoints, noteWalletMoved, tokenStore } from "./api";
import { signIn, signOut, stubFetch } from "../test/harness";

/**
 * Perf lane (2026-09-30) — one wallet read on arrival, not one per reader (the chip, the page, the
 * checklist), and never a shared answer that could predate a movement.
 */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}` }));
function serve() {
  return stubFetch([
    { path: "/api/v1/wallet", respond: (req) => {
      const limit = Number(new URL(req.path, "http://x").searchParams.get("limit") ?? 100);
      const shares = req.path.includes("include=share_bookings") ? { share_bookings: { b1: null } } : {};
      return { balance_credits: 90, entries: rows(Math.min(limit, 120)), total_entries: 120, offset: 0, limit, ...shares };
    } },
    { method: "POST", path: "/api/v1/bookings/", body: { booking_id: "b1", balance_after_credits: 40 } },
  ]);
}
const walletCalls = (stub: ReturnType<typeof serve>) => stub.calls.filter((c) => c.path.startsWith("/api/v1/wallet"));

beforeEach(() => { signIn({ isAdmin: false }); });
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("the wallet read", () => {
  it("joins a first-page read still in flight that asked for at least as many rows", async () => {
    const stub = serve();
    const [chip, checklist] = await Promise.all([endpoints.wallet(), endpoints.wallet(50, 0)]);
    expect(walletCalls(stub)).toHaveLength(1);
    expect(chip.entries).toHaveLength(100);
    expect(checklist.entries).toHaveLength(50);
    expect(checklist.limit).toBe(50);
    expect(checklist.balance_credits).toBe(90);
  });

  it("asks the club again once that read has finished — a Refresh is always a read", async () => {
    const stub = serve();
    await endpoints.wallet();
    await endpoints.wallet();
    expect(walletCalls(stub)).toHaveLength(2);
  });

  it("never joins a read that asked for fewer rows, another page, or another token", async () => {
    const stub = serve();
    const first = endpoints.wallet(50, 0);
    const more = endpoints.wallet(100, 0);
    const later = endpoints.wallet(50, 50);
    tokenStore.set("another.member.token");
    const other = endpoints.wallet(50, 0);
    await Promise.all([first, more, later, other]);
    expect(walletCalls(stub)).toHaveLength(4);
  });

  it("never joins a read sent before money moved — a booking of this tab's, or a stream frame", async () => {
    const stub = serve();
    const before = endpoints.wallet();
    const booking = endpoints.book("c1", "2030-01-01T10:00:00Z", 1);
    const after = endpoints.wallet();
    await Promise.all([before, booking, after]);
    expect(walletCalls(stub)).toHaveLength(2);

    const again = endpoints.wallet();
    noteWalletMoved();
    const afterFrame = endpoints.wallet();
    await Promise.all([again, afterFrame]);
    expect(walletCalls(stub)).toHaveLength(4);
  });

  it("lets a plain read join one that brings the share summaries, never the other way round", async () => {
    const stub = serve();
    const [page, chip] = await Promise.all([endpoints.walletWithShareBookings(100, 0), endpoints.wallet()]);
    expect(walletCalls(stub)).toHaveLength(1);
    expect(walletCalls(stub)[0].path).toContain("include=share_bookings");
    expect(chip).not.toHaveProperty("share_bookings");
    expect(page.share_bookings).toEqual({ b1: null });
    expect(page.entries).toHaveLength(100);

    await Promise.all([endpoints.wallet(), endpoints.walletWithShareBookings(100, 0)]);
    expect(walletCalls(stub)).toHaveLength(3);
  });
});
