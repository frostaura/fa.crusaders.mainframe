import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { CircleNotch } from "@/components/ui/icons";

type SpinnerProps = Omit<ComponentProps<typeof CircleNotch>, "ref"> & {
  /**
   * Say what is working ("Loading bookings"). With a label the spinner is a `role="status"`;
   * without one it is decoration — a button that is busy says so through `aria-busy`, and a
   * second announcement would only be noise.
   */
  label?: string;
};

/**
 * The one "working" mark (design-system.md, Icons: working = spinner). A notched circle that
 * turns; under reduced motion it stands still and stays legible as "not finished".
 */
export function Spinner({ label, className, ...props }: SpinnerProps) {
  const a11y = label ? { role: "status", "aria-label": label } : { "aria-hidden": true };
  return (
    <CircleNotch
      data-slot="spinner"
      weight="bold"
      className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
      {...a11y}
      {...props}
    />
  );
}
