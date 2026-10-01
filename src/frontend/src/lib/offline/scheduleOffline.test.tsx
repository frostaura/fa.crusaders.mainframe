import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ApiError, endpoints, tokenStore, type ScheduleDay } from "../api";
import { AuthProvider } from "../auth";
import { useScheduleDay } from "../scheduleDay";
import { memberReads } from "./memberReads";
import { primeQuery, setDataOwner } from "./queryCache";

/**
 * R4 wave B — the bookings grid from the phone: a refresh that fails keeps the day on screen
 * (stale, never a failure page), and a cold start with no signal draws the last day the member
 * looked at, said as stale — the page then books nothing from it.
 */

const ID = "44444444-4444-4444-4444-444444444444";

function day(date: string): ScheduleDay {
  return {
    date, timezone: "Africa/Johannesburg", sliceMinutes: 15, dayStartMinute: 16 * 60, dayEndMinute: 18 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: [], slots: [],
  } as unknown as ScheduleDay;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  tokenStore.clear();
  localStorage.clear();
});

describe("a refresh that fails", () => {
  it("a 429 keeps the day on screen, said as stale with when it was read", async () => {
    const schedule = vi.spyOn(endpoints, "schedule").mockResolvedValueOnce(day("2030-09-09"));
    const { result } = renderHook(() => useScheduleDay(false, "2030-09-09"));
    await waitFor(() => expect(result.current.day?.date).toBe("2030-09-09"));
    const readAt = result.current.readAt;
    expect(result.current.stale).toBe(false);

    schedule.mockRejectedValueOnce(new ApiError(429, { error: "rate_limited" }));
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.day?.date).toBe("2030-09-09");
    expect(result.current.readAt).toBe(readAt);
    expect(result.current.error).toBeInstanceOf(ApiError);
  });
});

describe("with no signal", () => {
  function offlineMember() {
    tokenStore.set("member.jwt.value");
    localStorage.setItem("crusaders.mainframe.last-identity", ID);
    setDataOwner(ID);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
  }
  const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;

  it("a cold start draws the last day looked at, stale", async () => {
    offlineMember();
    primeQuery(ID, memberReads.lastDay, "2030-09-08");
    primeQuery(ID, memberReads.schedule("2030-09-08").key, day("2030-09-08"));

    const { result } = renderHook(() => useScheduleDay(false), { wrapper });

    await waitFor(() => expect(result.current.day?.date).toBe("2030-09-08"));
    expect(result.current.date).toBe("2030-09-08");
    expect(result.current.stale).toBe(true);
    expect(result.current.readAt).not.toBeNull();
  });

  it("a day the member linked to is that day or nothing — never another day in its place", async () => {
    offlineMember();
    primeQuery(ID, memberReads.lastDay, "2030-09-08");
    primeQuery(ID, memberReads.schedule("2030-09-08").key, day("2030-09-08"));

    const { result } = renderHook(() => useScheduleDay(false, "2030-09-12"), { wrapper });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.date).toBe("2030-09-12");
    expect(result.current.day?.date ?? null).not.toBe("2030-09-08");
  });
});
