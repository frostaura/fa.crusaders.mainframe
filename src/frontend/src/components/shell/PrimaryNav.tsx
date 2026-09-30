import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { destinationsFor, type PrimaryDestination } from "./nav";
import type { AdminAttention } from "@/lib/adminAttention";

/**
 * The primary navigation — ONE `<nav>`, two presentations (Target IA → Shell).
 *
 * <ul>
 *   <li><b>Below `md`</b> it is the phone's bottom tab bar: fixed to the bottom edge, 64px of
 *   equal-width tabs (24px icon, filled when active, over an xs label) plus the home-indicator
 *   safe area. Its height is published as <code>--app-bottom-bar-height</code> so the page, the
 *   toast strip and the multiselect ActionBar all sit above it.</li>
 *   <li><b>From `md`</b> it is inline in the top bar: 44px pills, icon + label.</li>
 * </ul>
 *
 * <p>
 * One DOM copy on purpose. The previous chrome rendered its tabs twice (an inline nav and a
 * scrolling strip) and needed paired assertions to stop the copies drifting; a single list with
 * responsive classes cannot drift, announces one set of links, and gives `aria-current` once.
 * The fixed positioning works from inside the sticky header because nothing above it sets a
 * transform, filter or backdrop-filter — keep it that way, or the bar is trapped in the header.
 * </p>
 */
export function PrimaryNav({ isAdmin, attention }: { isAdmin: boolean; attention: Pick<AdminAttention, "total" | "label"> }) {
  const ref = useRef<HTMLElement>(null);
  usePublishBottomBarHeight(ref);
  const items = destinationsFor(isAdmin);
  return (
    <nav
      ref={ref}
      aria-label="Main"
      data-primary-nav=""
      className={cn(
        "fixed inset-x-0 bottom-0 z-chrome border-t border-border bg-bg-surface shadow-md",
        "md:static md:z-auto md:min-w-0 md:border-0 md:bg-transparent md:shadow-none",
      )}
      style={{ paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}
    >
      <ul className="grid auto-cols-fr grid-flow-col md:flex md:items-center md:gap-1">
        {items.map((item) => (
          <li key={item.to} className="min-w-0">
            <PrimaryLink item={item} badge={item.adminOnly ? attention : null} />
          </li>
        ))}
      </ul>
      {/* The home indicator's inset, on the phone bar only — it is 0 on a desktop anyway. */}
      <div aria-hidden="true" className="md:hidden" style={{ height: "env(safe-area-inset-bottom)" }} />
    </nav>
  );
}

const LINK = [
  "no-lift group relative flex min-h-tabbar flex-col items-center justify-center gap-1 px-0.5 text-xs font-medium",
  "transition-colors duration-fast ease-standard motion-reduce:transition-none",
  "md:min-h-touch md:flex-row md:gap-2 md:rounded-lg md:px-2 md:text-sm lg:px-3",
].join(" ");

/**
 * The icon's backdrop: a pill behind the active tab's icon on the phone. From `md` it is
 * `display: contents` — the icon and the badge become the link's own flex items, so the badge can
 * take `order-last` and sit AFTER the label instead of on top of it.
 */
/*
 * F4-7: the pill and the glyph are PIXEL-sized on the phone bar. A tab bar whose icons doubled with
 * the text left no room for the words to wrap at 200 % (B12's "the page keeps 60 % of a 320×568
 * screen" and "the bars grow only by their text"); an icon is not text and needs no resize.
 */
/** The pill's pixel box (F4-7, above); `display: contents` from `md` ignores it. */
/**
 * The count's left edge: 8 px right of the icon's centre, in PIXELS (static from `md`, so ignored).
 * X-10 (round 3): the old `min(50% + 0.5rem, 100% - 1.25rem)` clamped the badge inside the 56 px
 * pill, and at 200 % text the clamp won — the "46" sat on half the shield. The badge now overhangs
 * the pill into its tab's own margin instead, which the smaller badge below leaves room for.
 */
const BADGE_BOX = { left: "calc(50% + 8px)", minWidth: 20, minHeight: 20, padding: "2px 6px" } as const;

const PILL_BOX = { height: 32, maxWidth: 56 } as const;

const ICON_PILL = [
  "relative flex w-full items-center justify-center rounded-full transition-colors duration-fast ease-standard",
  "motion-reduce:transition-none md:contents",
].join(" ");

function PrimaryLink({ item, badge }: { item: PrimaryDestination; badge: Pick<AdminAttention, "total" | "label"> | null }) {
  const { to, label, icon: Glyph } = item;
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn(
        LINK,
        isActive ? "font-semibold text-accent-strong md:bg-accent-soft" : "text-text-secondary hover:text-text-primary md:hover:bg-bg-muted",
      )}
    >
      {({ isActive }) => (
        <>
          <span className={cn(ICON_PILL, isActive && "bg-accent-soft")} style={PILL_BOX}>
            <Glyph size={24} weight={isActive ? "fill" : "regular"} aria-hidden="true" className="md:size-5" />
            {badge ? <CountBadge attention={badge} /> : null}
          </span>
          {/*
            F4-7 — at 200 % text the four-tab bar cut "My Code" to "My C…" and "Bookings" to
            "Booki…". The label is never cut: it wraps by word, and a single word wider than its
            quarter of the screen overflows its tab evenly on both sides (the tab is centred and
            its neighbours' words are shorter) rather than losing letters. The bar grows by the
            label's lines and publishes its new height, so nothing sits under it.
          */}
          <span data-tab-label="" className="whitespace-normal break-normal text-center leading-tight md:whitespace-nowrap">{label}</span>
        </>
      )}
    </NavLink>
  );
}

