import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A placeholder shaped like the content it stands in for (design-system.md, Async actions: a
 * read screen shows a Skeleton that matches the layout — never "Loading…"). Hidden from
 * assistive tech; the region that is loading carries `aria-busy` and says so itself. Still
 * under reduced motion.
 *
 * <p>
 * `max-w-full` (R15 L15-5): a skeleton's fixed width (`w-40`) is a rem, so at 200 % text it doubles
 * while the box it stands in does not — the member record's loading header pushed a 320 phone 97px
 * sideways. A placeholder is never wider than the room it is holding; the caller's width is the
 * most it takes.
 * </p>
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("max-w-full animate-pulse rounded-lg bg-bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  );
}
