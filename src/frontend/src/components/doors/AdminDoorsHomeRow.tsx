import { Link, useLocation } from "react-router-dom";
import { DoorClosed } from "lucide-react";
import { useDoorsChrome } from "./useDoorsChrome";
import { doorsAttentionSummary } from "../../lib/doorsCopy";

/**
 * One row on admin Home, and ONLY when a door needs somebody.
 *
 * <p>
 * <b>On a normal day Home says nothing at all about doors.</b> P7 is a rule about email and
 * it is the right rule for a home screen too: a Home that always carries a doors panel is a
 * panel an admin skims past, so it is worth nothing on the morning it matters. A permanent
 * "all 3 doors reporting" tile would also be a standing claim of exactly the kind the chip
 * on the doors page refuses to make.
 * </p>
 *
 * <p>
 * <b>Never for a signal or a count (A2.6).</b> Silent, shut or unnamed — the three states
 * somebody has to act on. A refusal spike is operational detail and belongs on the door's
 * own page.
 * </p>
 *
 * <p>
 * Failed read → no row, same rule as the gear dot. It uses the existing `primary` treatment
 * from the link grid it sits in, so no new component and no new variant is introduced.
 * </p>
 */
export function AdminDoorsHomeRow() {
  const location = useLocation();
  const { attention } = useDoorsChrome(true, location.pathname);
  const hint = doorsAttentionSummary(attention);
  if (hint === null) return null;
  return (
    <Link
      to="/admin/doors"
      className="flex items-start gap-3 rounded-lg border border-accent-strong bg-accent-soft p-4"
    >
      <DoorClosed size={20} className="mt-0.5 shrink-0 text-accent-strong" aria-hidden="true" />
      <span>
        <span className="block font-medium">Admin · Doors</span>
        <span className="block text-sm text-text-secondary">{hint}</span>
      </span>
    </Link>
  );
}
