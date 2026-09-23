import { type HTMLAttributes } from "react";
import { cn } from "../lib/utils";

/**
 * The COMPAT card — `components/ui/card.tsx`'s surface (elevation 1: border + xs shadow, radius
 * xl), with the card padding on the card itself.
 *
 * <p>
 * The primitive `Card` pads only vertically and leaves the sides to its parts (`CardHeader`,
 * `CardContent`…). Every existing call site puts its content straight inside, so this keeps the
 * padding on the box — the look is the primitive's, the layout is the caller's. New screens use
 * the `ui/card` parts directly; this file is deleted with the other shims in P10.
 * </p>
 *
 * <p>
 * <b>The padding stays in PIXELS (B12), not the spec's `p-4 sm:p-6`.</b> At a 32px root font the
 * rem values are 32px and 48px, so on a 320px phone a card gives 96px of its 288px to its own
 * margins — and `/my-code` pins its code card as root-invariant (a rem anywhere in the QR's
 * width chain is the defect it tests for). Same 16px/24px at the default root either way.
 * </p>
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card"
      className={cn("min-w-0 rounded-xl border border-border bg-bg-surface p-[16px] text-text-primary shadow-xs sm:p-[24px]", className)}
      {...props}
    />
  );
}
