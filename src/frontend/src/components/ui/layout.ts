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


/**
 * The admin rail's width (R6 X6-5): 16rem, but never more than a quarter of the window — at 200 %
 * text a 16rem rail was 512px of a 1280 screen and squeezed every admin title beside it. Shared
 * here because three boxes must agree on it to the pixel: the rail itself (`AdminRail`), the crest
 * box over it and the shut-doors banner's offset beside it (`AppShell`). Full literal class strings
 * so Tailwind generates them; arbitrary lengths live in `components/ui` only (theme-vocabulary).
 */
export const ADMIN_RAIL_WIDTH = "w-[max(256px,min(16rem,24vw))]";
export const ADMIN_RAIL_WIDTH_XL = "xl:w-[max(256px,min(16rem,24vw))]";
export const ADMIN_RAIL_OFFSET_XL = "xl:ml-[max(256px,min(16rem,24vw))]";

/**
 * R7 L7-6 / J7-5 — the rail's insets and its row gap stop growing with the text at 12px. The rail
 * is capped at 24vw (307px at 1280), and at 200 % text three rem insets (nav, row, icon gap: 72px)
 * left "Transactions" 147px and broke it "Transactio / ns". The words grow; the gutters need not.
 */
export const ADMIN_RAIL_INSET = "px-[min(0.75rem,12px)]";
export const ADMIN_RAIL_ROW = "gap-[min(0.75rem,12px)] px-[min(0.75rem,12px)]";

/**
 * R7 L7-10 — a filter bar's inset and its selects' side padding stop growing at 16px / 12px. At
 * 320 / 200 % the bar's 32px and the trigger's 24px a side left a value 108px, and "Anything"
 * (130px) was cut. The words grow; the gutters need not.
 */
export const FILTER_BAR_INSET = "p-[min(1rem,16px)]";
export const FILTER_TRIGGER_INSET = "px-[min(0.75rem,12px)]";

/**
 * R6 L6-16 — an icon button's glyph: 20px at 100 % text, growing with it (1.25rem), in a target
 * that is 44px at least and grows too (2rem — 64px at 200 %, so a header row does not double). At 200 % text the refresh and the dialog's ×
 * stayed 20px beside 32px words. The refresh button and the dialog's close share it.
 */
export const SCALING_ICON = "1.25rem";
export const SCALING_ICON_TARGET = "size-[max(44px,2rem)]";

/**
 * R8 L8-9 — the admin bar's crest box (over the rail, from xl) is a query container, and the club's
 * name goes when the box is under 12.75rem: the mark and the whole name need 44px + ~10.1rem, so at
 * 200 % text the name hid instead of truncating to "Crusader…" in a 307px box, and at 100 % (even
 * the 256px rail at 1920) it shows whole. `!` — the bar's own `@[60rem]/appbar:block` must not win.
 */
export const CREST_BOX_OVER_RAIL = "xl:@container/crest";
export const CREST_NAME_FITS_BOX = "[@container_crest_(max-width:12.75rem)]:!hidden";
