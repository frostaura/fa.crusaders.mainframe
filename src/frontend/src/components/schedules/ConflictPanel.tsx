import { useEffect, useRef, useState } from "react";
import { Alert } from "../Alert";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { focusFirstComplaint } from "../members/saleFocus";
import { Input } from "../ui/input";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { BatchResultList, type BatchResultRow } from "./BatchResultList";
import { clubDayAndClock } from "../../lib/clubClock";
import {
  CONFLICT_REASON, NOTHING_CHANGED_YET, UNCLEARABLE_EXPLAINER, canCancelConflict, clearAllDescription, clearAllLabel,
  conflictRefundPhrase, conflictRefundedLine, conflictsHeadline, leaveOutAllLabel, leaveOutLabel, unclearableLine,
} from "../../lib/scheduleCopy";
import { describeFailure } from "../../lib/errors";
import { cancelRefusal } from "../../lib/bookingErrors";
import { adminEndpoints, type ScheduleConflict } from "../../lib/adminApi";

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
 *
 * <p>
 * <b>Every row has a way forward, and says which (2026-10-06).</b> A no-show or a game already
 * played is settled — the cancel route refuses it — and a hold is not this panel's to cancel. Those
 * rows used to sit in the list with nothing that could clear them, and the admin was stuck. Now each
 * row says what it is ("No-show on Tue 13 Oct — can't be cancelled") and offers leaving its date out,
 * which the server records on the new series as a skipped date. Leaving a date out is not the
 * rejected "hold with holes": the whole date goes, deliberately, and stays visible on the series.
 * </p>
 */

/** The total that would go back — or null the moment ONE quote is missing. */
function knownRefundTotal(conflicts: readonly ScheduleConflict[]): number | null {
  let total = 0;
  for (const c of conflicts) {
    // Unknown is never zero. A button promising "refund 5 h 14 min" over a list where one
    // quote never arrived is promising a figure nobody computed.
    if (c.would_refund_minutes === undefined || c.would_refund_minutes === null) return null;
    total += c.would_refund_minutes;
  }
  return total;
}

function conflictLabel(conflict: ScheduleConflict, timezone?: string): string {
  const who = conflict.member_name ?? conflict.label ?? "a club hold";
  const court = conflict.court_name ?? "a court";
  return `${court}, ${clubDayAndClock(conflict.starts_at, timezone)} — ${who}`;
}

/** Each date once, in the order the list shows them. */
function datesOf(conflicts: readonly ScheduleConflict[]): string[] {
  return [...new Set(conflicts.map((c) => c.occurrence_date))];
}

type LeaveOut = {
  /** Leaves these dates out of the series and checks again. */
  onLeaveOut: (dates: string[]) => void;
  /** A leave-out's check is in flight. */
  leaving: boolean;
};

