import { NavLink } from "react-router-dom";
import { Card } from "../Card";
import { ScrollArea } from "../ScrollArea";
import { cn } from "../../lib/utils";

/**
 * The Monitoring section — its sub-navigation, and nothing else. (D3 §3.1, ruling 10)
 *
 * <p>
 * <b>The IA problem, stated plainly.</b> Doors was a top-level tab; Devices was buried in a
 * gear menu; there was no home at all for "how is the hardware doing". `AdminDevices` already
 * rendered doors inline with a "Manage on Doors" link and the doors overview linked back — the
 * two pages already knew they were one subject and were linking to each other across a nav
 * boundary. Six tabs stay six tabs: <b>Monitoring replaces Doors</b>, and Devices comes up out
 * of the gear, because they are destinations rather than settings.
 * </p>
 *
 * <p>
 * <b>This file is the shell, deliberately.</b> The pages under it — the control board, faults,
 * a person's night, the change record — belong to the admin lane. What ships here is the route
 * scaffolding, this strip, and the permanent redirects, so that the URLs in outage emails, in
 * bookmarks and on the printed door card keep working on the day the pages land.
 * </p>
 */

/**
 * Every destination under Monitoring, in the order an admin needs them.
 *
 * <p>
 * Exported so the route table, this strip and the title table are reconciled against one list
 * rather than three. A sub-nav written out separately from the routes it points at is a
 * sub-nav that acquires a dead link the first time a path moves.
 * </p>
 */
export const MONITORING_TABS: ReadonlyArray<{ to: string; label: string; end?: boolean }> = [
  // `end` on the index only: without it every child route would light the Control board tab
  // as well as its own, which is `NavLink`'s default and reads as two active tabs.
  { to: "/admin/monitoring", label: "Control board", end: true },
  { to: "/admin/monitoring/doors", label: "Doors" },
  { to: "/admin/monitoring/devices", label: "Boards" },
  { to: "/admin/monitoring/faults", label: "Faults" },
  { to: "/admin/monitoring/night", label: "A person's night" },
  { to: "/admin/monitoring/changes", label: "Change record" },
];

/**
 * The strip, in a `ScrollArea` for the same reason the section tabs are.
 *
 * Six destinations do not fit a 320 px phone, and a strip that simply clips its last entry is
 * how "Reports" was invisible on arrival until `ScrollArea` was put under it: a fade for
 * anyone who can see it, a sentence for anyone who cannot, and each tab scrolls itself into
 * view on focus.
 */
export function MonitoringNav({ className }: { className?: string }) {
  return (
    <nav aria-label="Monitoring" className={cn("border-b border-border", className)}>
      <ScrollArea label="Monitoring sections" tabbable={false}>
        <div className="flex items-center gap-[4px] py-[4px] text-sm w-max">
          {MONITORING_TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              onFocus={(e) => e.currentTarget.scrollIntoView?.({ inline: "nearest", block: "nearest" })}
              // B12 — a touch target is a fingertip, so the floor is in pixels and does not
              // double with the text.
              className={({ isActive }) => cn(
                "px-3 min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] inline-flex items-center rounded-lg whitespace-nowrap",
                isActive ? "bg-accent-soft text-accent-strong font-medium" : "text-text-secondary hover:bg-bg-muted",
              )}
            >
              {tab.label}
            </NavLink>
          ))}
        </div>
      </ScrollArea>
    </nav>
  );
}

/**
 * The wrapper an admin-lane Monitoring page renders itself inside.
 *
 * `title` is the page's own `<h1>` — the route announcer moves focus to `#main-content h1`, so
 * every page under this section needs exactly one and it belongs here rather than in six
 * copies.
 */
export function MonitoringSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <MonitoringNav />
      {children}
    </div>
  );
}

/**
 * What a Monitoring destination renders until the admin lane builds it.
 *
 * <p>
 * <b>A placeholder that says it is one.</b> The alternative was to leave the four unbuilt
 * paths off the route table, which makes the sub-nav above either wrong or shorter than the
 * IA — and a nav entry that 404s teaches an admin that the console is broken. This says the
 * true thing instead, and it is the one file the admin lane deletes rather than merges.
 * </p>
 */
export function MonitoringPlaceholder({ title, what }: { title: string; what: string }) {
  return (
    <MonitoringSection title={title}>
      <Card>
        {/* `role="status"`, not `alert`: nothing has gone wrong, and this is a standing fact
            about the screen rather than an interruption. */}
        <p role="status" className="text-text-secondary">
          {what} isn't built yet. The rest of Monitoring is — the tabs above work.
        </p>
      </Card>
    </MonitoringSection>
  );
}
