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
    // The first reading must not
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
/**
 * Whole minutes since an instant, re-read off the clock rather than counted. D6.
 *
 * <p>
 * Once a minute rather than once a second, because nothing on screen changes in between and
 * a per-second re-render of a card inside a polite live region is a screen reader talking
 * over a member. The same three wake events every other clock here listens on: a phone that
 * slept through four minutes must not come back showing "1 min ago".
 * </p>
 */
export function useMinutesSince(instant: string): number {
  const at = useMemo(() => Date.parse(instant), [instant]);
  const read = useMemo(() => () => (Number.isNaN(at) ? 0 : Math.max(0, Math.floor((Date.now() - at) / 60_000))), [at]);
  const [minutes, setMinutes] = useState(read);

  useEffect(() => {
    const tick = () => setMinutes(read());
    // The first reading is of a NEW instant and must not wait thirty seconds: a card
    // replaced by a fresher decision would otherwise carry its predecessor's age.
    tick();
    const timer = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
    };
  }, [read]);

  return minutes;
}

/**
 * The countdown in words lives in `lib/memberDoorCopy` (R10: the self-diagnosis code row is copy and
 * may not import a component module); re-exported here for the cards that already read it from here.
 */
export { spokenCountdown } from "../../lib/memberDoorCopy";
