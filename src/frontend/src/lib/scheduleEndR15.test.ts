import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { HOLD_LIFT_OFFLINE, useHoldLift } from "./scheduleEnd";

/**
 * R15 X15-3 (class sweep) — the hold lift's "You're offline, so nothing was sent" is said only
 * when the phone says it has no network; a lift that cannot reach the club from a phone that has one
 * is the lost-reply path (read back off the day), never "offline".
 */
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function lift(onLine: boolean) {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(onLine);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
  const said: string[] = [];
  const toast = { push: (t: { text: string }) => { said.push(t.text); } } as unknown as Parameters<typeof useHoldLift>[0]["toast"];
  const { result } = renderHook(() => useHoldLift({ day: null, setDay: () => {}, reconcile: async () => null, toast }));
  return { run: () => act(async () => { await result.current("blk-1", "Coaching"); }), said };
}

describe("R15 X15-3 — the hold lift says offline only when the phone is", () => {
  it("phone offline: You're offline, nothing sent", async () => {
    const l = lift(false);
    await l.run();
    expect(l.said).toEqual([HOLD_LIFT_OFFLINE]);
  });

  it("phone online, club unreachable: never 'You're offline'", async () => {
    const l = lift(true);
    await l.run();
    expect(l.said).toHaveLength(1);
    expect(l.said[0]).not.toBe(HOLD_LIFT_OFFLINE);
    expect(l.said[0]).not.toMatch(/offline/i);
  });
});
