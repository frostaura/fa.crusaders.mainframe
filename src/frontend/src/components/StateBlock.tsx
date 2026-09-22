import { type ReactNode } from "react";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { describeFailure, isDeploymentFault } from "../lib/errors";

/**
 * The honest read, as one component: loading · failed · empty · stale · the thing itself.
 *
 * <p>
 * <b>The rule this exists to make unforgettable.</b> An empty collection is not an answer. A
 * list initialised to <code>[]</code> renders its empty state on a read that FAILED, so a
 * screen says "no faults" when what happened is "we could not ask" — and an admin walks away
 * from a board that is on fire. Every page in this product rolls its own version of the
 * ordering that prevents it, and `DataTable` has three of the five arms
 * (`DataTable.tsx:155-164`). Six new admin surfaces landing at once is what makes one
 * component worth more than six correct copies.
 * </p>
 *
 * <p>
 * <b>The order of the guards is the whole component.</b> Failed before empty, always. A failed
 * read that renders "nothing here" is making a claim about the CLUB out of a fact about the
 * request, which is the same defect in six different words on six different screens.
 * </p>
 *
 * <p>
 * <b>Stale is not a fifth state; it is a band above a real one.</b> A page whose last read
 * succeeded and whose next one failed still has something true to show — on a wall screen,
 * stale truth beats no truth — so the children render with a band that says when they were
 * read. What is forbidden is showing them with no qualifier at all.
 * </p>
 *
 * <p>
 * <b>Generic, and deliberately so.</b> This is the UI lane's kind of thing and it is described
 * for them in the admin lane's report; it is built here, behind the API below, because six
 * admin surfaces needed it in this wave. Nothing in it knows about monitoring, faults, courts
 * or schedules.
 * </p>
 */

export type StateBlockProps = {
  /** The first read has not answered yet. Nothing below is known. */
  loading?: boolean;
  /**
   * What was thrown, or null. Passed whole rather than pre-described, so this component can
   * apply `isDeploymentFault` and drop the retry — offering "Try again" for a missing tenant
   * row is an invitation to press a button for ever.
   */
  error?: unknown;
  /**
   * The bare verb phrase that reads after "Couldn't" — "read the fault list", "load the
   * club's plans". It reaches the network and server sentences too, which is where a generic
   * message actually costs something.
   */
  action?: string;
  /** Error codes this surface's endpoint can return, with the sentence for each. */
  codes?: Record<string, string>;
  /**
   * The half that a failure sentence alone leaves out: what is NOT true because the read
   * failed. "That does not mean there are none." Optional, because it is not always sayable,
   * and never invented here — it is the call site that knows.
   */
  failedCaveat?: string;
  onRetry?: () => void;
  /** True when the read succeeded and genuinely returned nothing. Never inferred from length. */
  empty?: boolean;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  /**
   * When this was read, in words the call site has already put in the club's clock. A band
   * appears above the children whenever it is set AND `stale` is true.
   */
  readAt?: string | null;
  stale?: boolean;
  /** What the staleness means here — "the boxes may have moved on", "refresh to be sure". */
  staleHint?: string;
  children?: ReactNode;
};

export function StateBlock({
  loading = false, error = null, action, codes, failedCaveat, onRetry,
  empty = false, emptyTitle, emptyHint, readAt, stale = false, staleHint, children,
}: StateBlockProps) {
  // 1. Failed, first and always. See the header: an empty state rendered over a failed read is
  //    the screen inventing an answer it does not have.
  if (error) {
    return (
      <div className="space-y-3">
        <Alert tone="danger">
          {describeFailure(error, { action, codes })}
          {failedCaveat ? ` ${failedCaveat}` : ""}
        </Alert>
        {/* No retry for a fault nobody reading this can act on — a tenant row that does not
            exist does not start existing because somebody pressed a button twelve times. */}
        {onRetry && !isDeploymentFault(error) && (
          <Button variant="outline" className="min-h-11" onClick={onRetry}>Try again</Button>
        )}
      </div>
    );
  }

  // 2. Still asking. `role="status"` because a spinner is nothing at all to a screen reader,
  //    and the sentence names what is being waited for rather than saying "Loading…".
  if (loading) {
    return (
      <p role="status" className="text-sm text-text-secondary">
        {action ? `Reading ${action}…` : "Reading…"}
      </p>
    );
  }

  // 3. Genuinely nothing, and the call site said so — never derived from an array's length
  //    here, because the length of a list that was never filled is the trap above.
  if (empty) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-text-secondary">{emptyTitle ?? "Nothing here yet."}</p>
        {emptyHint && <div className="text-sm text-text-muted">{emptyHint}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 4. Stale: the children are shown, and the band says what they are. Both halves — when
             it was read, and what that means — because a timestamp on its own is a fact an
             admin has to do arithmetic on while standing up. */}
      {stale && readAt && (
        <p className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning-strong">
          {`Read at ${readAt}.`}
          {staleHint ? ` ${staleHint}` : ""}
        </p>
      )}
      {children}
    </div>
  );
}
