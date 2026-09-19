import { describe, expect, it, vi, afterEach } from "vitest";
import { deadlineAt, deadlineFor, formatClock, formatCountdown, formatDayAndClock, secondsUntil } from "./countdown";

/**
 * The clock that every countdown on the member's surfaces reads from.
 *
 * <p>
 * These four were private to `CourtCode.tsx` and are now shared — the code's own expiry,
 * the door's `too_early` window, and whatever asks next. They are EXTRACTED rather than
 * copied: the two-clock trick below is subtle enough that a second hand-rolled copy is a
 * second place for it to be got wrong, which is the same rule `relative()` and
 * `offlineAfterSeconds()` are held to on the admin side.
 * </p>
 */
describe("countdown", () => {
  afterEach(() => vi.useRealTimers());

  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });

  describe("formatCountdown", () => {
    it.each([
      [0, "0s"],
      [9, "9s"],
      [59, "59s"],
      [60, "1m 00s"],
      [61, "1m 01s"],
      [900, "15m 00s"],
      [3599, "59m 59s"],
      [3600, "1h 0m"],
      [7_380, "2h 3m"],
    ])("formats %i seconds as %s", (seconds, expected) => {
      expect(formatCountdown(seconds)).toBe(expected);
    });

    /**
     * The seconds are zero-padded and the minutes are not, and that is deliberate: a
     * digit that appears and disappears under a member's eye makes the whole line jump.
     */
    it("pads the seconds so the line does not jump as it counts down", () => {
      expect(formatCountdown(65)).toBe("1m 05s");
      expect(formatCountdown(605)).toBe("10m 05s");
    });
  });

  describe("secondsUntil", () => {
    it("reads a relative deadline off the clock rather than off ticks", () => {
      fakeClock();
      const deadline = deadlineFor(60);

      // No timer fires at all: the phone is locked. The answer still has to be right.
      vi.setSystemTime(Date.now() + 35_000);
      vi.advanceTimersByTime(0);
      expect(secondsUntil(deadline)).toBe(25);
    });

    it("never reports less than zero", () => {
      fakeClock();
      const deadline = deadlineFor(5);
      vi.setSystemTime(Date.now() + 60_000);
      expect(secondsUntil(deadline)).toBe(0);
    });

    /**
     * The two-clock rule, which is the whole reason this is not a subtraction.
     *
     * <p>
     * `Date.now()` runs through sleep but can be dragged backwards by a clock
     * correction; `performance.now()` cannot be dragged but stops on some phones while
     * the device sleeps. Trusting whichever says LESS time is left means a dead code is
     * never shown as live, whichever of the two lied.
     * </p>
     */
    it("trusts whichever clock says less time is left when the wall clock jumps back", () => {
      fakeClock();
      const deadline = deadlineFor(60);

      // A wall clock dragged thirty seconds backwards would otherwise report 90s left
      // over a code with 60. The monotonic clock has not moved, so it wins.
      vi.setSystemTime(Date.now() - 30_000);
      expect(secondsUntil(deadline)).toBe(60);
    });
  });

  describe("deadlineAt", () => {
    /**
     * An ABSOLUTE server instant — `door_opens_at` — which is a different problem from a
     * relative lifetime and must not pretend otherwise. There is no monotonic reading of
     * an instant the server named: `performance.now()` has no relation to it, so the
     * deadline is anchored on the wall clock and the monotonic half is derived from it.
     */
    it("counts down to an instant the server named", () => {
      fakeClock();
      const opensAt = new Date(Date.now() + 27 * 60_000 + 12_000).toISOString();

      expect(secondsUntil(deadlineAt(opensAt)!)).toBe(27 * 60 + 12);
      expect(formatCountdown(secondsUntil(deadlineAt(opensAt)!))).toBe("27m 12s");
    });

    it("reports zero for an instant that has already passed", () => {
      fakeClock();
      const gone = new Date(Date.now() - 5_000).toISOString();
      expect(secondsUntil(deadlineAt(gone)!)).toBe(0);
    });

    it("returns null for an instant it cannot read, rather than a countdown to 1970", () => {
      expect(deadlineAt(null)).toBeNull();
      expect(deadlineAt("not a date")).toBeNull();
    });
  });

  /**
   * The clock face. The hour is the VIEWER's, so only the shape is pinned — the same
   * convention every existing test of this product's clock times uses.
   */
  describe("formatClock", () => {
    it("renders a 24-hour clock time", () => {
      expect(formatClock("2026-09-19T06:04:00Z")).toMatch(/^\d{2}:\d{2}$/);
    });

    /** `h23`, not `h24`: a club that opens at midnight must not read as `24:15`. */
    it("writes midnight as 00, not 24", () => {
      const midnight = formatClock(new Date(2026, 8, 19, 0, 15).toISOString());
      expect(midnight).toBe("00:15");
    });
  });

  describe("formatDayAndClock", () => {
    /**
     * The weekday and month ORDER is the viewer's locale, so it is not pinned — only
     * that all four parts are present and the clock is on the far side of the separator.
     * A member scanning their own record needs the day, because two rows an hour apart on
     * different days are otherwise indistinguishable.
     */
    it("renders a weekday, a date and a clock time for a row in a member's own record", () => {
      const rendered = formatDayAndClock(new Date(2026, 8, 19, 6, 4).toISOString());
      expect(rendered).toMatch(/^\D*\w{3}\D*19\D*· 06:04$/);
      expect(rendered).toContain("19");
      expect(rendered).toMatch(/· 06:04$/);
    });
  });
});
