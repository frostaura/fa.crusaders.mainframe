import { NavLink } from "react-router-dom";
import { cn } from "../../lib/utils";

/**
 * Monitoring's own sub-navigation — the six places "how is the club's hardware doing" lives.
 *
 * <p>
 * <b>The IA problem this closes.</b> Doors was a top-level tab; Devices was buried in a gear
 * menu; and there was no home at all for the control board, the fault list, a person's night
 * or the club's own record of what its admins did. The two pages that DID exist already knew
 * they were one subject — `AdminDevices` renders the club's doors inline with a "Manage on
 * Doors" link, i.e. it was cross-linking across a nav boundary. Six section tabs stay six:
 * Monitoring replaces the Doors tab rather than becoming a seventh, which `Layout.tsx`
 * carries a measurement against.
 * </p>
 *
 * <p>
 * <b>Built here, and the section chrome is the UI lane's.</b> The admin lane owns the pages;
 * the nav entry, the section shell and the redirect scaffolding belong to the lane that owns
 * `Layout`. This is the strip the pages need in the meantime, behind the API that lane would
 * want anyway: a list of `{to, label}` and the current route. It is deliberately not styled
 * like the section tabs — those belong to the header — and it carries no counts, because a
 * badge that disagrees with the page under it is worse than no badge.
 * </p>
 *
 * <p>
 * <b>`end` on the control board only.</b> Every other entry is a distinct path; the board is
 * the section root, so without it every Monitoring page would light the board's tab as well
 * as its own.
 * </p>
 */

export type MonitoringTab = { to: string; label: string; end?: boolean };

/**
 * The six, in the order an admin needs them: what is happening now, then the hardware, then
 * the two record surfaces. Exported so a test can assert the set rather than the markup.
 */
export const MONITORING_TABS: readonly MonitoringTab[] = [
  { to: "/admin/monitoring", label: "Control board", end: true },
  { to: "/admin/monitoring/doors", label: "Doors" },
  { to: "/admin/monitoring/devices", label: "Boards" },
  { to: "/admin/monitoring/faults", label: "Faults" },
  { to: "/admin/monitoring/night", label: "A person's night" },
  { to: "/admin/monitoring/changes", label: "Change record" },
];

export function MonitoringNav({ className }: { className?: string }) {
  return (
    // `aria-label` and not a heading: a screen reader user lands on this strip on six
    // different pages and needs to know which navigation it is, not to be read a title.
    <nav aria-label="Monitoring" className={cn("-mx-1 overflow-x-auto", className)}>
      <ul className="flex min-w-max items-center gap-1 px-1">
        {MONITORING_TABS.map((tab) => (
          <li key={tab.to}>
            <NavLink
              to={tab.to}
              end={tab.end}
              // 44 px on both axes: this strip is used standing up in a club, on a phone,
              // by the same volunteer the doors surface is built for.
              className={({ isActive }) => cn(
                "inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium",
                // A border on BOTH states, not only the active one: a boundary that appears
                // on selection makes every tab move by a pixel as the selection travels, and
                // under forced colours a background-only selection is invisible. `NavLink`
                // writes `aria-current="page"` on the active entry by itself, which is what
                // actually carries the selection to a screen reader — the fill is the sighted
                // half of the same fact and neither is alone.
                "border",
                isActive
                  ? "border-accent-strong bg-accent-soft text-accent-strong"
                  : "border-transparent text-text-secondary hover:bg-bg-muted",
              )}
            >
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
