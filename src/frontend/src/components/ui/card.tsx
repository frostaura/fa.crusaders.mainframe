import type { ComponentProps } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Card parts (design-system.md: elevation 1 = border + xs shadow, radius xl, padding
 * `p-4 sm:p-6`). The card owns the vertical rhythm (`py` + `gap`); every part owns only its
 * side gutters, so a card with no header or no footer still pads correctly.
 */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-bg-surface py-4 text-text-primary shadow-xs sm:gap-6 sm:py-6",
        className,
      )}
      {...props}
    />
  );
}

/** Title + description on the left; a `CardAction` (if any) pinned top-right beside them. */
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-4 sm:px-6",
        "has-[[data-slot=card-action]]:grid-cols-[1fr_auto]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The card's heading — an `h3` by default (Figtree 600 lg, the `h3` recipe). A card that is a
 * page's top-level section passes `asChild` with an `h2`: the outline is the page's to decide.
 */
export function CardTitle({ className, asChild = false, ...props }: ComponentProps<"h3"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "h3";
  return (
    <Comp
      data-slot="card-title"
      className={cn("min-w-0 break-words text-lg font-semibold leading-tight text-text-primary", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-sm text-text-secondary", className)} {...props} />;
}

export function CardAction({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("min-w-0 px-4 sm:px-6", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex flex-wrap items-center gap-2 px-4 sm:px-6", className)}
      {...props}
    />
  );
}
