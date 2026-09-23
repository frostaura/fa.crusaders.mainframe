import type { ComponentProps } from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Progress — Radix (`role="progressbar"` with `aria-valuenow`/`max`). Name it with `aria-label`
 * or `aria-labelledby`; for a bulk run pass `max={n}` and `value={done}`, and let the page say
 * "3 of 8" in words beside it. `value={null}` is indeterminate.
 */
export function Progress({ className, value, max = 100, ...props }: ComponentProps<typeof ProgressPrimitive.Root>) {
  const fraction = value == null || max <= 0 ? 0 : Math.min(Math.max(value / max, 0), 1);
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      max={max}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-bg-muted", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 rounded-full bg-primary transition-transform duration-base ease-standard motion-reduce:transition-none"
        style={{ transform: `translateX(-${100 - fraction * 100}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
