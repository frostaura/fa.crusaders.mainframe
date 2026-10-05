import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { intentProps } from "@/routeChunks";
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
 *   <li><b>Where the top bar is 44rem wide or more</b> (61rem from xl for an admin's four tabs, over the rail — `INLINE`,
 *   R13 L13-3) it is inline in the top bar: 44px pills, icon
 *   + label. V5-3 (review round 5): this was the viewport's `md`, and at 200 % text from 768 to
 *   1440 px the tabs did not fit beside the crest and the actions — the crest stood alone on a row,
 *   the icons were squeezed to slivers. The bar's own width in rem (`@container/appbar` in
 *   `AppShell`) is the same 768 px at normal text, and keeps the bottom bar where the words need it.</li>
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
  const inline = isAdmin ? INLINE.admin : INLINE.member;
  return (
    <nav
      ref={ref}
      aria-label="Main"
      data-primary-nav=""
      className={cn(
        // `@container/tabbar` (L12-1): on the phone the bar is a size container, so a tab's width
        // is `100cqw / --tab-count` and the Admin count can be kept inside its own tab. Inline the
        // nav is sized by its tabs, which inline-size containment would collapse — so not there.
        // (Written as a raw @container variant: the plugin's `@[44rem]/appbar:` emits nothing for
        // a `[container-type:…]` arbitrary property.)
        "@container/tabbar fixed inset-x-0 bottom-0 z-chrome border-t border-border bg-bg-surface shadow-md",
        inline.nav,
      )}
      style={{ paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}
    >
      <ul style={{ "--tab-count": items.length } as React.CSSProperties} className={cn("grid auto-cols-fr grid-flow-col", inline.list)}>
        {items.map((item) => (
          <li key={item.to} className="min-w-0">
            <PrimaryLink item={item} inline={inline} badge={item.adminOnly ? attention : null} />
          </li>
        ))}
      </ul>
      {/* The home indicator's inset, on the phone bar only — it is 0 on a desktop anyway. */}
      <div aria-hidden="true" className={inline.spacer} style={{ height: "env(safe-area-inset-bottom)" }} />
    </nav>
  );
}

const LINK = [
  "no-lift group relative flex min-h-tabbar flex-col items-center justify-center gap-1 px-0.5 text-xs font-medium",
  "transition-colors duration-fast ease-standard motion-reduce:transition-none",
  // The label's size (TAB_LABEL): capped by the column on a phone — and inline too. A container
  // variant setting this property never won: Tailwind emits an arbitrary property AFTER the
  // plugin's `@[…]/appbar:` rules, so inline labels have always been 12px (measured, R13). The
  // dead override is gone rather than kept as a promise; every one-row width was measured at 12px.
  "[--tab-label-size:min(0.75rem,5vw)]",
].join(" ");

/**
 * Where the tabs join the top bar, by the BAR's width in rem (V5-3) — and per tab set (R13 L13-3).
 *
 * <p>
 * A member's three tabs fit beside the crest, the bell, the chip and the avatar from 44rem. An
 * admin's four, with the Admin count, did not: on /admin from xl the crest sits in a box as wide
 * as the rail (24vw at large text), and at 1536–1920 px with 200 % text (1280 px with 150 %) it
 * wrapped, and the bell stood alone top-right while the chip and the avatar hung under it. Swept
 * in Chromium (768–1920 px, 16–32 px text, a "99+" count, 42 unread and a "208 h 20 min" chip):
 * from xl the row needed more than its bar up to 58rem of content (1440 px / 24 px: 58.4 in 58),
 * and the club's name joining the crest at 60rem makes 60–61rem the tightest fit (1280 / 20 px:
 * 60.3 in 62). So from xl an admin's tabs join the bar at 61rem; under that they are the bottom
 * tab bar, as on a phone, and the top bar is one row. Below xl there is no rail and the admin's
 * switch stays the member's 44rem (768 px at normal text holds the whole row — `app-chrome`).
 * Not per route: from xl the tabs never jump between the top and the bottom as an admin goes from
 * My Code to the console.
 * </p>
 *
 * <p>
 * Every class whole (Tailwind's scanner never sees one built from parts). The container-type
 * override is the raw variant: the plugin's `@[…]/appbar:` emits nothing for an arbitrary
 * `[container-type:…]` (L12-1).
 * </p>
 */
