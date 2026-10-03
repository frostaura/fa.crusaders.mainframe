import { createContext, useContext, useMemo, useRef, type ComponentProps, type FocusEvent, type KeyboardEvent } from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { toggleVariants, type ToggleVariantProps } from "./toggle-variants";

/**
 * ToggleGroup — Radix, roving focus. `type="single"` is the week strip's and every segmented
 * filter's shape; each item is a `toggleVariants` button.
 *
 * <p>
 * <b>A single group is a radio group, so the arrow keys SELECT (F4-11).</b> Radix renders
 * `type="single"` as `role="radiogroup"` of `role="radio"` items but only moves focus on an arrow,
 * leaving the choice where it was: a keyboard member on the top-up amounts arrowed to R500, heard
 * "R500, radio button, not checked", and paid R100. The ARIA radio pattern — and every native
 * radio — moves the selection with the focus. So when an item receives focus from an arrow (or
 * Home/End) inside the group, it is chosen, exactly as a click would choose it. A `multiple`
 * group is a set of independent toggles and keeps arrows as movement only.
 * </p>
 */
/** `takeArrow` answers "did an arrow in this group just move focus here?" once, then forgets. */
type GroupContext = ToggleVariantProps & { takeArrow: (() => boolean) | null };

const ToggleGroupContext = createContext<GroupContext>({ variant: "default", size: "md", takeArrow: null });

const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/** Radix moves focus a tick after the key; a focus later than this was not the arrow's. */
const ARROW_FOCUS_WINDOW_MS = 250;

export function ToggleGroup(props: ComponentProps<typeof ToggleGroupPrimitive.Root> & ToggleVariantProps) {
  const { className, variant, size, children, onKeyDown, ...rest } = props;
  const arrowedAt = useRef(0);
  const single = rest.type === "single";
  const context = useMemo<GroupContext>(() => ({
    variant,
    size,
    takeArrow: single
      ? () => {
        const fresh = Date.now() - arrowedAt.current <= ARROW_FOCUS_WINDOW_MS;
        arrowedAt.current = 0;
        return fresh;
      }
      : null,
  }), [variant, size, single]);
  const noteArrow = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (NAVIGATION_KEYS.has(event.key)) arrowedAt.current = Date.now();
  };
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("flex w-fit flex-wrap items-center gap-1", className)}
      onKeyDown={noteArrow}
      {...(rest as ComponentProps<typeof ToggleGroupPrimitive.Root>)}
    >
      <ToggleGroupContext.Provider value={context}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

export function ToggleGroupItem(props: ComponentProps<typeof ToggleGroupPrimitive.Item> & ToggleVariantProps) {
  const { className, variant, size, onFocus, ...rest } = props;
  const group = useContext(ToggleGroupContext);
  const selectIfArrowed = (event: FocusEvent<HTMLButtonElement>) => {
    onFocus?.(event);
    if (!group.takeArrow?.()) return;
    const item = event.currentTarget;
    if (item.getAttribute("data-state") !== "on" && !item.disabled) item.click();
  };
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(toggleVariants({ variant: variant ?? group.variant, size: size ?? group.size }), className)}
      onFocus={selectIfArrowed}
      {...rest}
    />
  );
}
