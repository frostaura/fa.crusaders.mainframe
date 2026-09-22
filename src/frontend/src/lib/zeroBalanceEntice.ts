import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The zero-balance chip — attention without nagging. (GOAL 8)
 *
 * <p>
 * <b>The rule: a finite, decaying courtesy — never a loop.</b> An animation that runs for ever
 * is not an invitation, it is a fault light, and a member who cannot afford to top up today
 * has to look at it every single time they open the app. Three bursts of three breaths, then
 * silence for the rest of the session. <b>12.6 seconds of motion, once, ever.</b> After that
 * the chip is simply red and says `0.00 cr`, which is itself the message.
 * </p>
 *
 * <pre>
 * balance reads 0  ->  wait ZERO_ENTICE.graceMs (4 000)
 * burst 1: 3 breaths (4.2 s)  ->  pause 60 s
 * burst 2: 3 breaths (4.2 s)  ->  pause 120 s
 * burst 3: 3 breaths (4.2 s)  ->  STOP. Permanently, for the session.
 * </pre>
 *
 * <p>
 * <b>The grace period is not padding.</b> A member who has just spent the last of their balance
 * watches the count-down finish and reads the booking toast. Starting a pulse on top of that
 * turns a successful booking into an alarm. Four seconds is the toast's own life minus its
 * exit.
 * </p>
 */

export const ZERO_ENTICE = {
  bursts: 3,
  /** One `chip-breathe` iteration is 1 400 ms; the Tailwind animation runs 3 of them. */
  breathsPerBurst: 3,
  burstMs: 4_200,
  /** Between burst 1 and 2, then between 2 and 3. Its length is the decay. */
  pauseMs: [60_000, 120_000],
  graceMs: 4_000,
} as const;

/**
 * Why the entice stopped, for the record and for the tests.
 *
 * Every one of these is PERMANENT for the session. A member who has been shown the invitation
 * and did not act on it has answered; asking again later is the nag this design refuses.
 */
export type EnticeStop =
  | "funded"      // the balance rose above zero
  | "tapped"      // they pressed the chip
  | "arrived"     // they reached /wallet or /wallet/topup by any route
  | "dismissed"   // they asked it to stop
  | "spent";      // all three bursts ran

export type ZeroEntice = {
  /** Whether the chip should be breathing at this instant. */
  breathing: boolean;
  /** Whether the standing "· Top up" word should be shown instead (reduced motion). */
  showWord: boolean;
  stop: (why: EnticeStop) => void;
  stopped: EnticeStop | null;
};

export function useZeroBalanceEntice({
  atZero,
  reduceMotion,
  config = ZERO_ENTICE,
}: {
  atZero: boolean;
  reduceMotion: boolean;
  config?: typeof ZERO_ENTICE;
}): ZeroEntice {
  const [breathing, setBreathing] = useState(false);
  const [stopped, setStopped] = useState<EnticeStop | null>(null);
  const timers = useRef<number[]>([]);
  const burst = useRef(0);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  const stop = useCallback((why: EnticeStop) => {
    clearTimers();
    setStopped((already) => already ?? why);
    /**
     * The current breath is allowed to FINISH.
     *
     * A `scale()` frozen at 1.035 is a rendering fault, not a stopped animation — the chip
     * would sit permanently 3.5 % too big and read as a layout bug. `animation-iteration-count`
     * is already whole breaths, so letting the class fall away at the end of the burst leaves
     * it at rest.
     */
    setBreathing(false);
  }, [clearTimers]);

  /**
   * Bursts do not run in the background and do not bank up.
   *
   * A member returning after an hour is not owed three bursts, and a phone in a pocket
   * animating a chip nobody is looking at is a battery cost for nothing.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { clearTimers(); setBreathing(false); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [clearTimers]);

  useEffect(() => {
    if (!atZero) return;
    if (stopped) return;
    /**
     * <b>Under reduced motion there is no slow pulse — there is a different affordance.</b>
     *
     * The chip grows the word "Top up" and keeps it for as long as the balance is zero. A
     * static thing that is always there is strictly better for this audience than motion they
     * have asked not to see, and it is the same information. A quieter animation would be
     * neither.
     */
    if (reduceMotion) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;

    const schedule = (delay: number) => {
      timers.current.push(window.setTimeout(() => {
        burst.current += 1;
        setBreathing(true);
        timers.current.push(window.setTimeout(() => {
          setBreathing(false);
          if (burst.current >= config.bursts) { setStopped((already) => already ?? "spent"); return; }
          schedule(config.pauseMs[burst.current - 1] ?? config.pauseMs[config.pauseMs.length - 1]);
        }, config.burstMs));
      }, delay));
    };

    schedule(config.graceMs);
    return clearTimers;
  }, [atZero, reduceMotion, stopped, config, clearTimers]);

  // The balance rising above zero is the happy ending, and it is permanent like every other.
  useEffect(() => {
    if (!atZero && stopped === null && burst.current > 0) stop("funded");
  }, [atZero, stopped, stop]);

  return {
    breathing: atZero && breathing && !reduceMotion,
    showWord: atZero && reduceMotion && stopped !== "dismissed",
    stop,
    stopped,
  };
}
