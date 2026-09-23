import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Popover — Radix, restyled (design-system.md: elevation 3 = raised + border + md, radius xl).
 *
 * <p>
 * `z-popover` (60) sits above `z-modal` (50) on purpose: a popover opened from inside a dialog —
 * a date picker in the booking sheet — portals to `<body>` and must still paint over the dialog
 * that owns it.
 * </p>
 */

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;

/** The raised panel. `sideOffset` 6 leaves a clear gap from the trigger's focus outline. */
function PopoverContent({
  className,
  align = "center",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-popover w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-bg-raised p-4",
          "text-sm text-text-primary shadow-md origin-[--radix-popover-content-transform-origin]",
          "animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent };
