import {
  ChartBar, ClockCounterClockwise, Cpu, Door, Gauge, Gear, Racquet, Receipt, Repeat, SquaresFour, Users,
  UsersThree, Warning, WebhooksLogo, type Icon,
} from "@/components/ui/icons";

/**
 * The admin console's information architecture — the ONE list (plan: Target IA → Admin, R16).
 *
 * <p>
 * The desktop rail, the phone's section switcher, the Overview's quick links and the section bar's
 * "you are here" label all render from this array. Four surfaces written out separately is how a
 * console acquires a destination that one of them forgot, and nobody notices because whichever
 * surface you are looking at is the one that looks complete.
 * </p>
 *
 * <p>
 * <b>Only destinations that exist.</b> An entry is added in the same change as its route: a rail item
 * that 404s teaches an admin that the console is broken. (Courts, P6, arrived with `/admin/courts`.)
 * </p>
 */

/** Which attention count a destination carries. See `lib/adminAttention.ts` for each source. */
export type AdminBadgeKey = "pending" | "doors" | "faults";

export type AdminNavItem = {
  /** Stable id for tests and keys — never shown. */
  id: string;
  label: string;
  path: string;
  icon: Icon;
  /** One line: what an admin goes there to do. The Overview's quick links show it. */
  description: string;
  badge?: AdminBadgeKey;
};

export type AdminNavGroup = {
  id: string;
  label: string;
  items: readonly AdminNavItem[];
};

/**
 * Where "review the waiting applications" goes.
 *
 * <p>
 * The members page keeps its status filter in the URL (P5), so this opens the list already filtered
 * to the waiting applications. Written once here so no caller spells the query itself.
 * </p>
 */
export const PENDING_APPLICATIONS_HREF = "/admin/members?status=PendingApproval";

export const ADMIN_HOME_PATH = "/admin";

export const ADMIN_NAV: readonly AdminNavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      {
        id: "overview", label: "Overview", path: ADMIN_HOME_PATH, icon: SquaresFour,
        description: "What needs you right now, across the whole club.",
      },
    ],
  },
  {
    id: "people",
    label: "People",
    items: [
      {
        id: "members", label: "Members", path: "/admin/members", icon: Users, badge: "pending",
        description: "Approve applications, top up wallets and manage accounts.",
      },
      {
        id: "groups", label: "Groups", path: "/admin/groups", icon: UsersThree,
        description: "Who may book when, and the limits each group plays under.",
      },
    ],
  },
  {
    id: "money",
    label: "Money",
    items: [
      {
        id: "transactions", label: "Transactions", path: "/admin/transactions", icon: Receipt,
        description: "Every credit movement in the club's ledger.",
      },
      {
        id: "reports", label: "Reports", path: "/admin/reports", icon: ChartBar,
        description: "Court use, income and spend over time.",
      },
    ],
  },
  {
    id: "hardware",
    label: "Courts & hardware",
    items: [
      {
        id: "control-board", label: "Control board", path: "/admin/monitoring", icon: Gauge,
        description: "Every court's lights and bookings, live.",
      },
      {
        id: "doors", label: "Doors", path: "/admin/monitoring/doors", icon: Door, badge: "doors",
        description: "Door scanners, who came in, and shutting or reopening doors.",
      },
      {
        id: "boards", label: "Boards", path: "/admin/monitoring/devices", icon: Cpu,
        description: "The court boxes: whether each is reporting, and its setup.",
      },
      {
        id: "faults", label: "Faults", path: "/admin/monitoring/faults", icon: Warning, badge: "faults",
        description: "Hardware faults reported by the boards, and resolving them.",
      },
      {
        id: "changes", label: "Change record", path: "/admin/monitoring/changes", icon: ClockCounterClockwise,
        description: "Who changed what in the console, and when.",
      },
      {
        id: "schedules", label: "Repeating bookings", path: "/admin/schedules", icon: Repeat,
        description: "Leagues, coaching and other standing court bookings.",
      },
      {
        id: "courts", label: "Courts", path: "/admin/courts", icon: Racquet,
        description: "The club's courts, what a slice on each costs, and which are in use.",
      },
    ],
  },
  {
    id: "setup",
    label: "Setup",
    items: [
      {
        id: "settings", label: "Settings", path: "/admin/settings", icon: Gear,
        description: "Prices, opening hours, booking rules and the club's details.",
      },
      {
        id: "webhooks", label: "Webhooks", path: "/admin/webhooks", icon: WebhooksLogo,
        description: "Send the club's events to other systems.",
      },
    ],
  },
];

/** Every destination, flat, in rail order. */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = ADMIN_NAV.flatMap((group) => group.items);

/** True when `pathname` is `base` or lies under it on a segment boundary (`/admin/groups` is not under `/admin/group`). */
function isUnder(pathname: string, base: string): boolean {
  if (pathname === base) return true;
  return pathname.startsWith(base.endsWith("/") ? base : `${base}/`);
}

/** Trailing slashes off, so `/admin/members/` and `/admin/members` are one place. */
function normalise(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * The ONE destination `pathname` belongs to, or null outside the console.
 *
 * <p>
 * <b>Longest prefix wins</b>, which is what makes exactly one item active: `/admin/monitoring/doors/7`
 * lies under Control board (`/admin/monitoring`), Doors and Overview alike, and Doors is the most
 * specific of the three. It is also why `/admin/monitoring` never lights Doors — Doors is not a
 * prefix of it. `NavLink`'s own matching answers per link, so it would light Control board AND
 * Doors on a door's page unless every parent carried `end`, and `end` would then leave the parent
 * dark on its own nested pages (`/admin/schedules/:id`).
 * </p>
 */
export function activeAdminItem(pathname: string): AdminNavItem | null {
  const path = normalise(pathname);
  let best: AdminNavItem | null = null;
  for (const item of ADMIN_NAV_ITEMS) {
    if (!isUnder(path, item.path)) continue;
    if (!best || item.path.length > best.path.length) best = item;
  }
  return best;
}

/** Whether `item` is the active destination for `pathname` — exactly one item ever is. */
export function isAdminItemActive(item: AdminNavItem, pathname: string): boolean {
  return activeAdminItem(pathname)?.id === item.id;
}

/** The group an item sits in — for the section bar's "People · Members". */
export function adminGroupOf(item: AdminNavItem): AdminNavGroup | undefined {
  return ADMIN_NAV.find((group) => group.items.some((candidate) => candidate.id === item.id));
}
