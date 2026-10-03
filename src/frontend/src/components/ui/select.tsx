import type { ComponentProps } from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { CaretDown, CaretUp, Check } from "@/components/ui/icons";
import { useFieldControl } from "./field";
import { fieldSurface } from "./input";

/**
 * Select — Radix Select, shadcn new-york restyled (design-system.md, Components → select).
 *
 * <p>
 * The trigger wears the field surface (control edge, 44px, radius lg) and takes its id, help
 * and error wiring from an enclosing `Field`. The list is a popover-level surface: `bg-raised`,
 * radius xl, elevation 3, `z-popover` so it opens above a dialog. Options are 44px tall and
 * `no-lift` — an option is chosen, not pressed. No `outline-none`; the house outline is pulled
 * INSIDE an option so the list's own overflow never clips it.
 * </p>
 */
export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
/**
 * The chosen value, clamped to one line. The clamp lives HERE rather than on the trigger's
 * `[&>span]`: a trigger whose child span is a layout wrapper (TimeSelect's icon + value row) had
 * that wrapper turned into a `-webkit-box` by the clamp, which stacked the clock above the time.
 */
export function SelectValue({ className, ...props }: ComponentProps<typeof SelectPrimitive.Value>) {
  // A wrapper because Radix's Value drops `className` (and `style`) on purpose.
  return (
    <span data-slot="select-value" className={cn("line-clamp-1 min-w-0", className)}>
      <SelectPrimitive.Value {...props} />
    </span>
  );
}

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  const wired = useFieldControl(props);
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        fieldSurface,
        "flex min-h-touch items-center justify-between gap-2 whitespace-nowrap px-3 py-2 text-left",
        "data-[placeholder]:text-text-muted",
        className,
      )}
      {...wired}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <CaretDown aria-hidden="true" size="1rem" className="shrink-0 text-text-secondary" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

const scrollButton = "flex h-8 cursor-default items-center justify-center text-text-secondary";

export function SelectScrollUpButton({ className, ...props }: ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton data-slot="select-scroll-up" className={cn(scrollButton, className)} {...props}>
      <CaretUp aria-hidden="true" size="1rem" />
    </SelectPrimitive.ScrollUpButton>
  );
}

export function SelectScrollDownButton({ className, ...props }: ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton data-slot="select-scroll-down" className={cn(scrollButton, className)} {...props}>
      <CaretDown aria-hidden="true" size="1rem" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export function SelectContent({
  className, children, position = "popper", ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  const popper = position === "popper";
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          "relative z-popover max-h-[var(--radix-select-content-available-height)] min-w-32 overflow-y-auto overflow-x-hidden",
          "rounded-xl border border-border bg-bg-raised text-text-primary shadow-md",
          "origin-[var(--radix-select-content-transform-origin)]",
          "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none",
          popper && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn("p-1", popper && "w-full min-w-[var(--radix-select-trigger-width)]")}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-overline text-text-secondary", className)}
      {...props}
    />
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "no-lift relative flex min-h-touch w-full cursor-pointer select-none items-center rounded-lg border border-transparent",
        "py-2 pl-3 pr-9 text-sm text-text-primary focus-visible:-outline-offset-2",
        "data-[highlighted]:bg-bg-muted data-[state=checked]:font-semibold",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-3 flex size-4 items-center justify-center text-accent-strong">
        <SelectPrimitive.ItemIndicator>
          <Check aria-hidden="true" size="1rem" weight="bold" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}
