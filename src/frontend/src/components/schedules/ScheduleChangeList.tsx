import { StateBlock } from "../ui/state-block";
import { clubDayAndClock } from "../../lib/clubClock";
import { CHANGES_HEADING, CHANGES_UNDELETABLE } from "../../lib/scheduleCopy";
import type { AdminChangePage } from "../../lib/adminApi";

/**
 * This one schedule's own slice of the append-only admin change record.
 *
 * <p>
 * <b>Read-only, and that is enforced by there being nothing here that writes.</b> Ruling 2 and
 * D2 §11.6: the store is trigger-protected, has no delete endpoint and is exempt from
 * retention, and the page says the true thing about it — "Nobody can delete these from the
 * app, including admins". D3 §12's story P8 asserts the absence of any edit or delete control
 * in this region's DOM, so the region is given a name and the test asserts the absence by that
 * name rather than by position.
 * </p>
 *
 * <p>
 * <b>The retention sentence is the SERVER's, never composed here.</b> It is a fact about a
 * worker's schedule and a tenant setting, and a screen that restates it from memory is a
 * screen that will be wrong the day either changes.
 * </p>
 */
export function ScheduleChangeList({
  page, loading, error, onRetry, timezone,
}: {
  page: AdminChangePage | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  timezone?: string;
}) {
  const rows = page?.rows ?? [];
  return (
    <section aria-label={CHANGES_HEADING} className="space-y-3">
      <h2 className="text-lg font-semibold text-text-primary">{CHANGES_HEADING}</h2>
      <p className="text-sm text-text-secondary">
        Everything an admin has done to this repeating booking, in the order it happened.
      </p>
      {/* Its own sentence, not a clause. It is the claim GOAL item 14 asks for by name, and a
          claim buried at the end of a longer line is one nobody reads. */}
      <p className="text-sm font-medium text-text-primary">{CHANGES_UNDELETABLE}</p>
      <StateBlock
        loading={loading}
        error={error}
        action="this repeating booking's change record"
        failedCaveat="That does not mean nothing has been changed."
        onRetry={onRetry}
        empty={!loading && !error && rows.length === 0}
        emptyTitle="Nothing has been changed here yet."
        emptyHint="Creating it is the first thing that will appear."
      >
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="border-b border-border pb-3 last:border-b-0">
              <p className="text-sm text-text-muted">
                {`${clubDayAndClock(row.occurred_at, page?.timezone ?? timezone)} · ${row.actor?.name ?? "Somebody no longer named"}`}
              </p>
              {/* The headline is composed on the SERVER, from a closed dictionary. The door
                  console's own local dictionary painting a code it did not know is the
                  warning this follows; the code itself is the fallback, never `undefined`. */}
              <p className="text-sm text-text-primary">{row.headline ?? row.action ?? "Something the app has no word for"}</p>
              {row.reason && <p className="text-sm text-text-secondary">{`Reason: “${row.reason}”`}</p>}
              {row.changes && row.changes.length > 0 && (
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                  {row.changes.map((change) => (
                    <div key={change.field} className="contents">
                      <dt className="text-text-muted">{change.field}</dt>
                      <dd className="text-text-primary">
                        {`${change.before ?? "—"} → ${change.after ?? "—"}`}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ul>
      </StateBlock>
      {page?.retention && <p className="text-sm text-text-muted">{page.retention}</p>}
    </section>
  );
}