/**
 * The Admin tab's count. The digits are decoration; the sentence is the accessible name, so a
 * screen reader hears "Admin, 2 membership applications awaiting review" rather than "Admin 2".
 * A zero renders nothing — a badge is a cue, and a "0" is noise an admin learns to skip.
 */
function CountBadge({ attention }: { attention: Pick<AdminAttention, "total" | "label"> }) {
  if (attention.total <= 0) return null;
  return (
    <span
      data-attention-badge=""
      aria-label={attention.label}
      title={attention.label}
      className={cn(
        // F4-7 — on the icon's top-right CORNER, not across it: at 200 % text the old badge sat on
        // the shield it counts for. Its left edge is just right of the icon's centre, but never so
        // far right that it leaves the tab (the 320 px phone at the largest text), and its foot
        // stops at 60 % of the pill's height, so at most the icon's upper corner is covered.
        // X-10: the digits grow with the text to 20 px and no further, and the box (BADGE_BOX) is
        // pixel-padded around them — a count whose number is also the link's accessible name, not
        // body text. At 200 % a rem box (40 px) was wider than the room right of the icon.
        "absolute bottom-1/2 inline-flex items-center justify-center rounded-full",
        "bg-danger-solid text-[min(0.75rem,20px)] font-semibold leading-none tabular-nums text-danger-ink ring-2 ring-bg-surface",
        "md:static md:order-last md:ml-0 md:ring-0",
      )}
      style={BADGE_BOX}
    >
      {attention.total > 99 ? "99+" : attention.total}
    </span>
  );
}

/**
 * Publishes the bar's height while it IS a bottom bar (fixed), and 0 while it sits inline in the
 * top bar. Measured rather than computed: the label grows with the root font size and the
 * safe-area spacer varies by device. The consumers (`Toast`, `ui/action-bar`, the shell's own
 * `<main>` padding) are mounted outside this component, so it is a custom property on `<html>`.
 */
function usePublishBottomBarHeight(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const nav = ref.current;
    const root = document.documentElement;
    if (!nav) return;
    const publish = () => {
      const fixed = getComputedStyle(nav).position === "fixed";
      const height = fixed ? Math.round(nav.getBoundingClientRect().height) : 0;
      root.style.setProperty("--app-bottom-bar-height", `${height}px`);
    };
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(nav);
    window.addEventListener("resize", publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty("--app-bottom-bar-height");
    };
  }, [ref]);
}
