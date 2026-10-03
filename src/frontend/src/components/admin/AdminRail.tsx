import { useId, type ReactNode } from "react";
import { ADMIN_RAIL_INSET, ADMIN_RAIL_ROW, ADMIN_RAIL_WIDTH, SCALING_ICON } from "@/components/ui/layout";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { typography } from "@/lib/typography";
import { attentionBadge } from "@/lib/adminAttention";
import { ADMIN_NAV, activeAdminItem, type AdminNavItem } from "./adminNav";
import { attentionName, type BadgeCounts } from "./attentionName";

/**
 * The admin console's navigation, drawn once and placed twice: the desktop rail (this file's
 * `AdminRail`) and the phone's section sheet (`AdminSectionSwitcher`) both render `AdminNavList`,
 * so the two cannot drift in order, wording, icons, badges or active state.
 *
 * <p>
 * <b>Links, never buttons</b> (links navigate): every row is a real anchor, so middle-click and
 * cmd-click open a section in a second tab. The active row carries `aria-current="page"` — colour is
 * never the only signal, so it also gets a weight change and the accent bar on its leading edge.
 * No watermark: nav is on the spec's "never" list.
 * </p>
 */

/**
 * The count bubble. The digits are decoration (`aria-hidden`); the sentence is in the link's name
 * through {@link AttentionSentence} — "Members, 2 membership applications awaiting review". The
 * digits alone beside the word "Doors" mean nothing to a screen reader. Zero renders nothing.
 */
export function AttentionCount({ item, counts }: { item: AdminNavItem; counts: BadgeCounts }) {
  if (!item.badge) return null;
  const { count, label } = attentionBadge(item.badge, counts);
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      data-admin-badge={item.badge}
      title={label}
      className={cn(
        "ml-auto inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 py-0.5",
        "text-xs font-semibold tabular-nums leading-none",
        item.badge === "pending" ? "bg-info-soft text-info-strong" : "bg-warning-soft text-warning-strong",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

type NavRowProps = {
  item: AdminNavItem;
  active: boolean;
  counts: BadgeCounts;
  density: "rail" | "sheet";
  onNavigate?: (item: AdminNavItem, active: boolean) => void;
};

function NavRow(props: NavRowProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { item, active, counts, density, onNavigate } = props;
  const ItemIcon = item.icon;
  return (
    <li>
      <Link
        to={item.path}
        aria-current={active ? "page" : undefined}
        aria-label={attentionName(item, counts)}
        data-admin-nav={item.id}
        onClick={() => onNavigate?.(item, active)}
        className={cn(
          "no-lift relative flex min-h-touch items-center rounded-lg text-sm",
          density === "rail" ? ADMIN_RAIL_ROW : "gap-3 px-3",
          "transition-colors duration-fast ease-standard motion-reduce:transition-none",
          density === "sheet" && "text-base",
          active
            ? [
              "bg-accent-soft font-semibold text-accent-strong",
              "before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-accent-strong",
            ]
            : "font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary",
        )}
      >
        {/* R6 L6-16 (FD1 ask): the icon grows with the text, and the name WRAPS at its words —
            at 320 / 200 % "Match results" was cut to "Match re…". */}
        <ItemIcon size={SCALING_ICON} weight={active ? "fill" : "regular"} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 break-words py-1">{item.label}</span>
        <AttentionCount item={item} counts={counts} />
      </Link>
    </li>
  );
}

export type AdminNavListProps = {
  pathname: string;
  counts: BadgeCounts;
  density?: "rail" | "sheet";
  /** Called as a row is followed — the sheet closes itself here. `active` = it was already the page. */
  onNavigate?: (item: AdminNavItem, active: boolean) => void;
};

/** The grouped list itself: an overline per group, a `<ul>` of rows under it. */
export function AdminNavList({ pathname, counts, density = "rail", onNavigate }: AdminNavListProps) {
  const active = activeAdminItem(pathname);
  return (
    <div className="flex flex-col gap-5">
      {ADMIN_NAV.map((group) => (
        <NavGroup key={group.id} label={group.label} hideLabel={group.id === "overview"} inset={density === "rail" ? ADMIN_RAIL_INSET : "px-3"}>
          {group.items.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              active={active?.id === item.id}
              counts={counts}
              density={density}
              onNavigate={onNavigate}
            />
          ))}
        </NavGroup>
      ))}
    </div>
  );
}

function NavGroup({ label, hideLabel, inset, children }: { label: string; hideLabel: boolean; inset: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      {/* The Overview group holds one item named the same as the group: a heading over it says
          the same word twice. It stays in the tree for the list's name, just not on screen. */}
      <p id={id} className={cn(typography({ variant: "overline" }), inset, hideLabel && "sr-only")}>{label}</p>
      <ul aria-labelledby={id} className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

/**
 * The desktop rail (xl and up — see `AdminLayout` for why not lg): sticky beside the content, scrolling on its own when a short
 * laptop screen cannot hold all fourteen rows.
 *
 * <p>
 * <b>The sticky offset is a contract with the app shell.</b> `top` reads `--app-content-top`
 * (default 0), for a shell that scrolls the document under a sticky top bar; the height subtracts
 * `--app-chrome-height`, which `Layout` already publishes for the toast strip. Inline styles rather
 * than classes because arbitrary lengths are banned outside `components/ui` (theme-vocabulary).
 * </p>
 */
export function AdminRail({ pathname, counts }: { pathname: string; counts: BadgeCounts }) {
  // Two boxes: the column stretches to the content's full height so its edge runs the length of
  // the page, and the aside inside it is the part that sticks.
  return (
    // X6-5 (FD1 ask): the shared width, so the rail, the crest box over it and the shut-doors
    // banner's offset agree — and 200 % text no longer takes 512px of a 1280 screen.
    <div data-admin-rail="" className={cn("hidden shrink-0 border-r border-border bg-bg-surface xl:block print:hidden", ADMIN_RAIL_WIDTH)}>
      {/* A div, not <aside> (F3.22): the rail renders inside <main>, where a complementary
          landmark is misplaced (axe landmark-complementary-is-top-level). The <nav> is the landmark. */}
      <div
        className="sticky overflow-y-auto overscroll-contain"
        style={{ top: "var(--app-content-top, 0px)", maxHeight: "calc(100dvh - var(--app-chrome-height, 0px))" }}
      >
        <nav aria-label="Admin" className={cn("flex flex-col gap-4 pb-10 pt-8", ADMIN_RAIL_INSET)}>
          <p aria-hidden="true" className={cn(typography({ variant: "overline" }), ADMIN_RAIL_INSET, "text-accent-strong")}>Admin console</p>
          <AdminNavList pathname={pathname} counts={counts} density="rail" />
        </nav>
      </div>
    </div>
  );
}
