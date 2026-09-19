import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useTicker } from "./useTicker";

/**
 * The one timer a live-ticking page is allowed to own.
 *
 * <p>
 * <b>Why it recomputes rather than counts.</b> An accumulated counter — "add one every
 * tick" — comes back wrong after a phone has slept, because the interval simply did not
 * fire while the screen was off. Every age on the doors surface is the product's honesty
 * signal under P1, so it is computed from `Date.now()` at paint, never from a tally.
 * </p>
 *
 * <p>
 * <b>No `mounted` ref.</b> StrictMode runs mount → cleanup → mount, and a ref written only
 * on cleanup is already false before the first tick — the exact shape that produced a
 * confirm button stuck on "Working…" and a dead retry button in this repo. Clearing the
 * interval is the whole cleanup.
 * </p>
 */

function Probe({ active = true }: { active?: boolean }) {
  const now = useTicker(active);
  return <p>now {now}</p>;
}

function shown(): number {
  return Number(screen.getByText(/^now /).textContent!.replace("now ", ""));
}

describe("useTicker", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-19T09:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("hands back the current instant and advances it once a second", () => {
    render(<Probe />);
    const first = shown();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(shown()).toBe(first + 3000);
  });

  /** From the clock, not from a tally — so a slept phone comes back with the right number. */
  it("recomputes from the clock rather than accumulating ticks", () => {
    render(<Probe />);
    const first = shown();
    // The clock jumps an hour while no interval fires, as it does across a phone sleep,
    // and then one tick arrives. A tally would be a second further on; the clock is an
    // hour and a second further on.
    act(() => { vi.setSystemTime(new Date("2026-09-19T10:00:00Z")); vi.advanceTimersByTime(1000); });
    expect(shown()).toBe(first + 3_600_000 + 1000);
    expect(shown()).not.toBe(first + 1000);
  });

  it("does not tick while the caller says it is inactive", () => {
    render(<Probe active={false} />);
    const first = shown();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(shown()).toBe(first);
  });

  it("stops while the tab is hidden and catches up the moment it comes back", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    render(<Probe />);
    const first = shown();

    visibility.mockReturnValue("hidden");
    act(() => { vi.advanceTimersByTime(30_000); });
    // Nothing moved: the interval fired and declined to write.
    expect(shown()).toBe(first);

    visibility.mockReturnValue("visible");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    // Not one tick later — the whole hidden window, immediately.
    expect(shown()).toBe(first + 30_000);
    visibility.mockRestore();
  });

  /** Two mounts and one cleanup is what StrictMode does; it must leave exactly one timer. */
  it("survives StrictMode's mount, cleanup, mount", () => {
    render(<Probe />, { reactStrictMode: true });
    const first = shown();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(shown()).toBe(first + 1000);
  });
});
