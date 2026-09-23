import { createContext, useContext, type ComponentProps } from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { toggleVariants, type ToggleVariantProps } from "./toggle";

/**
 * ToggleGroup — Radix, roving focus (arrow keys move, Space/Enter set). `type="single"` is the
 * week strip's and every segmented filter's shape; each item is a `toggleVariants` button.
 */
const ToggleGroupContext = createContext<ToggleVariantProps>({ variant: "default", size: "md" });

export function ToggleGroup({
  className, variant, size, children, ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Root> & ToggleVariantProps) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("flex w-fit flex-wrap items-center gap-1", className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

export function ToggleGroupItem({
  className, variant, size, ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Item> & ToggleVariantProps) {
  const group = useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(toggleVariants({ variant: variant ?? group.variant, size: size ?? group.size }), className)}
      {...props}
    />
  );
}
