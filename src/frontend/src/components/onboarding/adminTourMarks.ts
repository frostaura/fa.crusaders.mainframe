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

/** The six marks, each resolving its anchor at the moment it opens. */
export function adminTourMarks(): CoachMark[] {
  return ADMIN_TOUR.stops.map((stop) => {
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
