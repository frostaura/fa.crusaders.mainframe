import { Link } from "react-router-dom";
import { Button, BUTTON_VARIANT_CLASS } from "./Button";
import { cn } from "../lib/utils";
import type { Notice } from "../lib/gridExplain";

/**
 * The `Button` shell as a router link.
 *
 * <p>
 * `Button` renders a `<button>` and has no polymorphic `as` — adding one is the shared-primitive
 * lane's call, not this one's — so the shell is composed from the same exported variant map the
 * primitive itself uses. One class string, one source: a sixth variant is picked up here the day
 * it is added, and the hover lift and focus ring come from `index.css`'s element-level layer.
 * </p>
 */
const ACTION_SHELL = "inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-sm font-medium";

/**
 * The standing conditions above the grid, and the one live region the grid speaks through.
 *
 * <p>
 * <b>`role="status"`, never `role="alert"`.</b> An alert interrupts whatever the member is
 * doing; every notice here is a condition they ARRIVED into — their quota is used up, their
 * groups' windows do not overlap, their wallet is empty. None of it is an event, and a screen
 * that shouts a standing fact is the defect `lib/announce` was written to close.
 * </p>
 *
 * <p>
 * <b>`warning`, never `danger`.</b> Red says the member did something wrong. Reaching the
 * club's daily cap is the rule working, not a mistake, and the copy in `lib/gridCopy` says the
 * rule rather than the person for the same reason.
 * </p>
 *
 * <p>
 * <b>The live region is separate from the notices and is always mounted.</b> A region that is
 * conditionally rendered announces on mount — which is how a screen ends up reading a standing
 * banner again every time a poll swaps a payload — so it is one node that is empty most of the
 * time and carries a sentence for the moment after a member pressed a locked cell.
 * </p>
 */
export function ScheduleNotices({ notices, live, onNextDay }: {
  notices: Notice[];
  live: string;
  onNextDay?: () => void;
}) {
  return (
    <>
      {/* The live region itself, and the thing a SIGHTED member reads.
          They are two nodes on purpose. The region must be `sr-only` and must stay mounted —
          a conditionally-rendered region announces on mount, which is how a screen ends up
          re-reading a standing banner every time a poll swaps a payload. The visible half is
          `aria-hidden`, because one press must produce exactly one announcement.
          Both halves matter: D4 §2.9's finding was that a member tapped a restricted cell and
          NOTHING happened, and an explanation only a screen reader hears leaves that defect
          in place for everyone who can see. */}
      <div role="status" aria-live="polite" className="sr-only">{live}</div>
      {live.trim() && (
        <div aria-hidden="true"
          className="rounded-lg border border-info-soft bg-info-soft text-info-strong p-3 sm:p-4 text-sm">
          {live}
        </div>
      )}
      {notices.map((n) => (
        <div key={n.id} role="status"
          className="rounded-lg border border-warning-strong/30 bg-warning-soft text-warning-strong p-3 sm:p-4 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{n.title}</p>
            {n.body && <p className="text-sm mt-1">{n.body}</p>}
          </div>
          {n.action?.to && (
            <Link to={n.action.to} className={cn(ACTION_SHELL, BUTTON_VARIANT_CLASS.outline, "shrink-0")}>
              {n.action.label}
            </Link>
          )}
          {n.action?.nextDay && onNextDay && (
            <Button variant="outline" onClick={onNextDay} className="shrink-0">{n.action.label}</Button>
          )}
        </div>
      ))}
    </>
  );
}
