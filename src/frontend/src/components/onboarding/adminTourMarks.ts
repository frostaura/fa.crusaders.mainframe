import { ADMIN_NAV_ITEMS } from "@/components/admin/adminNav";
import { ADMIN_TOUR } from "@/lib/onboardingCopy";
import type { CoachMark } from "./CoachMarks";

/**
 * Where each admin-tour mark points: the rail row from `xl`, the section bar below it — decided
 * per mark by what is actually displayed (see `AdminTour`).
 */
const RAIL_ITEM = (navId: string) => `[data-admin-rail] [data-admin-nav="${navId}"]`;
const SECTION_BAR = "[data-admin-section-bar] button";

function railShown(navId: string): Element | null {
  const item = document.querySelector(RAIL_ITEM(navId));
  return item && item.getClientRects().length > 0 ? item : null;
}

/**
 * The stops this console can point at: one whose section has no nav item is skipped rather than
 * anchored to nothing. P13 added a Packages stop ahead of the console's Packages page; it joins
 * the tour the day the nav item does, with no second edit.
 */
export function tourStops(navIds: ReadonlySet<string> = new Set(ADMIN_NAV_ITEMS.map((item) => item.id))) {
  return ADMIN_TOUR.stops.filter((stop) => navIds.has(stop.navId));
}

/** The marks, each resolving its anchor at the moment it opens. */
export function adminTourMarks(): CoachMark[] {
  return tourStops().map((stop) => {
    const onRail = () => railShown(stop.navId) !== null;
    return {
      id: stop.navId,
      title: stop.title,
      body: stop.body,
      anchor: () => railShown(stop.navId) ?? document.querySelector(SECTION_BAR),
      get side() { return onRail() ? "right" as const : "bottom" as const; },
      get hint() { return onRail() ? undefined : ADMIN_TOUR.bar; },
    };
  });
}
