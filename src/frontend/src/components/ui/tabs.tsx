import { createContext, useContext, type ComponentProps } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Tabs — Radix (roving focus; the arrow keys move and, in the default automatic mode, select).
 *
 * <p>
 * Two looks (design-system.md, Components → tabs): `segmented` — a sunken track whose active
 * segment is lifted to the surface, for switching a view in place — and `underline` — a hairline
 * with an accent bar under the active tab, for page-level sections. The active tab is also
 * weight- and colour-distinct, and in forced colours it takes `Highlight` (index.css). Every
 * trigger is 44px and `no-lift`; the house `:focus-visible` outline is the ring.
 * </p>
 */
type TabsVariant = "segmented" | "underline";

const TabsVariantContext = createContext<TabsVariant>("segmented");

export function Tabs({
  className, variant = "segmented", ...props
}: ComponentProps<typeof TabsPrimitive.Root> & { variant?: TabsVariant }) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.Root
        data-slot="tabs"
        data-variant={variant}
        className={cn("flex flex-col gap-4", className)}
        {...props}
      />
    </TabsVariantContext.Provider>
  );
}

const LIST: Record<TabsVariant, string> = {
  segmented: "inline-flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-bg-muted p-1",
  underline: "flex w-full items-end gap-4 overflow-x-auto border-b border-border",
};

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  const variant = useContext(TabsVariantContext);
  return <TabsPrimitive.List data-slot="tabs-list" className={cn(LIST[variant], className)} {...props} />;
}

const TRIGGER_BASE = [
  "no-lift relative inline-flex min-h-touch shrink-0 items-center justify-center gap-2 whitespace-nowrap",
  "border border-transparent text-sm font-semibold text-text-secondary",
  "transition-colors duration-fast ease-standard motion-reduce:transition-none",
  "hover:text-text-primary disabled:pointer-events-none disabled:opacity-50",
  // The list scrolls sideways on a phone, and a scroller clips an outline drawn outside it.
  "focus-visible:-outline-offset-2",
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
].join(" ");

/**
 * Forced colours (F4-5): the mode throws away every author colour that is not a system colour, and
 * the state classes here (`bg-accent-soft`, `bg-bg-surface`, `bg-primary`) outrank index.css's
 * `Highlight` rule by source order — so a checked card, an active tab and an "on" toggle rendered
 * exactly like their neighbours. These `forced-colors:` utilities restate each state in system
 * colours, in the same layer, so they win.
 */
const FORCED_ACTIVE = cn(
  "forced-colors:data-[state=active]:border-[Highlight] forced-colors:data-[state=active]:bg-[Highlight] forced-colors:data-[state=active]:text-[HighlightText]",
  // X-1 (round 3): without this the mode draws a Canvas backplate behind the label, and
  // HighlightText on Canvas is white on white (black on black in a dark palette).
  "forced-colors:data-[state=active]:[forced-color-adjust:none]",
);

const TRIGGER: Record<TabsVariant, string> = {
  segmented: cn(
    "rounded-md px-3",
    "data-[state=active]:border-border data-[state=active]:bg-bg-surface data-[state=active]:text-accent-strong",
    FORCED_ACTIVE,
  ),
  underline: cn(
    "px-1",
    "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent",
    "data-[state=active]:text-text-primary data-[state=active]:after:bg-accent-strong",
    FORCED_ACTIVE,
    "forced-colors:data-[state=active]:after:bg-[HighlightText]",
  ),
};

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(TRIGGER_BASE, TRIGGER[variant], className)}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("min-w-0", className)} {...props} />;
}
