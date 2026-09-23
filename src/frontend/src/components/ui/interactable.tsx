import type { ComponentProps } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";
import type { WatermarkSurface } from "@/lib/tokens";
import { Watermark } from "./watermark";

export type InteractableSurface = WatermarkSurface;

export type InteractableProps = ComponentProps<"div"> & {
  /** Merge onto the single child (a `<button>`, a `<Link>`) instead of rendering a `<div>`. */
  asChild?: boolean;
  /** Which watermark geometry and opacities apply: 48px slot cell, card, hero tile, large CTA. */
  surface?: InteractableSurface;
  /**
   * Carry the fingerprint. Opt-in, never default: the spec's "Never" list (doors, passkeys, QR,
   * destructive/armed, form controls, tabs, icon buttons, inline links, dense tables, toasts, the
   * week strip) is longer than its "Carries it" list.
   */
  watermark?: boolean;
};

/**
 * An interactive surface: `relative isolate overflow-hidden`, `data-interactive` (the house
 * affordance layer in `index.css` keys on it), and — when asked — the fingerprint watermark.
 *
 * <p>
 * `<Interactable asChild surface="cell" watermark><button …>Book</button></Interactable>` keeps
 * the button a button: Radix `Slot` merges these props onto the child and appends the glyph
 * after the child's own children, so the element type, its handlers and its accessible name are
 * the caller's. `isolate` is what lets the glyph sit at `z-index: -1` — above the host's fill,
 * below its text.
 * </p>
 */
export function Interactable({
  asChild = false, surface = "card", watermark = false, className, children, ...rest
}: InteractableProps) {
  const Host = asChild ? Slot.Root : "div";
  return (
    <Host
      data-interactive=""
      data-surface={surface}
      data-watermark={watermark ? surface : undefined}
      className={cn("relative isolate overflow-hidden", className)}
      {...rest}
    >
      <Slot.Slottable>{children}</Slot.Slottable>
      {watermark ? <Watermark surface={surface} /> : null}
    </Host>
  );
}
