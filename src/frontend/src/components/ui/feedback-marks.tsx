import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { motion } from "@/lib/tokens";

/**
 * The outcome marks (design-system.md, Icons): a hand-drawn tick in a circle for success, and an
 * alert for failure. They replace the retired thumbs-up/down ActionGlyph.
 *
 * <p>
 * <b>Drawn, not faded.</b> Every path declares `pathLength={24}` and is dashed to that length, so
 * the one `fb-draw` keyframe (24 → 0) draws a circle and a tick identically whatever their real
 * geometry — the technique `components/ActionGlyph.tsx` established. The circle draws first; the
 * inner stroke follows one `in` later, while the whole mark arrives with `fb-pop`.
 * </p>
 *
 * <p>
 * <b>Reduced motion shows the finished mark.</b> `motion-reduce:animate-none` leaves each path at
 * its default `stroke-dashoffset` of 0 — fully drawn — so nothing is hidden, only not animated.
 * The delayed stroke uses `animation-fill-mode: both`, so it is not visible fully drawn during its
 * delay and then snatched away to draw.
 * </p>
 *
 * <p>
 * <b>Always `aria-hidden`.</b> A mark sits beside a word, and the word is the accessible name. It
 * is stroked in `currentColor` at 1.75, never filled, so a forced-colours palette keeps it.
 * </p>
 */
export type FeedbackMarkProps = {
  /** px. 16 beside a 14px label; 20 in a 44px button. */
  size?: number;
  className?: string;
  /** Draw on arrival. False renders the finished mark (a static state, a legend). */
  animate?: boolean;
};

const DRAW = "animate-fb-draw motion-reduce:animate-none";
const POP = "animate-fb-pop motion-reduce:animate-none";

/** The second stroke starts when the circle has finished. */
const FOLLOW: CSSProperties = { animationDelay: motion.duration.in, animationFillMode: "both" };

function frame(name: string, size: number, animate: boolean, className?: string) {
  return {
    "data-glyph": name,
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: "false" as const,
    className: cn("shrink-0", animate && POP, className),
  };
}

function stroke(animate: boolean, follow = false) {
  return {
    pathLength: 24,
    strokeDasharray: animate ? 24 : undefined,
    className: animate ? DRAW : undefined,
    style: animate && follow ? FOLLOW : undefined,
  };
}

/** Success: a circle, then a tick inside it. */
export function AnimatedCheck({ size = 20, className, animate = true }: FeedbackMarkProps) {
  return (
    <svg {...frame("check", size, animate, className)}>
      <circle cx="12" cy="12" r="9.25" {...stroke(animate)} />
      <path d="M8 12.4 L10.9 15.2 L16.2 9" {...stroke(animate, true)} />
    </svg>
  );
}

/**
 * Failure: a circle, then the stem and the dot. The dot is a zero-length round-capped stroke — a
 * dot at any stroke width, and one forced colours keeps (a filled circle would be dropped).
 */
export function AnimatedAlert({ size = 20, className, animate = true }: FeedbackMarkProps) {
  return (
    <svg {...frame("alert", size, animate, className)}>
      <circle cx="12" cy="12" r="9.25" {...stroke(animate)} />
      <path d="M12 7.5 V12.75" {...stroke(animate, true)} />
      <path d="M12 16.25 V16.26" {...stroke(animate, true)} />
    </svg>
  );
}
