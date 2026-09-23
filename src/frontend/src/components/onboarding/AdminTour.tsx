import { useCallback, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { ADMIN_HOME_PATH } from "@/components/admin/adminNav";
import { ADMIN_TOUR, ADMIN_TOUR_QUERY } from "@/lib/onboardingCopy";
import { adminTourMarks } from "./adminTourMarks";
import { CoachMarks } from "./CoachMarks";
import { useOnboarding } from "./useOnboarding";

/**
 * The admin tour (P8, D3): six coach marks over the console's own navigation, on the first
 * visit to the Admin tab.
 *
 * <p>
 * <b>Where each mark points.</b> From `xl` the rail is on screen, so each mark sits beside its
 * own row (`[data-admin-nav]`). Below `xl` every section is behind the section bar, so every mark
 * anchors to the bar and says so ("Tap the section bar to get here"). The choice is made per
 * mark, by what is actually displayed, so a window resized mid-tour still points somewhere real.
 * </p>
 *
 * <p>
 * <b>When it fires.</b> On the Overview (`/admin`) only — the Admin tab's own landing, never a
 * deep link an admin followed to do something — when the server says the tour is not finished,
 * or when `?tour=replay` asks for it (the account menu's "Replay admin tour"). Done or skipped,
 * it is recorded as finished: skipping is an answer, and a tour that returns after "Skip" is a
 * tour that is fought rather than read.
 * </p>
 */

export function AdminTour() {
  const { pathname, key } = useLocation();
  const [params, setParams] = useSearchParams();
  const { adminDue, completeAdmin } = useOnboarding();
  const marks = useMemo(() => adminTourMarks(), []);

  const replay = params.get(ADMIN_TOUR_QUERY) === "replay";
  // Which run of the tour this is: every replay link followed is a new one, so a tour finished
  // earlier in the same visit to the console does not swallow the next "Replay admin tour".
  const run = replay ? `replay:${key}` : "first";
  const [finishedRun, setFinishedRun] = useState<string | null>(null);
  const open = finishedRun !== run && pathname === ADMIN_HOME_PATH && (replay || adminDue === true);

  const finish = useCallback(() => {
    setFinishedRun(run);
    if (replay) {
      const next = new URLSearchParams(params);
      next.delete(ADMIN_TOUR_QUERY);
      setParams(next, { replace: true });
    }
    // The device mirror is written first, so a failed POST still ends the tour on this device.
    completeAdmin().catch(() => undefined);
  }, [completeAdmin, params, replay, run, setParams]);

  if (!open) return null;
  return <CoachMarks marks={marks} labels={ADMIN_TOUR} onFinish={finish} />;
}
