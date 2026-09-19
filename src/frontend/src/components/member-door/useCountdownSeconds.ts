import { useEffect, useMemo, useState } from "react";
import { deadlineAt, secondsUntil } from "../../lib/countdown";

/**
 * Seconds left until an instant the server named, read off the clock once a second.
 *
 * <p>
 * Never counted in ticks. A phone locked in a pocket fires no ticks at all, and a
 * tick-counted countdown wakes showing the number it had when the screen went dark — over
 * a window that opened ten minutes ago, or a code that died. So every reading is a fresh
 * subtraction, and the same three events the code card already listens on force one:
 * `visibilitychange`, `focus` and `pageshow`.
 * </p>
 *
 * <p>
 * A null instant is a countdown that does not exist rather than one at zero — the caller
 * has to be able to tell "no window was sent" from "the window has opened", because they
 * are different sentences.
 * </p>
 */
export function useCountdownSeconds(instant: string | null): number | null {
  const deadline = useMemo(() => deadlineAt(instant), [instant]);
  const [seconds, setSeconds] = useState<number | null>(() => (deadline ? secondsUntil(deadline) : null));

  useEffect(() => {
    if (!deadline) return;
    const read = () => setSeconds(secondsUntil(deadline));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first reading must not
    // wait a whole second: a member who has just opened this page would otherwise read a
    // number left over from the previous instant, which is the defect this module exists for.
    read();
    const timer = setInterval(read, 1000);
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    window.addEventListener("pageshow", read);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      window.removeEventListener("pageshow", read);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deadline` is memoised on the instant
  }, [deadline]);

  // Derived rather than stored for the null case, so a caller that stops passing an
  // instant gets "there is no countdown" on the very next render rather than one frame of
  // the last number this hook happened to hold.
  return deadline ? seconds : null;
}

/**
 * The same countdown at whole-minute granularity, in words, for a screen reader.
 *
 * <p>
 * This is the whole reason the two are separate. A live region that re-reads a
 * second-by-second counter is a screen reader talking over a member's own thoughts for as
 * long as they stand there; at a minute it is a useful sentence said six times while they
 * wait. Under a minute it says so in words rather than counting.
 * </p>
 */
export function spokenCountdown(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 60) return "less than a minute";
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
