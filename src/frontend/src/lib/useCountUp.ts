import { useEffect, useRef, useState } from "react";

/**
 * The number the minutes chip actually paints while it catches up with the server's.
 *
 * <p>
 * A balance that jumps from 0 min to 5 h between two frames is a number nobody watched change.
 * Counting it is what turns a value in a header corner into an event — which is what GOAL 8 asks
 * for ("animate the balance badge… as funds get adjusted") and what an older member looking at
 * their own phone needs in order to notice at all.
 * </p>
 *
 * <p>
 * <b>P13: it counts in whole minutes.</b> Every painted frame is an integer, so the chip never
 * flashes "1 h 12.37 min" on the way from 1 h to 2 h — the formatter would truncate it, but a
 * caller printing the figure itself must not be handed a fraction either.
 * </p>
 */

/**
 * How long a movement of `delta` minutes should take to count.
 *
 * <p>
 * `clamp(350, 18 × |Δ|, 900)`. Five minutes is 350 ms; fifty — one game — is 900; five hours is
 * also 900. <b>The ceiling is the point:</b> a duration that scales without one
 * makes a big purchase, which is the happiest thing that happens on this screen, feel slow.
 * </p>
 */
export function countDurationMs(delta: number): number {
  return Math.min(900, Math.max(350, Math.round(18 * Math.abs(delta))));
}

/** Linear counting reads mechanical. This is the same family as the theme's `out` curve. */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function useCountUp(
  target: number | null,
  opts?: {
    /** Snap. Set under `prefers-reduced-motion`; the announcement carries the change instead. */
    instant?: boolean;
    now?: () => number;
  },
): number {
  const [displayed, setDisplayed] = useState(target ?? 0);
  /**
   * What is on screen RIGHT NOW, as a ref.
   *
   * <p>
   * A second movement mid-tween must restart from what the member can see, never from the
   * previous target — otherwise two quick movements make the number jump backwards, which on a
   * wallet is the one direction it must never appear to go by accident. The state cannot
   * answer this: the frame loop closes over the value it started with.
   * </p>
   */
  const shown = useRef(target ?? 0);
  /** Whether anything has ever been shown. `null → 400` is a first telling, not a movement. */
  const started = useRef(target !== null);

  const instant = opts?.instant ?? false;
  const now = opts?.now;

  useEffect(() => {
    if (target === null) return;

    // The first non-null value is not a movement, and neither is a re-read that confirms what
    // is already on screen.
    if (!started.current || instant || Math.abs(target - shown.current) < 0.5) {
      started.current = true;
      shown.current = target;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the point of the hook is to mirror a prop
      setDisplayed(target);
      return;
    }

    const from = shown.current;
    const distance = target - from;
    const duration = countDurationMs(distance);
    const clock = now ?? (() => performance.now());
    const startedAt = clock();
    let frame = 0;

    const step = () => {
      const elapsed = clock() - startedAt;
      const t = Math.min(1, elapsed / duration);
      // Whole minutes on every frame (P13): the tween eases the value, the paint rounds it.
      const value = Math.round(from + distance * easeOutCubic(t));
      shown.current = value;
      setDisplayed(value);
      if (t < 1) frame = window.requestAnimationFrame(step);
      else { shown.current = target; setDisplayed(target); }
    };

    frame = window.requestAnimationFrame(step);
    // Cancelled on unmount AND on a new target — a second tween racing the first is what makes
    // a number flicker between two answers.
    return () => window.cancelAnimationFrame(frame);
  }, [target, instant, now]);

  return displayed;
}

/**
 * Whether this browser has been asked for less motion.
 *
 * <p>
 * A hook rather than a CSS-only answer because the count-up is a JavaScript tween: a media
 * query cannot stand down a `requestAnimationFrame` loop, and a number that keeps counting for
 * somebody who asked it not to is worse than one that never counted.
 * </p>
 *
 * <p>
 * It subscribes rather than reading once. macOS and iOS flip this setting live, and a member
 * who turns it on while the app is open should not have to reload to be taken seriously.
 * </p>
 */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => matches());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(query.matches);
    // `addEventListener` where it exists, `addListener` where it does not — Safari below 14
    // has only the deprecated form, and a club member on an old iPad is exactly the person
    // most likely to have this setting on.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    query.addListener?.(onChange);
    return () => query.removeListener?.(onChange);
  }, []);

  return reduce;
}

function matches(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // jsdom's matchMedia is a stub in some versions and throws on an unsupported query. A
    // throw here must mean "no preference expressed", never "reduce everything".
    return false;
  }
}
