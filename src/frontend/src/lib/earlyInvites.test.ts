import { afterEach, describe, expect, it, vi } from "vitest";
import { routeChunks, routeIntent } from "@/routeChunks";
import { setDataOwner } from "./offline/queryCache";
import { takeMyInvites } from "./earlyInvites";

/**
 * Review round 5 (the first in-app Bookings visit) — the invites badge's read starts with the
 * page's code, at the press, rather than once the code has arrived and run.
 */

const ALICE = "44444444-4444-4444-4444-444444444444";
const BOB = "55555555-5555-5555-5555-555555555555";
const never = () => new Promise<never>(() => {});

function invitesCalls() {
  const fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [], count: 0 }), { status: 200 })));
  vi.stubGlobal("fetch", fetchSpy);
  for (const name of Object.keys(routeChunks) as (keyof typeof routeChunks)[]) vi.spyOn(routeChunks, name).mockImplementation(never);
  return () => fetchSpy.mock.calls.map(([input]) => String(input)).filter((path) => path.startsWith("/api/v1/me/invites"));
}

afterEach(() => {
  takeMyInvites();
  setDataOwner(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the invites read starts with the code", () => {
  it("a press on Bookings, Invites or the bell starts it once; the first reader takes it, once", async () => {
    setDataOwner(ALICE);
    const calls = invitesCalls();
    routeIntent("/bookings");
    routeIntent("/bookings?date=2030-09-09");
    expect(calls()).toEqual(["/api/v1/me/invites"]);

    const early = takeMyInvites();
    expect(early).not.toBeNull();
    await expect(early).resolves.toEqual({ items: [], count: 0 });
    expect(takeMyInvites(), "a second reader reads for itself").toBeNull();

    routeIntent("/inbox");
    routeIntent("/bookings/invites");
    expect(calls()).toHaveLength(2);
  });

  it("starts nothing for a page that does not read invites, or with nobody on the phone", () => {
    const calls = invitesCalls();
    routeIntent("/bookings");
    setDataOwner(ALICE);
    routeIntent("/wallet");
    routeIntent("/bookings/b0000000-0000-0000-0000-000000000001");
    expect(calls()).toEqual([]);
    expect(takeMyInvites()).toBeNull();
  });

  it("is never handed to a different member, nor once it is a few seconds old", () => {
    setDataOwner(ALICE);
    invitesCalls();
    routeIntent("/bookings");
    setDataOwner(BOB);
    expect(takeMyInvites()).toBeNull();

    vi.useFakeTimers();
    routeIntent("/bookings");
    vi.advanceTimersByTime(6_000);
    expect(takeMyInvites()).toBeNull();
  });
});
