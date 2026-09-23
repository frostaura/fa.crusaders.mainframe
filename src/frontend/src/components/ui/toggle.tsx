import type { ComponentProps } from "react";
import { Toggle as TogglePrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Toggle — a two-state button (`aria-pressed`). On = soft accent fill + accent ink; an icon inside
 * a toggle that is on should switch to its `fill` weight (design-system.md, Icons), so the state
 * never rests on colour alone. `no-lift`: a toggle is set, not pressed.
 */
export const toggleVariants = cva(
  [
    "no-lift inline-flex min-h-touch items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent",
    "text-sm font-semibold text-text-secondary",
    "transition-colors duration-fast ease-standard motion-reduce:transition-none",
    "hover:bg-bg-muted hover:text-text-primary",
    "data-[state=on]:bg-accent-soft data-[state=on]:text-accent-strong",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-control bg-bg-surface data-[state=on]:border-accent-strong",
      },
      size: {
        sm: "min-w-touch px-2.5",
        md: "min-w-touch px-3",
        lg: "min-h-[52px] min-w-[52px] px-4",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export type ToggleVariantProps = VariantProps<typeof toggleVariants>;

export function Toggle({
  className, variant, size, ...props
}: ComponentProps<typeof TogglePrimitive.Root> & ToggleVariantProps) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size }), className)}
      {...props}
    />
  );
}
