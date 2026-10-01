import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { routeChunks, routeIntent } from "@/routeChunks";
import { setDataOwner } from "@/lib/offline/queryCache";
import { takeMyInvites } from "@/lib/earlyInvites";
import { useMyInvites } from "@/components/players/invites/useMyInvites";

/**
 * R5 (asked by lane B, the first in-app Bookings visit) — the invites list's first read joins the
 * one started at the press of the link, instead of asking again once the page's code has run; a
 * re-read always asks the club.
 */

const ALICE = "44444444-4444-4444-4444-444444444444";
const never = () => new Promise<never>(() => {});

function invitesCalls() {
  const fetchSpy = vi.fn((_input: RequestInfo | URL) => Promise.resolve(new Response(JSON.stringify({ items: [], count: 0 }), { status: 200 })));
  vi.stubGlobal("fetch", fetchSpy);
  for (const name of Object.keys(routeChunks) as (keyof typeof routeChunks)[]) vi.spyOn(routeChunks, name).mockImplementation(never);
  return () => fetchSpy.mock.calls.map(([input]) => String(input)).filter((path) => path.startsWith("/api/v1/me/invites"));
}

afterEach(() => {
  takeMyInvites();
  setDataOwner(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useMyInvites and the early read", () => {
  it("the first read takes the read the press started: one request, not two", async () => {
    setDataOwner(ALICE);
    const calls = invitesCalls();
    routeIntent("/bookings");
    const { result } = renderHook(() => useMyInvites());
    await waitFor(() => expect(result.current.items).toEqual([]));
    expect(calls()).toHaveLength(1);
  });

  it("a re-read never takes an early answer: it asks the club", async () => {
    setDataOwner(ALICE);
    const calls = invitesCalls();
    const { result } = renderHook(() => useMyInvites());
    await waitFor(() => expect(result.current.items).toEqual([]));
    routeIntent("/bookings");
    await act(async () => { await result.current.refresh(); });
    // The press's read, and the refresh's own — the refresh did not take the press's.
    expect(calls()).toHaveLength(3);
    expect(takeMyInvites()).not.toBeNull();
  });
});
