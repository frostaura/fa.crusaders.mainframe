import { Link } from "react-router-dom";
import { doorsShutBanner } from "../../lib/gateCopy";

/**
 * The club-wide shut banner, on every admin route while any door is shut (A1.5 / D5).
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
 * <b>It links rather than reopening.</b> A reopen has to show its own per-door result — which
 * doors confirmed and which may still be admitting booked members from a cached list — and a
 * one-line banner is not where a result belongs.
 * </p>
 *
 * <p>
 * <b>A failed read renders nothing, and that is not an all-clear.</b> The banner's absence is
 * its default state, so "no banner" has never meant "no doors are shut" — which is exactly
 * why a failed read is allowed to produce it. A banner is not a place to report a failed read.
 * </p>
 */
export function ShutDoorsBanner({ shut, total }: { shut: number; total: number }) {
  if (shut === 0 || total === 0) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border-l-4 border-danger-strong bg-danger-soft px-3 py-2.5 text-sm text-danger-strong"
    >
      <span className="min-w-0 break-words">{doorsShutBanner(shut, total)}</span>
      <Link
        to="/admin/doors"
        className="ml-auto inline-flex min-h-11 items-center rounded-lg border border-danger-strong px-4 font-medium"
      >
        Reopen all doors
      </Link>
    </div>
  );
}
