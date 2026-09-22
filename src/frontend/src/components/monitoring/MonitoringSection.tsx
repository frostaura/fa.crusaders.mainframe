import { NavLink } from "react-router-dom";
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
 * a person's night, the change record — came from the admin lane and have now landed. What
 * lives here is the one list every one of them is reconciled against, and this strip. The
 * permanent redirects that keep the URLs in outage emails, in bookmarks and on the printed
 * door card working are in `App.tsx`, beside the routes they point at.
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

/*
 * There was a `MonitoringSection` wrapper and a `MonitoringPlaceholder` here, and both are
 * gone now that the admin lane's six pages have landed. The placeholder existed so that the
 * four unbuilt paths could be real routes rather than absent ones — a nav entry that 404s
 * teaches an admin that the console is broken — and it was always the one export that would
 * be deleted rather than merged. The wrapper went with it: each page carries its own header
 * because each header is different (the control board holds the wall-view switch and a
 * freshness line, faults holds its own), and a wrapper with one shape and no callers is a
 * worse thing to leave behind than six honest headers.
 */
