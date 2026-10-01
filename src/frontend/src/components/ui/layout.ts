import { useEffect, type KeyboardEvent } from "react";
import { layout } from "@/lib/tokens";

/**
 * The R4 layout primitives' shared, non-component parts (SPEC 2): the AutoGrid template, the
 * bottom dock every docked bar uses, and the split view's list keys. A module of its own so the
 * component files export components only (fast refresh), and so a page can reuse the template or
 * the keys without the component around them.
 */
export type Tile = keyof typeof layout.tile;

export const GAP = { sm: "0.5rem", md: "0.75rem", lg: "1rem", xl: "1.5rem" } as const;
export type GridGap = keyof typeof GAP;

/** The `grid-template-columns` an AutoGrid uses — exported so a table-free list can share it. */
export function autoGridTemplate(min: Tile, max: number | undefined, gap: GridGap, fill: "fill" | "fit" = "fill"): string {
  const tile = `min(100%, ${layout.tile[min]})`;
  const track = max && max > 0
    ? `max(${tile}, calc((100% - ${max - 1} * ${GAP[gap]}) / ${max}))`
    : tile;
  return `repeat(auto-${fill}, minmax(${track}, 1fr))`;
}

export const DOCK_BOTTOM = "bottom-[calc(max(var(--app-bottom-bar-height,0px),env(safe-area-inset-bottom,0px))+12px)]";

/** The floating panel a docked bar draws: raised, rounded, centred at 640px on a wide screen. */
export const DOCK_PANEL = "pointer-events-auto mx-auto flex w-full max-w-screen-sm flex-wrap items-center gap-2 rounded-2xl border border-border bg-bg-raised p-2 text-text-primary shadow-lg";

/** The heights of every docked bar on screen; the root variable carries the tallest. */
const docked = new Map<symbol, number>();

function publishDocked() {
  const tallest = Math.max(0, ...docked.values());
  const root = document.documentElement;
  if (tallest > 0) root.style.setProperty("--context-bar-height", `${tallest}px`);
  else root.style.removeProperty("--context-bar-height");
}

/** Publishes `el`'s height (plus its 12px float gap) while it is mounted and displayed. */
export function usePublishDockedHeight(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return undefined;
    const key = Symbol("context-bar");
    const measure = () => {
      const height = el.getBoundingClientRect().height;
      docked.set(key, height > 0 ? Math.round(height) + 12 : 0);
      publishDocked();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      docked.delete(key);
      publishDocked();
    };
  }, [ref, enabled]);
}

const ITEM = "[data-split-item]";

/** Up/Down/Home/End between the list's items, from wherever focus is inside the list. */
export function moveListFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEM));
  if (items.length === 0) return;
  const target = event.target as HTMLElement;
  // A text field or a select inside the list's header keeps its own arrow keys.
  if (target.closest("input, textarea, select, [role=combobox], [role=listbox], [role=menu], [role=tablist]")) return;
  const current = items.findIndex((item) => item === target || item.contains(target));
  const last = items.length - 1;
  const next = {
    ArrowDown: current < 0 ? 0 : Math.min(last, current + 1),
    ArrowUp: current < 0 ? last : Math.max(0, current - 1),
    Home: 0,
    End: last,
  }[event.key as "ArrowDown" | "ArrowUp" | "Home" | "End"];
  event.preventDefault();
  items[next].focus();
  items[next].scrollIntoView?.({ block: "nearest" });
}

