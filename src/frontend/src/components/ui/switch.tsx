import type { ComponentProps } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useFieldControl } from "./field";

/**
 * Switch — 44×26 (design-system.md), a 44px-tall hit area from an `after:` box. The track's
 * off colour is the control edge (≥3:1 against the surface); on is the primary fill. The thumb
 * is the ink that sits on primary in both themes. `no-lift`: a switch is flipped, not pressed.
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  const wired = useFieldControl(props);
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "no-lift peer relative inline-flex h-[26px] w-11 shrink-0 items-center rounded-full border-2 border-transparent",
        "after:absolute after:-inset-y-[11px] after:inset-x-0",
        "bg-control data-[state=checked]:bg-primary",
        "transition-colors duration-fast ease-standard motion-reduce:transition-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...wired}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-[22px] rounded-full bg-primary-ink shadow-sm",
          "translate-x-0 data-[state=checked]:translate-x-[18px]",
          "transition-transform duration-fast ease-standard motion-reduce:transition-none",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
