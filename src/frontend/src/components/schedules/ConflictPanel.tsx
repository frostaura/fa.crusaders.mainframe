import { useRef, useState } from "react";
import { Alert } from "../Alert";
import { Button, Input, Label } from "../Button";
import { ConfirmButton } from "../ConfirmButton";
import { BatchResultList, type BatchResultRow } from "./BatchResultList";
import { clubDayAndClock } from "../../lib/clubClock";
import {
  NOTHING_CHANGED_YET, clearAllLabel, conflictRefundPhrase, conflictsHeadline,
} from "../../lib/scheduleCopy";
import { describeFailure } from "../../lib/errors";
import { endpoints } from "../../lib/api";
import type { ScheduleConflict } from "../../lib/adminApi";

/**
 * What is in the way, and the only path D2 gives an admin through it.
 *
 * <p>
 * <b>There is no force flag, and that is a decision rather than a gap.</b> D2 §11.4: a member
 * who paid must be refunded deliberately, through a cancellation — the rule
 * `AdminBlockService.CreateAsync` already enforces for a single block, restated at the scale
 * of a season. So this panel offers no "create it anyway": the conflicts are cancelled and
 * refunded first, deliberately, and then the sentence is checked again. D3 §5.3 proposed a
 * third option ("Leave their bookings — the hold skips those courts at those times") and D2's
 * wire cannot express it: `ScheduleBody` has no per-occurrence exclusion, and a hold that
 * silently has holes in it is a league night the club believes it has and does not.
 * </p>
 *
 * <p>
 * <b>The refund is full, always.</b> The club moved the goalposts, not the member, so the
 * late-cancellation penalty is waived by construction — `adminCancelBooking(id, true, reason)`
 * — and the panel says so above the control rather than leaving it to be discovered in the
 * ledger.
 * </p>
 *
 * <p>
 * <b>Per-booking, because bulk-cancel is not in this tree yet.</b> D2 §5.2's
 * `POST /admin/bookings/bulk-cancel` is the GRID lane's, and the conflict list is deliberately
 * shaped to be pasted straight into it. Until it lands, "cancel them all" walks the list one
 * booking at a time and reports the outcome of each — which is the behaviour a partial bulk
 * endpoint has anyway, so the screen above it does not change when the wire arrives.
 * </p>
 */

/** The total that would go back — or null the moment ONE quote is missing. */
function knownRefundTotal(conflicts: readonly ScheduleConflict[]): number | null {
  let total = 0;
  for (const c of conflicts) {
    // Unknown is never zero. A button promising "refund 314.00 cr" over a list where one
    // quote never arrived is promising a figure nobody computed.
    if (c.would_refund_credits === undefined || c.would_refund_credits === null) return null;
    total += c.would_refund_credits;
  }
  return total;
}

function conflictLabel(conflict: ScheduleConflict, timezone?: string): string {
  const who = conflict.member_name ?? conflict.label ?? "a club hold";
  const court = conflict.court_name ?? "a court";
  return `${court}, ${clubDayAndClock(conflict.starts_at, timezone)} — ${who}`;
}

/** The rows a table needs, and the rows a result list needs, from one place. */
function cancellableIds(conflicts: readonly ScheduleConflict[]): ScheduleConflict[] {
  // A conflict against another schedule's rows has no member booking to cancel — D2 §11.4
  // calls two league nights on one court a configuration error, and cancelling somebody
  // else's season from inside this panel is not the fix for it.
  return conflicts.filter((c) => !!c.booking_id && c.kind !== "schedule" && c.kind !== "block");
}

