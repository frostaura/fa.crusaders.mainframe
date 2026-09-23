import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/**
 * The doors surface's plain raised panel: the card surface with its own padding (P3 — it was the
 * `components/Card` compatibility shim, which padded with arbitrary pixel values). Not the
 * design-system `Card`, whose header/content parts own the padding: these panels hold free text,
 * notices and feeds rather than a titled card anatomy, and wrapping each in `CardContent` would be
 * structure for its own sake.
 */
export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card"
      className={cn("min-w-0 rounded-xl border border-border bg-bg-surface p-4 text-text-primary shadow-xs sm:p-6", className)}
      {...props}
    />
  );
}
