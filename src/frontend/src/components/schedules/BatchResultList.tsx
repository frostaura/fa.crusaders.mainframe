// `Check` and `X` rather than the circled pair: `src/types/lucide-react.d.ts` is a hand-kept
// ambient declaration (the package's CJS bundle ships no types) and does not declare
// `CheckCircle2`/`XCircle`. That file is outside this lane's scope, so the two icons it
// already declares are used instead and the addition is reported rather than made.
import { Check, X } from "lucide-react";

/**
 * What a batch actually did, per item, as a region of the page.
 *
 * <p>
 * <b>Never a toast.</b> A toast is four seconds long and the viewport deliberately carries no
 * live region, so a per-item outcome delivered as one is an outcome nobody read. This surface
 * has exactly one batch — clearing the member bookings that stand in the way of a hold — and
 * every row of it moves somebody's money, so "4 of 4 done" on its own is not enough either:
 * the row that failed has to say which booking and why, beside the three that did not.
 * </p>
 *
 * <p>
 * Generic, and described for the chrome lane rather than built there: this is
 * `components/ResultList.tsx` in D3 §3.3, which the UI lane owns and has not landed. Nothing
 * in here knows about schedules.
 * </p>
 */

export type BatchResultRow = {
  id: string;
  /** What the row is about, in words: "Court 2, Tue 13 Oct 18:00 — Thandi Mokoena". */
  label: string;
  ok: boolean;
  /** Why it failed, or what it did. A row with no sentence is a row nobody can act on. */
  detail: string;
};

export function BatchResultList({
  heading, rows, children,
}: { heading: string; rows: BatchResultRow[]; children?: React.ReactNode }) {
  const done = rows.filter((r) => r.ok).length;
  return (
    <section
      aria-label={heading}
      className="space-y-3 rounded-lg border border-border bg-bg-surface p-4"
    >
      {/*
        `role="status"` rather than an alert: the batch has finished and this is the record of
        it, read once when it appears. The heading states the proportion before any row, so a
        reader hears "3 of 4 done" and then goes looking for the one.
      */}
      <h3 role="status" className="text-sm font-semibold text-text-primary">
        {`${done} of ${rows.length} done`}
      </h3>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="flex gap-2 text-sm">
            {/* A word and an icon, never colour alone. */}
            {row.ok
              ? <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success-strong" />
              : <X aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-danger-strong" />}
            <span className="text-text-primary">
              <span className={row.ok ? "text-success-strong" : "text-danger-strong"}>
                {row.ok ? "Done" : "Not done"}
              </span>
              {" — "}
              {row.label}
              {". "}
              <span className="text-text-secondary">{row.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {children}
    </section>
  );
}