/** What each row is, and what can be done about it — a cancel's refund, or why there is none. */
function ConflictTable({
  conflicts, timezone, leave,
}: { conflicts: ScheduleConflict[]; timezone?: string; leave: LeaveOut }) {
  return (
    <div className="rounded-lg border border-border">
      <Table className="min-w-max" label="Bookings in the way">
        <TableCaption className="sr-only">
          {`The ${conflicts.length} bookings that stand in the way of this hold`}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">When</TableHead>
            <TableHead scope="col">Court</TableHead>
            <TableHead scope="col">Whose</TableHead>
            <TableHead scope="col">What can be done</TableHead>
            <TableHead scope="col"><span className="sr-only">Leave the date out</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {conflicts.map((conflict, index) => (
            <TableRow key={conflict.booking_id ?? `${conflict.occurrence_date}-${conflict.court_id}-${index}`} className="align-top">
              <TableCell>{clubDayAndClock(conflict.starts_at, timezone)}</TableCell>
              <TableCell>{conflict.court_name ?? "—"}</TableCell>
              <TableCell>{conflict.member_name ?? conflict.label ?? "A club hold"}</TableCell>
              <TableCell className={canCancelConflict(conflict) ? "text-text-secondary" : "text-warning-strong"}>
                {canCancelConflict(conflict) ? conflictRefundPhrase(conflict) : unclearableLine(conflict)}
              </TableCell>
              <TableCell>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={leave.leaving}
                  onClick={() => leave.onLeaveOut([conflict.occurrence_date])}
                >
                  {leaveOutLabel(conflict.occurrence_date)}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The rows nobody can cancel, and the one way past all of them at once. */
function UnclearableNotice({ dates, leave }: { dates: string[]; leave: LeaveOut }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-muted p-4">
      <p className="text-sm text-text-secondary">{UNCLEARABLE_EXPLAINER}</p>
      <Button
        variant="outline"
        className="self-start"
        pending={leave.leaving}
        onClick={() => leave.onLeaveOut(dates)}
      >
        {leaveOutAllLabel(dates.length)}
      </Button>
    </div>
  );
}

export function ConflictPanel({
  conflicts, timezone, onCleared, leave,
}: {
  conflicts: ScheduleConflict[];
  timezone?: string;
  /** Called once anything has actually been cancelled: the check above is now stale. */
  onCleared: () => void;
  leave: LeaveOut;
}) {
  const [reason, setReason] = useState("");
  const [results, setResults] = useState<BatchResultRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  // A conflict against another schedule's rows, a hold, a no-show or a played game has no open
  // member booking to cancel — those dates are left out instead (canCancelConflict).
  const cancellable = conflicts.filter(canCancelConflict);
  const unclearableDates = datesOf(conflicts.filter((c) => !canCancelConflict(c)));
  const total = knownRefundTotal(cancellable);
  const reasonGiven = reason.trim().length > 0;
  // R17 X17-7 — a press without a reason opens nothing: the field says why and takes the keyboard,
  // after the commit that marks it invalid (the Cancel / Sell sheets' rule).
  const [confirming, setConfirming] = useState(false);
  const [refusals, setRefusals] = useState(0);
  useEffect(() => {
    if (refusals > 0) focusFirstComplaint("[data-conflict-panel]");
  }, [refusals]);
  const reasonMissing = refusals > 0 && !reasonGiven;
  const openConfirm = (next: boolean) => {
    if (next && !reasonGiven) {
      setRefusals((n) => n + 1);
      return;
    }
    setConfirming(next);
  };

  async function cancelThese(targets: ScheduleConflict[]): Promise<string> {
    setBusy(true);
    const rows: BatchResultRow[] = [];
    for (const conflict of targets) {
      const label = conflictLabel(conflict, timezone);
      try {
        // Full refund, penalty waived: the club moved the goalposts, not the member.
        const result = await adminEndpoints.adminCancelBooking(conflict.booking_id as string, { waivePenalty: true, reason: reason.trim() });
        rows.push({
          id: conflict.booking_id as string,
          label,
          ok: true,
          detail: conflictRefundedLine(result.refunded_minutes),
        });
      } catch (err) {
        rows.push({
          id: conflict.booking_id as string,
          label,
          ok: false,
          detail: cancelRefusal(err) ?? describeFailure(err, { action: "cancel that booking" }),
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
    <div data-conflict-panel="" className="flex flex-col gap-4">
      <Alert tone="warning" live="polite">
        <strong>{conflictsHeadline(conflicts.length)}</strong>{" "}
        <strong>{NOTHING_CHANGED_YET}</strong>{" "}
        {"Nothing can be held on those courts at those times until these are dealt with — "}
        {"there is no way to create a hold over a booking somebody paid for. "}
        {"Cancel a member's booking to free its court, or leave its date out."}
      </Alert>

      <ConflictTable conflicts={conflicts} timezone={timezone} leave={leave} />

      {unclearableDates.length > 0 && <UnclearableNotice dates={unclearableDates} leave={leave} />}

      {cancellable.length > 0 && (
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-muted p-4">
          <p className="text-sm text-text-secondary">
            {"Cancelling from here refunds each member in full — the late-cancellation penalty is "}
            {"waived, because the club moved, not them. Each member is emailed the reason you type."}
          </p>
          <Field invalid={reasonMissing}>
            <FieldLabel>{CONFLICT_REASON.label}</FieldLabel>
            <Input
              value={reason}
              maxLength={512}
              aria-required="true"
              onChange={(e) => setReason(e.target.value)}
              placeholder="Court 1–3 are held for league from 6 October"
            />
            {!reasonGiven && !reasonMissing && <FieldDescription>{CONFLICT_REASON.hint}</FieldDescription>}
            {reasonMissing ? <FieldError>{CONFLICT_REASON.missing}</FieldError> : null}
          </Field>

          <ConfirmDialog
            open={confirming}
            onOpenChange={openConfirm}
            trigger={(
              <Button variant="danger" className="self-start" disabled={busy}>
                {clearAllLabel(cancellable.length, total)}
              </Button>
            )}
            title={`Cancel ${cancellable.length} member booking${cancellable.length === 1 ? "" : "s"}?`}
            description={clearAllDescription(cancellable.length, total)}
            confirmLabel={clearAllLabel(cancellable.length, total)}
            cancelLabel="Keep them"
            focusAfter={() => resultsRef.current?.querySelector("h3")}
            onConfirm={() => cancelThese(cancellable)}
          />
        </div>
      )}

      <div ref={resultsRef}>
        {results && (
          <BatchResultList heading="What was cancelled" rows={results}>
            <p className="text-sm text-text-secondary">
              {"The check above no longer describes the club, because the club has just changed. "}
              {"Check the sentence again before creating anything."}
            </p>
            <Button variant="outline" className="self-start" onClick={() => setResults(null)}>
              Hide this list
            </Button>
          </BatchResultList>
        )}
      </div>
    </div>
  );
}
