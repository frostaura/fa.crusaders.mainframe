import { Check, X } from "lucide-react";
import { Button } from "./Button";
import { clubClock } from "../lib/clubClock";
import type { BulkRow } from "../lib/bulkResults";
import { bulkHeading, rowOutcome, rowReason } from "../lib/bulkCopy";

/**
 * What a batch actually did, one row per item — never a toast.
 *
 * <p>
 * Bulk work is partial by nature: somebody else takes a slot mid-flight, the club closes
 * early, a member's per-day cap bites on the fourth slot but not on the first three. Four
 * seconds of `role="status"` is not enough to read six outcomes, and the toast viewport
 * deliberately carries no live region of its own, so an admin who looked away would be told
 * nothing at all about twelve refunds.
 * </p>
 *
 * <p>
 * <b>The heading is the one announcement, and it speaks when the batch SETTLES</b> — not per
 * row. Twelve polite announcements in a row is silence with extra steps.
 * </p>
 *
 * <p>
 * <b>Failures are shown as data, in request order, beside the successes.</b> An admin reading
 * "4 of 6 done" needs to see which two, and what to do about each; a summary that hides the
 * failed rows behind a retry button makes them re-run the whole batch to find out.
 * </p>
 */
export function BulkResultList({ rows, mode, payerName, timezone, actions }: {
  rows: BulkRow[];
  mode: "book" | "cancel";
  payerName: string | null;
  timezone: string;
  actions?: React.ReactNode;
}) {
  const done = rows.filter((r) => r.ok).length;
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm font-medium">{bulkHeading(done, rows.length)}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((row) => (
          <li key={`${mode}-${row.id}`} className="flex items-start gap-2 p-2 text-sm">
            {row.ok
              ? <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success-strong" />
              : <X size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-danger-strong" />}
            <span className="sr-only">{row.ok ? "Done" : "Not done"}</span>
            <span className="min-w-0">
              <span className="font-medium">
                {row.startsAt ? `${clubClock(row.startsAt, timezone)} ` : ""}{row.courtName ?? ""}
              </span>
              <span className="block text-text-secondary">
                {row.ok ? rowOutcome(row, mode, row.memberName ?? payerName) : rowReason(row)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {actions}
    </div>
  );
}

/** The footer of a settled batch: whatever retry applies, and a Done that closes it. */
export function BulkResultActions({ retryLabel, onRetry, onDone, busy }: {
  retryLabel?: string | null; onRetry?: () => void; onDone: () => void; busy?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2 justify-end">
      {retryLabel && onRetry && (
        <Button variant="outline" onClick={onRetry} loading={busy}>{retryLabel}</Button>
      )}
      <Button variant="primary" onClick={onDone}>Done</Button>
    </div>
  );
}
