import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PrimaryNav } from "@/components/shell/PrimaryNav";
import { tokenStore } from "@/lib/api";
import { preloadAtSessionCheck, routeChunks, routeIntent } from "@/routeChunks";
import { memberReads, readsFor } from "./memberReads";
import { peekQuery, setDataOwner } from "./queryCache";

/**
 * P4-5 (R4 wave B) — a page's reads start WITH its code, not after it: on the press (hover,
 * focus) of a link to it, and beside the session check on a direct load. They go through the
 * cache, so the page's own first read joins them.
 */

const ID = "44444444-4444-4444-4444-444444444444";
const never = () => new Promise<never>(() => {});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); tokenStore.clear(); });

function apiCalls() {
  const fetchSpy = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    const body = path.startsWith("/api/v1/wallet") ? { balance_minutes: 1, entries: [], total_entries: 0, offset: 0, limit: 100 } : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchSpy);
  return () => fetchSpy.mock.calls.map(([input]) => String(input).split("?")[0]);
}

describe("the reads a page opens with", () => {
  it("names each member page's reads, and none for My Code, the invites list or the desk", () => {
    expect(readsFor("/bookings", "?date=2030-09-09").map((r) => r.key)).toEqual(["schedule:2030-09-09", "games:upcoming", "games:recent"]);
    expect(readsFor("/bookings", "?date=2030-09-09&as=u1").map((r) => r.key)).toEqual(["schedule:2030-09-09"]);
    expect(readsFor("/bookings/b1").map((r) => r.key)).toEqual(["booking:b1"]);
    expect(readsFor("/wallet").map((r) => r.key)).toEqual(["wallet:page"]);
    expect(readsFor("/profile").map((r) => r.key)).toEqual(["me:profile", "play:me"]);
    expect(readsFor("/my-code")).toEqual([]);
    expect(readsFor("/bookings/invites")).toEqual([]);
    expect(readsFor("/admin/members")).toEqual([]);
  });
});

describe("routeIntent", () => {
  it("starts the page's code and its reads together, for the member on this phone", async () => {
    setDataOwner(ID);
    const calls = apiCalls();
    const wallet = vi.spyOn(routeChunks, "wallet").mockImplementation(never);
    routeIntent("/wallet");
    expect(wallet).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual(["/api/v1/wallet"]);
    await vi.waitFor(() => expect(peekQuery(ID, memberReads.wallet.key)).toBeDefined());
  });

  it("asks for nothing offline, or with nobody signed in", () => {
    const calls = apiCalls();
    vi.spyOn(routeChunks, "wallet").mockImplementation(never);
    routeIntent("/wallet");
    expect(calls()).toEqual([]);
    setDataOwner(ID);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    routeIntent("/wallet");
    expect(calls()).toEqual([]);
  });

  it("a tab pressed starts its page's reads before the tap has finished", () => {
    setDataOwner(ID);
    const calls = apiCalls();
    for (const name of Object.keys(routeChunks) as (keyof typeof routeChunks)[]) vi.spyOn(routeChunks, name).mockImplementation(never);
    render(<MemoryRouter><PrimaryNav isAdmin={false} attention={{ total: 0, label: "" }} /></MemoryRouter>);
    fireEvent.pointerDown(screen.getByRole("link", { name: "Wallet" }));
    expect(calls()).toEqual(["/api/v1/wallet"]);
  });
});

describe("a direct load", () => {
  it("starts the opened page's reads beside the session check — and none for My Code", () => {
    setDataOwner(ID);
    const calls = apiCalls();
    for (const name of Object.keys(routeChunks) as (keyof typeof routeChunks)[]) vi.spyOn(routeChunks, name).mockImplementation(never);
    preloadAtSessionCheck("/my-code", never);
    expect(calls()).toEqual([]);
    preloadAtSessionCheck("/bookings", never, "?date=2030-09-09");
    expect(calls()).toEqual(["/api/v1/schedule", "/api/v1/me/bookings/upcoming", "/api/v1/me/bookings/recent"]);
  });
});

describe("the page joins the read its link started", () => {
  it("a Bookings press's day read is the grid's first read — one request, not two", async () => {
    const { renderHook, waitFor } = await import("@testing-library/react");
    const { AuthProvider } = await import("@/lib/auth");
    const { useScheduleDay } = await import("@/lib/scheduleDay");
    tokenStore.set("member.jwt.value");
    localStorage.setItem("crusaders.mainframe.last-identity", ID);
    setDataOwner(ID);
    const day = { date: "2030-09-09", timezone: "UTC", sliceMinutes: 15, dayStartMinute: 480, dayEndMinute: 600, advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: [], slots: [] };
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.startsWith("/api/v1/whoami") ? { is_authenticated: true, user_id: ID, is_admin: false, tenant_slug: "crusaders" }
        : path.startsWith("/api/v1/schedule") ? day : { items: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(routeChunks, "schedule").mockImplementation(never);

    routeIntent("/bookings?date=2030-09-09");
    await vi.waitFor(() => expect(peekQuery(ID, "schedule:2030-09-09")).toBeDefined());
    const { result } = renderHook(() => useScheduleDay(false, "2030-09-09"), {
      wrapper: ({ children }) => <AuthProvider>{children}</AuthProvider>,
    });
    await waitFor(() => expect(result.current.day?.date).toBe("2030-09-09"));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy.mock.calls.filter(([i]) => String(i).startsWith("/api/v1/schedule"))).toHaveLength(1);
    localStorage.clear();
  });
});
