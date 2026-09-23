import * as React from "react";
import { Info } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * An (i) button that opens guidance — the explanation surface (design-system.md, Components).
 *
 * <p>
 * Where a tooltip only NAMES a control, this EXPLAINS a setting: what it does, what the default
 * means, what changing it costs. It is a real 44px button named "More about &lt;label&gt;", so it
 * works on touch, by keyboard and for a screen reader — none of which a hover tooltip does. Used
 * beside Settings fields.
 * </p>
 */
type InfoPopoverProps = {
  /** What the guidance is about — becomes "More about {label}" and the popover's heading. */
  label: string;
  children: React.ReactNode;
  side?: React.ComponentProps<typeof PopoverContent>["side"];
  className?: string;
};

function InfoPopover({ label, children, side = "top", className }: InfoPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger
        data-slot="info-popover-trigger"
        aria-label={`More about ${label}`}
        className={cn(
          "inline-flex size-touch shrink-0 items-center justify-center rounded-full border border-transparent",
          "text-text-secondary transition-colors duration-fast ease-standard hover:bg-bg-muted hover:text-text-primary",
          "data-[state=open]:text-accent-strong motion-reduce:transition-none",
          className,
        )}
      >
        <Info size={20} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent side={side} className="w-80" aria-label={label}>
        <p className="mb-1 font-semibold text-text-primary">{label}</p>
        <div className="text-text-secondary">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

export { InfoPopover };
export type { InfoPopoverProps };
