import { Link, useLocation } from "react-router-dom";
import { doorFleetReopenLabel, doorsShutBannerLine, doorsShutIndividuallyBanner } from "../../lib/gateCopy";
import { type DoorsChrome } from "./useDoorsChrome";

/**
 * The club-wide shut banner, on every admin route while any door is shut (A1.5 / D5 / C8).
 *
 * <p>
 * W1.5 gives shut-all one audit row and a result screen. It gives the club nothing that says,
 * at 05:50 the next morning, that the doors are still shut — and a volunteer club that shut
 * every door after an incident discovers that state with thirty members standing outside.
 * There is no timed auto-reopen, by decision, so a standing banner is the only thing that
 * gets the state back into an admin's head.
 * </p>
 *
 * <p>
 * <b>It reads from the one shut-state source (C3).</b> The banner, the doors page's own
 * summary and the fleet result panel were three independent readers, and an admin who shut
 * every door could see three different counts on one screen at once. All three now render
 * from {@link DoorsChrome}, which the doors page refreshes on every poll and after every
 * action.
 * </p>
 *
 * <p>
 * <b>Two states, because a fleet Reopen is not always the way back (C1).</b> While a
 * shut-all is standing the banner offers it, labelled with the number it will actually
 * reopen. When the doors were shut one at a time there is no fleet control at all — the
 * request would reopen none of them, which is the "0 doors reopened" dead end — and the
 * banner links to each door instead.
 * </p>
 *
 * <p>
 * <b>A failed read renders nothing, and that is not an all-clear.</b> The banner's absence is
 * its default state, so "no banner" has never meant "no doors are shut" — which is exactly
 * why a failed read is allowed to produce it. A banner is not a place to report a failed read.
 * </p>
 *
 * <p>
 * B14: `print:hidden`. This printed across the top of the door card that goes on a wall in a
 * corridor, complete with a Reopen button, on a sheet whose whole purpose is to be true for
 * months.
 * </p>
 */
export function ShutDoorsBanner({ chrome }: { chrome: DoorsChrome }) {
  const { pathname } = useLocation();
  const shut = chrome.doors.filter((d) => !d.enabled);
  if (shut.length === 0 || chrome.total === 0) return null;

  /**
   * C17-21: the banner's action was a link to `/admin/doors`, which is a DEAD CONTROL once
   * you are already there — and the doors page carries the real fleet control a few hundred
   * pixels below it, so the screen offered the same action twice, once inertly. The sentence
   * is still worth carrying everywhere (it is the standing reminder the club has no
   * auto-reopen); only the link stands down where the page beneath it can do the job.
   */
  const onDoorsPage = pathname.startsWith("/admin/doors");
  const byFleet = shut.filter((d) => d.shutByFleet);
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border-l-4 border-danger-strong bg-danger-soft px-3 py-2.5 text-sm text-danger-strong print:hidden"
    >
      <span className="min-w-0 break-words">
        {byFleet.length > 0
          ? doorsShutBannerLine(shut, chrome.total)
          : doorsShutIndividuallyBanner(shut, chrome.total)}
      </span>
      {onDoorsPage ? null : byFleet.length > 0 ? (
        <Link
          to="/admin/doors"
          className="ml-auto inline-flex min-h-11 items-center rounded-lg border border-danger-strong px-4 font-medium"
        >
          {doorFleetReopenLabel(byFleet.length)}
        </Link>
      ) : (
        // C17-21: the fleet link was a dead control once you were already on /admin/doors.
        // A per-door link is never dead — it goes somewhere the reader is not.
        <span className="ml-auto flex flex-wrap gap-2">
          {shut.map((door) => (
            <Link
              key={door.id}
              to={`/admin/doors/${door.id}`}
              className="inline-flex min-h-11 items-center rounded-lg border border-danger-strong px-4 font-medium"
            >
              {door.name}
            </Link>
          ))}
        </span>
      )}
    </div>
  );
}
