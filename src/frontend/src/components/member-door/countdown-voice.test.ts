import { describe, expect, it } from "vitest";
import { formatCountdown } from "../../lib/countdown";
import { spokenCountdown } from "./useCountdownSeconds";

/**
 * The two countdowns on the decision card are the SAME sentence — one for the eye, one for
 * the live region — and R3-36 (D-L5) is the gap between them.
 *
 * <p>
 * <b>The reviewer's own capture: "Too early — the door opens for you in 9h 32m." with
 * `sr-only` "Too early — the door opens for you in 572 minutes." beside it.</b> Two different
 * answers to "when does the door open for me", on one card, in one live region — and ten
 * hours expressed as a count of minutes is not a unit anybody converts standing in a doorway,
 * which is the argument `formatCountdown` already makes about a quarter of an hour.
 * </p>
 *
 * <p>
 * They are deliberately not the same STRING — the visible one ticks per second and the spoken
 * one must not, or a screen reader talks over a member for as long as they stand there. What
 * has to agree is the number of hours and the number of whole minutes.
 * </p>
 */
describe("spokenCountdown", () => {
  it("says hours where the visible countdown says hours", () => {
    expect(spokenCountdown(9 * 3600 + 32 * 60 + 15)).toBe("9 hours 32 minutes");
    expect(formatCountdown(9 * 3600 + 32 * 60 + 15)).toBe("9h 32m");
    // Never a count of minutes past the hour. 572 was what a reviewer heard over "9h 32m".
    expect(spokenCountdown(9 * 3600 + 32 * 60)).not.toMatch(/\b\d{3,} minutes/);
  });

  it("agrees with the visible countdown at every reading, hour for hour and minute for minute", () => {
    for (const seconds of [0, 1, 59, 60, 61, 119, 3599, 3600, 3661, 7199, 34_320, 86_399]) {
      const visible = formatCountdown(seconds);
      const spoken = spokenCountdown(seconds);
      const hours = Number(visible.match(/(\d+)h/)?.[1] ?? 0);
      const minutes = Number(visible.match(/(\d+)m/)?.[1] ?? 0);
      if (seconds < 60) {
        // Under a minute it says so in words rather than counting: there is nothing to agree
        // about, and reading single seconds aloud is the noise this split exists to stop.
        expect(spoken).toBe(seconds <= 0 ? "now" : "less than a minute");
        continue;
      }
      expect(Number(spoken.match(/(\d+) hours?/)?.[1] ?? 0), `hours at ${seconds}s`).toBe(hours);
      expect(Number(spoken.match(/(\d+) minutes?/)?.[1] ?? 0), `minutes at ${seconds}s`).toBe(minutes);
    }
  });

  it("keeps its singulars", () => {
    expect(spokenCountdown(3600)).toBe("1 hour");
    expect(spokenCountdown(3660)).toBe("1 hour 1 minute");
    expect(spokenCountdown(120)).toBe("2 minutes");
    expect(spokenCountdown(0)).toBe("now");
  });

  /**
   * Truncation, not rounding, and the same direction `formatCountdown` truncates in. "The
   * door opens in 10 hours", said nine and a half hours beforehand, sends somebody home an
   * hour early.
   */
  it("rounds down, like the clock face beside it", () => {
    expect(spokenCountdown(119)).toBe("1 minute");
    expect(spokenCountdown(3599)).toBe("59 minutes");
  });
});
