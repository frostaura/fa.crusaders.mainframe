import type { ComponentProps } from "react";
import { Toggle as TogglePrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { toggleVariants, type ToggleVariantProps } from "./toggle-variants";

/** Toggle — a two-state button; the look and its reasoning are in `toggle-variants.ts`. */
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
