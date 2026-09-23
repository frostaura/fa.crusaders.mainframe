import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A placeholder shaped like the content it stands in for (design-system.md, Async actions: a
 * read screen shows a Skeleton that matches the layout — never "Loading…"). Hidden from
 * assistive tech; the region that is loading carries `aria-busy` and says so itself. Still
 * under reduced motion.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-lg bg-bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  );
}
