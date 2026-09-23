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
  "no-lift group relative flex min-h-tabbar flex-col items-center justify-center gap-1 px-1 text-xs font-medium",
  "transition-colors duration-fast ease-standard motion-reduce:transition-none",
  "md:min-h-touch md:flex-row md:gap-2 md:rounded-lg md:px-3 md:text-sm",
].join(" ");

/**
 * The icon's backdrop: a pill behind the active tab's icon on the phone. From `md` it is
 * `display: contents` — the icon and the badge become the link's own flex items, so the badge can
 * take `order-last` and sit AFTER the label instead of on top of it.
 */
const ICON_PILL = [
  "relative flex h-8 w-14 max-w-full items-center justify-center rounded-full transition-colors duration-fast ease-standard",
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
          <span className={cn(ICON_PILL, isActive && "bg-accent-soft")}>
            <Glyph weight={isActive ? "fill" : "regular"} aria-hidden="true" className="size-6 md:size-5" />
            {badge ? <CountBadge attention={badge} /> : null}
          </span>
          <span className="max-w-full truncate">{label}</span>
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
        "absolute -top-1 right-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5",
        "bg-danger-solid text-xs font-semibold tabular-nums text-danger-ink ring-2 ring-bg-surface",
        "md:static md:order-last md:ring-0",
      )}
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