const INLINE = {
  member: {
    nav: "[@container_appbar_(min-width:44rem)]:![container-type:normal] @[44rem]/appbar:static @[44rem]/appbar:z-auto @[44rem]/appbar:min-w-0 @[44rem]/appbar:border-0 @[44rem]/appbar:bg-transparent @[44rem]/appbar:shadow-none",
    list: "@[44rem]/appbar:flex @[44rem]/appbar:items-center @[44rem]/appbar:gap-1",
    link: "@[44rem]/appbar:min-h-touch @[44rem]/appbar:flex-row @[44rem]/appbar:gap-2 @[44rem]/appbar:rounded-lg @[44rem]/appbar:px-2 @[44rem]/appbar:text-sm @[56rem]/appbar:px-3",
    active: "@[44rem]/appbar:bg-accent-soft",
    idle: "@[44rem]/appbar:hover:bg-bg-muted",
    pill: "@[44rem]/appbar:contents",
    glyph: "@[44rem]/appbar:size-5",
    label: "@[44rem]/appbar:whitespace-nowrap",
    spacer: "@[44rem]/appbar:hidden",
  },
  admin: {
    nav: "max-xl:[@container_appbar_(min-width:44rem)]:![container-type:normal] xl:[@container_appbar_(min-width:61rem)]:![container-type:normal] max-xl:@[44rem]/appbar:static xl:@[61rem]/appbar:static max-xl:@[44rem]/appbar:z-auto xl:@[61rem]/appbar:z-auto max-xl:@[44rem]/appbar:min-w-0 xl:@[61rem]/appbar:min-w-0 max-xl:@[44rem]/appbar:border-0 xl:@[61rem]/appbar:border-0 max-xl:@[44rem]/appbar:bg-transparent xl:@[61rem]/appbar:bg-transparent max-xl:@[44rem]/appbar:shadow-none xl:@[61rem]/appbar:shadow-none",
    list: "max-xl:@[44rem]/appbar:flex xl:@[61rem]/appbar:flex max-xl:@[44rem]/appbar:items-center xl:@[61rem]/appbar:items-center max-xl:@[44rem]/appbar:gap-1 xl:@[61rem]/appbar:gap-1",
    link: "max-xl:@[44rem]/appbar:min-h-touch xl:@[61rem]/appbar:min-h-touch max-xl:@[44rem]/appbar:flex-row xl:@[61rem]/appbar:flex-row max-xl:@[44rem]/appbar:gap-2 xl:@[61rem]/appbar:gap-2 max-xl:@[44rem]/appbar:rounded-lg xl:@[61rem]/appbar:rounded-lg max-xl:@[44rem]/appbar:px-2 max-xl:@[56rem]/appbar:px-3 xl:@[61rem]/appbar:px-3 max-xl:@[44rem]/appbar:text-sm xl:@[61rem]/appbar:text-sm",
    active: "max-xl:@[44rem]/appbar:bg-accent-soft xl:@[61rem]/appbar:bg-accent-soft",
    idle: "max-xl:@[44rem]/appbar:hover:bg-bg-muted xl:@[61rem]/appbar:hover:bg-bg-muted",
    pill: "max-xl:@[44rem]/appbar:contents xl:@[61rem]/appbar:contents",
    glyph: "max-xl:@[44rem]/appbar:size-5 xl:@[61rem]/appbar:size-5",
    label: "max-xl:@[44rem]/appbar:whitespace-nowrap xl:@[61rem]/appbar:whitespace-nowrap",
    spacer: "max-xl:@[44rem]/appbar:hidden xl:@[61rem]/appbar:hidden",
  },
} as const;

type Inline = (typeof INLINE)[keyof typeof INLINE];

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
/**
 * L12-1 (round 12): ...but never past its own tab. At 320 px and 200 % text the Admin tab is the
 * last of four 80 px columns, and a "51" starting 8 px right of the icon's centre ended at 325 px —
 * off the screen. The left edge is now the SMALLER of that and "the tab's right edge minus the
 * badge's width": the tab is `100cqw / --tab-count` wide (the bar is a size container on the
 * phone), the pill is centred in it, and the badge is its characters in `ch` (tabular digits are
 * one `ch` each) plus its padding and its 2 px ring. On the inline bar the badge is static and
 * `left` does nothing.
 */
function badgeBox(text: string): React.CSSProperties {
  const width = `(${text.length}ch + 12px)`;
  return {
    left: `min(calc(50% + 8px), calc((100cqw / var(--tab-count, 1) + 100%) / 2 - ${width}))`,
    // 1 px above and below (was 2): at 200 % text the box's top reached past the bar's top edge.
    minWidth: 18, minHeight: 18, padding: "1px 4px",
  };
}

