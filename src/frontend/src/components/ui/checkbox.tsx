import type { ComponentProps } from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { Check, Minus } from "@/components/ui/icons";
import { useFieldControl } from "./field";

/**
 * Checkbox (design-system.md: 20px, radius sm 6, 2px control edge). A 44px hit area from an
 * `after:` box so a dense row stays tappable without growing. `no-lift`: a checkbox is chosen,
 * not pressed. Radix follows WAI-ARIA: Space toggles, Enter does not.
 */
export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  const wired = useFieldControl(props);
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "no-lift group peer relative size-5 shrink-0 rounded-sm border-2 border-control bg-bg-surface text-primary-ink",
        "after:absolute after:-inset-[14px]",
        "transition-colors duration-fast ease-standard motion-reduce:transition-none",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
        "aria-[invalid=true]:border-danger-strong",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...wired}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center">
        <Check aria-hidden="true" size="0.875rem" weight="bold" className="group-data-[state=indeterminate]:hidden" />
        <Minus aria-hidden="true" size="0.875rem" weight="bold" className="hidden group-data-[state=indeterminate]:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
