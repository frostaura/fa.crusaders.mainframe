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
 * <b>It said "572 minutes" beside a visible "9h 32m", and D-L5 is that gap.</b>
 *
 * <p>
 * The two lines are the SAME sentence — one for the eye, one for the live region — and a
 * screen-reader user reading over somebody's shoulder, or a member who has both on, was
 * handed two different answers to "when does the door open for me". Ten hours expressed as
 * a count of minutes is also not a unit anybody converts standing in a doorway, which is the
 * argument `formatCountdown` already makes about a quarter of an hour.
 * </p>
 *
 * <p>
 * So it carries hours where `formatCountdown` carries hours, and it rounds the same way it
 * does — DOWN, by truncation, because "the door opens in 10 hours" said nine and a half
 * hours beforehand is a sentence that sends somebody home an hour early. Under a minute it
 * still says so in words rather than counting.
 * </p>
 */
export function spokenCountdown(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 60) return "less than a minute";
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const minutePart = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  if (hours === 0) return minutePart;
  const hourPart = hours === 1 ? "1 hour" : `${hours} hours`;
  return minutes === 0 ? hourPart : `${hourPart} ${minutePart}`;
}
