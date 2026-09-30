import { presentChanges } from "@/lib/changeRecordCopy";
import type { AdminChangeRow } from "@/lib/adminApi";

/**
 * One change-record row's "what changed", in words (review round 2, F3-7) — shared by the club's
 * change record and a repeating booking's own history, which printed the stored keys.
 *
 * <p>
 * Two parts, because they are two different things: what moved from one value to another
 * (before → after), and the facts the action carried (the amount collected, the seat, the court).
 * A fact used to sit in the Before column with an em dash after it, reading as something removed.
 * </p>
 */
export function ChangeDiff({ row }: { row: Pick<AdminChangeRow, "area" | "action" | "changes"> }) {
  const { changed, facts } = presentChanges(row);
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg bg-bg-muted p-3 text-sm">
      {changed.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1">
          <dt className="text-text-muted">Field</dt>
          <dd className="text-text-muted">Before</dd>
          <dd className="text-text-muted">After</dd>
          {changed.map((line) => (
            <div key={line.field} className="contents">
              <dt className="min-w-0 break-words text-text-secondary">{line.label}</dt>
              {/* An em dash, not an empty cell: a blank reads as "the page did not load it"
                  and a dash reads as "there was nothing there", which is the true one. */}
              <dd className="min-w-0 break-words tabular-nums text-text-primary">{line.before ?? "—"}</dd>
              <dd className="min-w-0 break-words tabular-nums text-text-primary">{line.after ?? "—"}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {facts.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {facts.map((fact) => (
            <div key={fact.field} className="contents">
              <dt className="min-w-0 break-words text-text-secondary">{fact.label}</dt>
              <dd className="min-w-0 break-words tabular-nums text-text-primary">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
