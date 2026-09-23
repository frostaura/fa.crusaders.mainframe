import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Tooltip — for NAMES only (design-system.md, Components).
 *
 * <p>
 * A tooltip names an icon-only control ("Refresh", "Select slots"). It never carries an
 * explanation: tooltips do not exist on touch, so guidance placed in one is guidance a phone user
 * never sees. Explanations go in `InfoPopover`, which is a button and works under a thumb.
 * </p>
 *
 * <p>
 * `Tooltip` brings its own provider (the shadcn v4 shape) so it works wherever it is dropped with
 * no app-level wrapper. The cost: each tooltip keeps its own delay, so moving between two toolbar
 * icons waits the delay again. `TooltipProvider` is exported for a surface that wants the delay
 * shared by rendering `TooltipPrimitive`-level roots itself; call sites do not need it.
 * </p>
 */

function TooltipProvider({ delayDuration = 300, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-tooltip max-w-xs rounded-md border border-border bg-bg-raised px-2 py-1 text-xs font-medium",
          "text-text-primary shadow-md origin-[--radix-tooltip-content-transform-origin]",
          "animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