export function ConflictPanel({
  conflicts, timezone, onCleared,
}: {
  conflicts: ScheduleConflict[];
  timezone?: string;
  /** Called once anything has actually been cancelled: the check above is now stale. */
  onCleared: () => void;
}) {
  const [reason, setReason] = useState("");
  const [results, setResults] = useState<BatchResultRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  const cancellable = cancellableIds(conflicts);
  const others = conflicts.length - cancellable.length;
  const total = knownRefundTotal(cancellable);
  const reasonGiven = reason.trim().length > 0;

  async function cancelThese(targets: ScheduleConflict[]): Promise<string> {
    setBusy(true);
    const rows: BatchResultRow[] = [];
    for (const conflict of targets) {
      const label = conflictLabel(conflict, timezone);
      try {
        // Full refund, penalty waived: the club moved the goalposts, not the member.
        const result = await endpoints.adminCancelBooking(conflict.booking_id as string, true, reason.trim());
        rows.push({
          id: conflict.booking_id as string,
          label,
          ok: true,
          detail: `${result.refunded_credits.toFixed(2)} cr went back in full.`,
        });
      } catch (err) {
        rows.push({
          id: conflict.booking_id as string,
          label,
          ok: false,
          detail: describeFailure(err, { action: "cancel that booking" }),
        });
      }
    }
    setResults((prior) => [...(prior ?? []), ...rows]);
    setBusy(false);
    // Anything at all having changed makes the check above stale — including a batch where
    // every row failed, because the reason one failed may be that it was cancelled elsewhere.
    onCleared();
    const done = rows.filter((r) => r.ok).length;
    return `${done} of ${rows.length} done.`;
  }

  return (
    <div className="space-y-4">
      <Alert tone="warning" live="polite">
        <strong>{conflictsHeadline(conflicts.length)}</strong>{" "}
        <strong>{NOTHING_CHANGED_YET}</strong>{" "}
        {"Nothing can be held on those courts at those times until these are dealt with — "}
        {"there is no way to create a hold over a booking somebody paid for."}
      </Alert>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <caption className="sr-only">
            {`The ${conflicts.length} bookings that stand in the way of this hold`}
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-text-secondary">
              <th scope="col" className="py-2 pr-3 font-medium">When</th>
              <th scope="col" className="py-2 pr-3 font-medium">Court</th>
              <th scope="col" className="py-2 pr-3 font-medium">Whose</th>
              <th scope="col" className="py-2 pr-3 font-medium">What would go back</th>
            </tr>
          </thead>
          <tbody>
            {conflicts.map((conflict, index) => (
              <tr key={conflict.booking_id ?? `${conflict.occurrence_date}-${conflict.court_id}-${index}`} className="border-b border-border align-top">
                <td className="py-2 pr-3 text-text-primary">{clubDayAndClock(conflict.starts_at, timezone)}</td>
                <td className="py-2 pr-3 text-text-primary">{conflict.court_name ?? "—"}</td>
                <td className="py-2 pr-3 text-text-primary">
                  {conflict.member_name ?? conflict.label ?? "A club hold"}
                </td>
                <td className="py-2 pr-3 text-text-secondary">{conflictRefundPhrase(conflict)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {others > 0 && (
        <Alert tone="info" live="polite">
          {`${others} of these ${others === 1 ? "is" : "are"} another club hold, not a member's booking. `}
          {"Those are not cancelled from here — two holds on one court at one time is a "}
          {"configuration mistake, so change this sentence or end the other repeating booking first."}
        </Alert>
      )}

      {cancellable.length > 0 && (
        <div className="space-y-3 rounded-lg border border-border bg-bg-muted p-4">
          <p className="text-sm text-text-secondary">
            {"Cancelling from here refunds each member in full — the late-cancellation penalty is "}
            {"waived, because the club moved, not them. Each member is emailed the reason you type."}
          </p>
          <div className="space-y-1">
            <Label htmlFor="conflict-reason">Reason (the members will read this)</Label>
            <Input
              id="conflict-reason"
              value={reason}
              maxLength={512}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Court 1–3 are held for league from 6 October"
            />
            {!reasonGiven && (
              <p className="text-sm text-text-muted">
                A reason is required — it is what the member is told, and it is what the change
                record keeps.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              idleLabel={clearAllLabel(cancellable.length, total)}
              tone="danger"
              disabled={!reasonGiven || busy}
              subject={`${cancellable.length} member booking${cancellable.length === 1 ? "" : "s"}`}
              cancelLabel="Keep them"
              confirmLabel={
                total === null
                  ? `${cancellable.length} member booking${cancellable.length === 1 ? "" : "s"} will be cancelled and refunded in full, and each member emailed. This cannot be undone from here — a cancelled slot goes back on the grid for anyone to book.`
                  : `${cancellable.length} member booking${cancellable.length === 1 ? "" : "s"} will be cancelled, ${total.toFixed(2)} cr goes back in full, and each member is emailed. This cannot be undone from here — a cancelled slot goes back on the grid for anyone to book.`
              }
              focusAfter={() => resultsRef.current?.querySelector("h3")}
              onConfirm={() => cancelThese(cancellable)}
            />
          </div>
        </div>
      )}

      <div ref={resultsRef}>
        {results && (
          <BatchResultList heading="What was cancelled" rows={results}>
            <p className="text-sm text-text-secondary">
              {"The check above no longer describes the club, because the club has just changed. "}
              {"Check the sentence again before creating anything."}
            </p>
            <Button variant="outline" className="min-h-11" onClick={() => setResults(null)}>
              Hide this list
            </Button>
          </BatchResultList>
        )}
      </div>
    </div>
  );
}
