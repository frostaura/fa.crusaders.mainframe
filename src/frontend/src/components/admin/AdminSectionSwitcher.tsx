import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { typography } from "@/lib/typography";
import type { AdminAttention } from "@/lib/adminAttention";
import { CaretUpDown } from "@/components/ui/icons";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { AdminNavList } from "./AdminRail";
import { activeAdminItem, adminGroupOf, ADMIN_NAV_ITEMS, type AdminNavItem } from "./adminNav";

/**
 * The admin console below `xl`: a compact bar at the top of every admin page naming where you are,
 * which opens every other section in a bottom sheet (plan: Target IA → Admin, mobile).
 *
 * <p>
 * The bar IS the button — one 56px row, full width, under the thumb — rather than a label with a
 * small control beside it. It names the section in words (its group over its name), not as a heading:
 * the page below owns the only `h1`. The sheet lists the same `AdminNavList` the desktop rail
 * renders, so the two can never disagree.
 * </p>
 *
 * <p>
 * <b>Focus.</b> Closed with ×, Escape or the scrim, focus returns to the bar (Radix's default).
 * Closed by FOLLOWING a row to another page, it does not: the route announcer moves focus to the new
 * page's `h1`, and handing it back to the bar a frame later would undo that. Following the row for
 * the page you are already on is not a navigation, so focus goes back to the bar as for ×.
 * </p>
 */

export type AdminSectionSwitcherProps = {
  pathname: string;
  attention: Pick<AdminAttention, "pending" | "doors" | "faults" | "total" | "label">;
  className?: string;
};

/** The item to name on the bar — the Overview when the path is somehow outside every item. */
function currentItem(pathname: string): AdminNavItem {
  return activeAdminItem(pathname) ?? ADMIN_NAV_ITEMS[0];
}

/** "People Members, 2 membership applications awaiting review, change section". */
function switcherName(item: AdminNavItem, attention: AdminSectionSwitcherProps["attention"]): string {
  const group = adminGroupOf(item);
  const eyebrow = group && group.label !== item.label ? group.label : "Admin";
  const count = attention.total > 0 ? `, ${attention.label}` : "";
  return `${eyebrow} ${item.label}${count}, change section`;
}

function TriggerContent({ item, attention }: { item: AdminNavItem; attention: AdminSectionSwitcherProps["attention"] }) {
  const ItemIcon = item.icon;
  const group = adminGroupOf(item);
  // The group alone — "Courts & hardware" — because "Admin · Courts & hardware" wraps at 360px.
  const eyebrow = group && group.label !== item.label ? group.label : "Admin";
  return (
    <>
      {/* The tile is the 20px icon plus padding, not a rem box: `size-9` doubled to 72px at 200%
          text and squeezed the words into breaking mid-letter (review round 2, F4 → F3). */}
      <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center rounded-lg bg-accent-soft p-2 text-accent-strong">
        <ItemIcon size={20} weight="fill" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start text-left">
        {/* Wrapping, never truncating: at a 32px root font on a 320px phone "Courts & hardware"
            is wider than the bar, and a clipped section name is a silent loss (e2e/admin-doors).
            `break-words` breaks a word only when it cannot fit its line at all — at 390 with 200%
            text "HARDWARE" now fits whole (the tile no longer doubles); at 320 nothing can. */}
        <span className={cn(typography({ variant: "overline" }), "w-full break-words")}>{eyebrow}</span>
        <span className="w-full break-words text-base font-semibold text-text-primary">{item.label}</span>
      </span>
      {attention.total > 0 ? (
        <span
          aria-hidden="true"
          data-admin-badge="total"
          className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-warning-soft px-1.5 py-0.5 text-xs font-semibold leading-none tabular-nums text-warning-strong"
        >
          {attention.total > 99 ? "99+" : attention.total}
        </span>
      ) : null}
      <CaretUpDown size={20} aria-hidden="true" className="shrink-0 text-text-secondary" />
    </>
  );
}

export function AdminSectionSwitcher({ pathname, attention, className }: AdminSectionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const navigatedAway = useRef(false);
  const bar = useRef<HTMLButtonElement>(null);
  const item = currentItem(pathname);

  const onNavigate = (_item: AdminNavItem, wasActive: boolean) => {
    navigatedAway.current = !wasActive;
    setOpen(false);
  };

  return (
    <div data-admin-section-bar="" className={cn("border-b border-border bg-bg-surface px-2 py-1 sm:px-4 lg:px-6 xl:hidden print:hidden", className)}>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            ref={bar}
            type="button"
            // One phrase, as an aria-label: hidden spans beside flex items read "Members , 2 …"
            // in Chromium (see `attentionName` in AdminRail). Opens with the words on screen.
            aria-label={switcherName(item, attention)}
            className={cn(
              // px-2 inside the bar's own px-2 (sm: px-4, lg: px-6) puts the icon on the page gutter (16 / 24 / 32px).
              "no-lift flex min-h-appbar w-full items-center gap-3 rounded-lg border border-transparent px-2",
              "transition-colors duration-fast ease-standard hover:bg-bg-muted motion-reduce:transition-none",
            )}
          >
            <TriggerContent item={item} attention={attention} />
          </button>
        </SheetTrigger>
        <SheetContent
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // Placed here rather than left to the surface: the shared dialog returns focus to
            // whatever HAD focus at open, and a tap that opened this (Safari and touch never
            // focus a button on click) left that as <body> → <main>, not the bar.
            event.preventDefault();
            if (!navigatedAway.current) bar.current?.focus();
            navigatedAway.current = false;
          }}
        >
          <SheetHeader>
            <SheetTitle>Admin sections</SheetTitle>
          </SheetHeader>
          <SheetBody className="pb-6">
            <nav aria-label="Admin">
              <AdminNavList pathname={pathname} counts={attention} density="sheet" onNavigate={onNavigate} />
            </nav>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
