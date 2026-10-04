import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ComponentProps, type CSSProperties, type FocusEvent, type Ref,
} from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { CaretLeft, CaretRight } from "./icons";

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
  // R11 L11-7: a short list WRAPS rather than scroll — at 320 / 200 % "Account" was clipped to
  // "Accou" with no cue that the strip scrolled. Four or more tabs keep the one scrolling row.
  // The gap is pixels so large text goes to the labels.
  underline: cn(
    "flex w-full flex-wrap items-end gap-x-[min(1rem,16px)] overflow-x-auto border-b border-border",
    "[&:has(>:nth-child(4))]:flex-nowrap",
  ),
};

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T }).current = value;
}

/** Which ends of a scrolling list have tabs past them. */
type Overflow = { start: boolean; end: boolean };

/** How wide each edge fade is; a focused tab is kept clear of it (FADE_CLEARANCE). */
const FADE = "1.5rem";
/** The edge caret's width (its glyph is 1rem); the list is fully faded under it. */
const CARET = "1rem";
const FADE_CLEARANCE_REM = 2.5;

/**
 * L12-3 (round 12): a list wider than its box says so — the same cue as the member-detail section
 * tabs (ScrollArea): the edge that has more past it fades out, and a caret sits on it (EdgeCaret),
 * so the row reads as one swipe away from more. At 320 px / 200 % text /admin/results showed
 * "Disputed" and "Recent" and nothing at all said "Confirmed" and "Removed" existed.
 *
 * <p>
 * A MASK, not an overlay: a tab list sits on the page canvas, a card and a sheet, and a gradient
 * overlay has to name the colour it melts into (ScrollArea's `fade` prop). A mask fades the list
 * itself into whatever is behind it. It is measured, so a list that fits (and every short list,
 * which wraps) has no mask at all. One primitive behaviour for every scrolling tab list, both looks.
 * </p>
 */
function useOverflow(callerRef: Ref<HTMLDivElement> | undefined) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<Overflow>({ start: false, end: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // One pixel of tolerance: sub-pixel layout leaves scrollWidth a fraction over on a list that fits.
    const max = el.scrollWidth - el.clientWidth;
    const start = el.scrollLeft > 1;
    const end = max - el.scrollLeft > 1;
    setOverflow((was) => (was.start === start && was.end === end ? was : { start, end }));
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    const observer = typeof ResizeObserver === "undefined" || !el ? null : new ResizeObserver(measure);
    if (el) {
      observer?.observe(el);
      for (const child of Array.from(el.children)) observer?.observe(child);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);
  // The list's ref is ours AND the caller's (PlayerPicker measures its list).
  const setRef = useCallback((el: HTMLDivElement | null) => {
    ref.current = el;
    assignRef(callerRef, el);
  }, [callerRef]);
  return { setRef, overflow, measure };
}

function edgeMask({ start, end }: Overflow): CSSProperties | undefined {
  if (!start && !end) return undefined;
  // The fade ENDS where the caret begins (CARET), so the caret never sits on half-faded letters.
  const from = start ? `transparent ${CARET}, #000 calc(${CARET} + ${FADE})` : "#000 0";
  const to = end ? `#000 calc(100% - ${CARET} - ${FADE}), transparent calc(100% - ${CARET})` : "#000 100%";
  const mask = `linear-gradient(to right, ${from}, ${to})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * The tab that took focus is scrolled (the list, never the page) until it sits clear of both
 * fades, so a focus ring is never drawn half-faded (the member tabs' R5 X5-9, here for every list).
 */
function keepClearOfFades(event: FocusEvent<HTMLDivElement>) {
  const list = event.currentTarget;
  const tab = event.target;
  if (!(tab instanceof HTMLElement) || tab === list || list.scrollWidth - list.clientWidth <= 1) return;
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const clear = Math.min(FADE_CLEARANCE_REM * root, list.clientWidth / 4);
  const left = tab.getBoundingClientRect().left - list.getBoundingClientRect().left;
  const right = left + tab.getBoundingClientRect().width;
  if (left < clear) list.scrollLeft += left - clear;
  else if (right > list.clientWidth - clear) list.scrollLeft += right - (list.clientWidth - clear);
}

export function TabsList(props: ComponentProps<typeof TabsPrimitive.List>) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { className, ref, style, onScroll, onFocus, ...rest } = props;
  const variant = useContext(TabsVariantContext);
  const { setRef, overflow, measure } = useOverflow(ref);
  return (
    // The wrapper only positions the edge carets; the list keeps its own classes and layout.
    <div data-slot="tabs-list-frame" className={cn("relative min-w-0 max-w-full", variant === "segmented" && "w-fit")}>
    <TabsPrimitive.List
      ref={setRef}
      data-slot="tabs-list"
      data-overflow={overflow.start || overflow.end ? [overflow.start && "start", overflow.end && "end"].filter(Boolean).join(" ") : undefined}
      className={cn(LIST[variant], className)}
      style={{ ...style, ...edgeMask(overflow) }}
      onScroll={(e) => { measure(); onScroll?.(e); }}
      onFocus={(e) => { keepClearOfFades(e); onFocus?.(e); }}
      {...rest}
    />
    <EdgeCaret side="start" shown={overflow.start} />
    <EdgeCaret side="end" shown={overflow.end} />
    </div>
  );
}

/**
 * A caret over the faded edge. The fade alone is not enough: at 320 px / 200 % the gap between
 * "Recent" and "Confirmed" fell exactly on the list's edge, so no tab was cut and the fade had
 * nothing to fade. Decoration (aria-hidden, no pointer events): a tablist already says "tab 2 of
 * 4", and the tabs themselves are reached by the arrow keys and a swipe.
 */
function EdgeCaret({ side, shown }: { side: "start" | "end"; shown: boolean }) {
  if (!shown) return null;
  const Glyph = side === "start" ? CaretLeft : CaretRight;
  return (
    <span
      aria-hidden="true"
      data-tabs-edge={side}
      className={cn("pointer-events-none absolute inset-y-0 flex items-center text-text-secondary", side === "start" ? "left-0" : "right-0")}
    >
      <Glyph size="1rem" weight="bold" />
    </span>
  );
}

const TRIGGER_BASE = [
  "no-lift relative inline-flex min-h-touch shrink-0 items-center justify-center gap-[min(0.5rem,8px)] whitespace-nowrap",
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
    "rounded-md px-[min(0.75rem,12px)]",
    "data-[state=active]:border-border data-[state=active]:bg-bg-surface data-[state=active]:text-accent-strong",
    FORCED_ACTIVE,
  ),
  underline: cn(
    "px-[min(0.25rem,4px)]",
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
