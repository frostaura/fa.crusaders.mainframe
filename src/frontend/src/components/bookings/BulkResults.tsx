import { CheckCircle, XCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * What a booking or cancelling run actually did — one row per item, successes and refusals side
 * by side in the order they were asked for.
 *
 * <p>
 * Never a toast: four seconds of `role="status"` cannot carry "2 of 3 booked, Court 2 was taken",
 * and an admin auditing a batch needs to see WHICH one and why. The status word is text as well
 * as an icon, so the outcome never rests on colour or shape alone.
 * </p>
 *
 * <p>
 * The one announcement belongs to the heading above this list (the sheet's result title), which
 * speaks once when the run settles — twelve polite row announcements is silence with extra steps.
 * </p>
 */
export type BulkResultRow = {
  key: string;
  courtName: string;
  /** "Tue 23 Sep · 18:00–18:45". */
  when: string;
  ok: boolean;
  /** "Booked", "Not booked", "Cancelled"… */
  word: string;
  /** Why it failed, or what it moved ("35.00 cr back"). */
  detail: string | null;
};

function RowIcon({ ok }: { ok: boolean }) {
  const Mark = ok ? CheckCircle : XCircle;
  return (
    <Mark
      size={20}
      weight="fill"
      aria-hidden="true"
      className={cn("mt-0.5 shrink-0", ok ? "text-success-strong" : "text-danger-strong")}
    />
  );
}

export function BulkResults({ rows, label }: { rows: readonly BulkResultRow[]; label: string }) {
  return (
    <ul
      aria-label={label}
      data-bulk-results=""
      className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-surface"
    >
      {rows.map((row) => (
        <li key={row.key} data-ok={row.ok || undefined} className="flex items-start gap-3 p-3">
          <RowIcon ok={row.ok} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-semibold text-text-primary">{row.courtName}</span>
              <span className={cn("shrink-0 text-xs font-semibold", row.ok ? "text-success-strong" : "text-danger-strong")}>
                {row.word}
              </span>
            </span>
            <span className="text-sm text-text-secondary">{row.when}</span>
            {row.detail ? <span className="text-sm text-text-secondary">{row.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
