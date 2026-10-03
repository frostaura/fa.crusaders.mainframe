import { Children, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Items in a row, a middle dot between them, and NO dot ever at the start of a line (R8 L8-11).
 *
 * <p>
 * A "·" written between two items travels with whichever it is glued to, so when the row wraps it
 * either ends a line or starts the next one — an orphan separator (the Overview's alerts and the
 * inbox rows at 200 % text, "· 5 minutes ago" alone on its line). Here every item carries its own
 * leading dot in a fixed 1.25em slot, and the row is pulled 1.25em left inside a box that clips:
 * the first item of EVERY line has its dot in the clipped strip, so a wrap never strands one. An
 * item too long for a line wraps inside itself, its lines aligned past its dot.
 * </p>
 *
 * <p>
 * The dots are `aria-hidden`; say a pause for a screen reader in the items' own words (a
 * visually hidden comma), as the call sites already do.
 * </p>
 */
export function DotSeparated({ className, children, ...props }: ComponentProps<"span"> & { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <span data-dot-separated="" className={cn("block overflow-hidden", className)} {...props}>
      <span className="-ml-[1.25em] flex flex-wrap items-baseline gap-y-1">
        {items.map((item, index) => (
          <span key={index} className="flex min-w-0 items-baseline">
            <span aria-hidden="true" data-dot="" className="w-[1.25em] shrink-0 text-center">·</span>
            {item}
          </span>
        ))}
      </span>
    </span>
  );
}
