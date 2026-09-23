import { CheckCircle, XCircle } from "../ui/icons";

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
      className="flex flex-col gap-3 rounded-lg border border-border bg-bg-surface p-4"
    >
      {/*
        `role="status"` rather than an alert: the batch has finished and this is the record of
        it, read once when it appears. The heading states the proportion before any row, so a
        reader hears "3 of 4 done" and then goes looking for the one.
      */}
      <h3 role="status" className="text-sm font-semibold text-text-primary">
        {`${done} of ${rows.length} done`}
      </h3>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id} className="flex gap-2 text-sm">
            {/* A word and an icon, never colour alone. */}
            {row.ok
              ? <CheckCircle size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0 text-success-strong" />
              : <XCircle size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0 text-danger-strong" />}
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
