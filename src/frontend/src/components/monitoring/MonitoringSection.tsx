/**
 * The Monitoring section's one list of destinations (D3 §3.1, ruling 10; R16, R17).
 *
 * <p>
 * <b>There is no sub-navigation here any more.</b> Monitoring's pages render inside the admin
 * layout, whose rail (desktop) and section switcher (mobile) ARE the navigation. A strip of
 * tabs under every page's heading repeated the rail one level down — two navs naming the same
 * six places, one of which could disagree with the other — so `MonitoringNav` was deleted in
 * P2 (R16) rather than restyled.
 * </p>
 *
 * <p>
 * <b>Monitoring is courts, hardware and control (R17).</b> "A person's night" is a view of a
 * MEMBER, not of the hardware, so it is no longer a Monitoring destination: its route still
 * answers (P5 moves it onto the member's own page) but nothing in this section links to it.
 * </p>
 *
 * <p>
 * The list is exported so the route table, the admin rail and the title table are reconciled
 * against ONE list rather than three — a nav written out separately from the routes it points
 * at acquires a dead link the first time a path moves. `monitoring-nav.test.tsx` holds that.
 * </p>
 */
export const MONITORING_TABS: ReadonlyArray<{ to: string; label: string; end?: boolean }> = [
  // `end` on the index only: without it every child route would light the Control board entry
  // as well as its own, which is `NavLink`'s default and reads as two active entries.
  { to: "/admin/monitoring", label: "Control board", end: true },
  { to: "/admin/monitoring/doors", label: "Doors" },
  { to: "/admin/monitoring/devices", label: "Boards" },
  { to: "/admin/monitoring/faults", label: "Faults" },
  { to: "/admin/monitoring/changes", label: "Change record" },
];