const PILL_BOX = { height: 32, maxWidth: 56 } as const;

const ICON_PILL = [
  "relative flex w-full items-center justify-center rounded-full transition-colors duration-fast ease-standard",
  "motion-reduce:transition-none",
].join(" ");

/**
 * R4 — a tab's label never grows past what its column can hold on a phone. At 320 px and 200 %
 * text a 24px "Bookings" was wider than its third of the screen and ran into "Wallet". The label
 * is the normal 0.75rem wherever that fits (5vw is above 12px at every width from 240 px), and at
 * large text on a narrow phone it stops at 5vw — still bigger than normal text, never colliding.
 * From `md` the bar is a row with room, and the label is not capped. A style, not a utility:
 * arbitrary lengths are banned outside `ui/`.
 */
const TAB_LABEL = { fontSize: "var(--tab-label-size)" } as const;

function PrimaryLink({ item, inline, badge }: { item: PrimaryDestination; inline: Inline; badge: Pick<AdminAttention, "total" | "label"> | null }) {
  const { to, label, icon: Glyph } = item;
  return (
    <NavLink
      to={to}
      // P4-5 (R4 wave B) — the page's code AND its reads start at the first sign of intent, not
      // after the tap has loaded the code: pressed (a phone), hovered or focused (a desk).
      {...intentProps(to)}
      className={({ isActive }) => cn(
        LINK,
        inline.link,
        isActive ? cn("font-semibold text-accent-strong", inline.active) : cn("text-text-secondary hover:text-text-primary", inline.idle),
      )}
    >
      {({ isActive }) => (
        <>
          <span className={cn(ICON_PILL, inline.pill, isActive && "bg-accent-soft")} style={PILL_BOX}>
            {/* shrink-0 (V5-3): inline, the icon is the link's own flex item, and a long label squeezed it to a sliver. */}
            <Glyph size={24} weight={isActive ? "fill" : "regular"} aria-hidden="true" className={cn("shrink-0", inline.glyph)} />
            {badge ? <CountBadge attention={badge} /> : null}
          </span>
          {/*
            F4-7 — at 200 % text the four-tab bar cut "My Code" to "My C…" and "Bookings" to
            "Booki…". The label is never cut: it wraps by word, and a single word wider than its
            quarter of the screen overflows its tab evenly on both sides (the tab is centred and
            its neighbours' words are shorter) rather than losing letters. The bar grows by the
            label's lines and publishes its new height, so nothing sits under it.
          */}
          <span data-tab-label="" className={cn("whitespace-normal break-normal text-center leading-tight", inline.label)} style={TAB_LABEL}>{label}</span>
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
  const text = attention.total > 99 ? "99+" : String(attention.total);
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
        // X-10: the digits grow with the text to 20 px and no further, and the box (badgeBox) is
        // pixel-padded around them — a count whose number is also the link's accessible name, not
        // body text. At 200 % a rem box (40 px) was wider than the room right of the icon.
        // shrink-0 (V5-3): inline it is a flex item of the link, and squeezed its "96" out of the circle.
        "absolute bottom-1/2 inline-flex shrink-0 items-center justify-center rounded-full",
        // L12-1: 16 px on the phone bar (14 px for "99+"), so a count kept inside a 320 px
        // screen's last tab still leaves three quarters of the shield showing; inline, 20 px.
        text.length > 2 ? "text-[min(0.75rem,14px)]" : "text-[min(0.75rem,16px)]",
        "bg-danger-solid font-semibold leading-none tabular-nums text-danger-ink ring-2 ring-bg-surface",
        // Inline only where the ADMIN's tabs are (R13 L13-3, `INLINE.admin`): only an admin has this tab.
        "max-xl:@[44rem]/appbar:text-[min(0.75rem,20px)] xl:@[61rem]/appbar:text-[min(0.75rem,20px)] max-xl:@[44rem]/appbar:static xl:@[61rem]/appbar:static max-xl:@[44rem]/appbar:order-last xl:@[61rem]/appbar:order-last max-xl:@[44rem]/appbar:ml-0 xl:@[61rem]/appbar:ml-0 max-xl:@[44rem]/appbar:ring-0 xl:@[61rem]/appbar:ring-0",
      )}
      style={badgeBox(text)}
    >
      {text}
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
