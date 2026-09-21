import { type HTMLAttributes } from "react";
import { cn } from "../lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  /*
 * B12 — the padding is in PIXELS, and the reason is the same one the chrome already carries.
 *
 * `p-4 sm:p-6` is 16 px and 24 px at a 16 px root font size, and 32 px and 48 px at a 32 px
 * one. A card on a 320 px phone at that text size gives 96 px of its 288 px content box to
 * its own margins, and everything inside it — a grid, a table, a QR code — gets what is left.
 * Card padding is whitespace around content, not a touch target and not type, so it has no
 * reason to double when the type does.
 */
  return <div className={cn("bg-bg-surface border border-border rounded-lg shadow-sm p-[16px] sm:p-[24px]", className)} {...props} />;
}
