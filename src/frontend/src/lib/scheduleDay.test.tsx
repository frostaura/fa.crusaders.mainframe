import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endpoints, type ScheduleDay } from "./api";
import { useScheduleDay } from "./scheduleDay";

/**
 * R2 F1-2 — a late schedule reply for a day the member has already left blanked the grid: the
 * slow Tuesday answer landed after Wednesday's, replaced the day, and the page (which only draws
 * the day it was asked for) drew nothing at all.
 */

function day(date: string): ScheduleDay {
  return {
    date, timezone: "Africa/Johannesburg", sliceMinutes: 15, dayStartMinute: 16 * 60, dayEndMinute: 18 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: [], slots: [],
  } as unknown as ScheduleDay;
}

type Deferred = { resolve: (d: ScheduleDay) => void; reject: (e: unknown) => void };

function deferredSchedule() {
  const pending = new Map<string, Deferred[]>();
  vi.spyOn(endpoints, "schedule").mockImplementation((date: string) => new Promise<ScheduleDay>((resolve, reject) => {
    pending.set(date, [...(pending.get(date) ?? []), { resolve, reject }]);
  }));
  return {
    answer: (date: string, body = day(date)) => { const d = pending.get(date)?.shift(); d?.resolve(body); },
    fail: (date: string) => { const d = pending.get(date)?.shift(); d?.reject(new Error("boom")); },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("useScheduleDay — replies for a day the member has left (F1-2)", () => {
  it("keeps the selected day when an earlier day's reply lands after it", async () => {
    const server = deferredSchedule();
    const { result } = renderHook(() => useScheduleDay(false, "2030-09-09"));
    await act(async () => { server.answer("2030-09-09"); });
    expect(result.current.day?.date).toBe("2030-09-09");

    act(() => result.current.setDate("2030-09-10"));
    act(() => result.current.setDate("2030-09-11"));
    await act(async () => { server.answer("2030-09-11"); });
    expect(result.current.day?.date).toBe("2030-09-11");

    // Tuesday's slow answer arrives last. It is for a day nobody is looking at.
    await act(async () => { server.answer("2030-09-10"); });
    expect(result.current.date).toBe("2030-09-11");
    expect(result.current.day?.date).toBe("2030-09-11");
    expect(result.current.loading).toBe(false);
  });

  it("stays loading while the selected day is still being read, whatever older reads do", async () => {
    const server = deferredSchedule();
    const { result } = renderHook(() => useScheduleDay(false, "2030-09-09"));
    act(() => result.current.setDate("2030-09-10"));
    // The first day's read finishes (or fails) while the second is still out.
    await act(async () => { server.fail("2030-09-09"); });
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    await act(async () => { server.answer("2030-09-10"); });
    expect(result.current.loading).toBe(false);
    expect(result.current.day?.date).toBe("2030-09-10");
  });

  it("re-reads a day the member comes back to after its read was dropped", async () => {
    const server = deferredSchedule();
    const spy = vi.mocked(endpoints.schedule);
    const { result } = renderHook(() => useScheduleDay(false, "2030-09-09"));
    act(() => result.current.setDate("2030-09-10"));
    await act(async () => { server.answer("2030-09-10"); });
    await act(async () => { server.answer("2030-09-09"); }); // late, dropped
    act(() => result.current.setDate("2030-09-09"));
    await waitFor(() => expect(spy.mock.calls.filter(([d]) => d === "2030-09-09")).toHaveLength(2));
    await act(async () => { server.answer("2030-09-09"); });
    expect(result.current.day?.date).toBe("2030-09-09");
  });

  it("does not let a background re-read of a day the member left replace the day on screen", async () => {
    const server = deferredSchedule();
    const { result } = renderHook(() => useScheduleDay(false, "2030-09-09"));
    await act(async () => { server.answer("2030-09-09"); });
    let reread: Promise<ScheduleDay | null> = Promise.resolve(null);
    act(() => { reread = result.current.reconcile(); });
    act(() => result.current.setDate("2030-09-10"));
    await act(async () => { server.answer("2030-09-10"); });
    await act(async () => { server.answer("2030-09-09"); await reread; });
    expect(result.current.day?.date).toBe("2030-09-10");
    // …but the sheet that asked still hears what the day it wrote to now holds.
    await expect(reread).resolves.toMatchObject({ date: "2030-09-09" });
  });

  it("still adopts the server's own club day on a cold start", async () => {
    const server = deferredSchedule();
    const spy = vi.mocked(endpoints.schedule);
    const { result } = renderHook(() => useScheduleDay(false, "2030-09-09"));
    await act(async () => { server.answer("2030-09-09", day("2030-09-10")); });
    expect(result.current.date).toBe("2030-09-10");
    expect(result.current.day?.date).toBe("2030-09-10");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
