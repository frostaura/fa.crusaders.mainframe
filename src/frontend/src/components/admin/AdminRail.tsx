import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { typography } from "@/lib/typography";
import { attentionBadge, type AdminAttention } from "@/lib/adminAttention";
import { ADMIN_NAV, activeAdminItem, type AdminNavItem } from "./adminNav";

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

type BadgeCounts = Pick<AdminAttention, "pending" | "doors" | "faults">;

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

/**
 * The link's accessible name: the label, then the count in words — "Members, 2 membership
 * applications awaiting review" — or the label alone at zero.
 *
 * <p>
 * An `aria-label` rather than a visually hidden span, and that is the fix, not a style. The
 * count used to be a sibling flex item, then a visually hidden span inside the label; both are
 * block-level to Chromium's name computation (a flex item is blockified, an absolutely placed
 * `sr-only` box is block), and Chromium puts a space between block children — so the rail read
 * "Members , 7 membership applications…". jsdom does not, so no unit test could see it;
 * `e2e/admin-devices.spec.ts` asks Chromium's own accessibility tree. The name still opens with
 * the words on screen (WCAG 2.5.3).
 * </p>
 */
export function attentionName(item: AdminNavItem, counts: BadgeCounts): string {
  if (!item.badge) return item.label;
  const { count, label } = attentionBadge(item.badge, counts);
  return count > 0 ? `${item.label}, ${label}` : item.label;
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
          "no-lift relative flex min-h-touch items-center gap-3 rounded-lg px-3 text-sm",
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
        <ItemIcon size={20} weight={active ? "fill" : "regular"} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
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
        <NavGroup key={group.id} label={group.label} hideLabel={group.id === "overview"}>
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

function NavGroup({ label, hideLabel, children }: { label: string; hideLabel: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      {/* The Overview group holds one item named the same as the group: a heading over it says
          the same word twice. It stays in the tree for the list's name, just not on screen. */}
      <p id={id} className={cn(typography({ variant: "overline" }), "px-3", hideLabel && "sr-only")}>{label}</p>
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
    <div data-admin-rail="" className="hidden w-64 shrink-0 border-r border-border bg-bg-surface xl:block print:hidden">
      <aside
        className="sticky overflow-y-auto overscroll-contain"
        style={{ top: "var(--app-content-top, 0px)", maxHeight: "calc(100dvh - var(--app-chrome-height, 0px))" }}
      >
        <nav aria-label="Admin" className="flex flex-col gap-4 px-3 pb-10 pt-8">
          <p aria-hidden="true" className={cn(typography({ variant: "overline" }), "px-3 text-accent-strong")}>Admin console</p>
          <AdminNavList pathname={pathname} counts={counts} density="rail" />
        </nav>
      </aside>
    </div>
  );
}
