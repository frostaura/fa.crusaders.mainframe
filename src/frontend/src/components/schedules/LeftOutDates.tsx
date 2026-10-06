import { Button } from "../ui/button";
import { LEFT_OUT_HEADING, PUT_BACK, clubDateShort, putBackLabel } from "../../lib/scheduleCopy";

/**
 * The dates the admin has left out of the series being drawn, each with its undo.
 *
 * <p>
 * Shown beside the sentence rather than inside the conflict panel: a left-out date is part of what
 * is being created — it lands on the series as a skipped date — so it belongs with the sentence
 * that describes the series, and it stays visible once the conflicts it answered are gone.
 * </p>
 */
export function LeftOutDates({
  dates, busy, onPutBack,
}: { dates: readonly string[]; busy: boolean; onPutBack: (date: string) => void }) {
  return (
    <section aria-label={LEFT_OUT_HEADING} className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
      <h3 className="text-sm font-semibold text-text-primary">{LEFT_OUT_HEADING}</h3>
      <ul className="flex flex-wrap gap-2">
        {dates.map((date) => (
          <li key={date} className="flex items-center gap-2 rounded-md bg-bg-muted py-1 pl-3 pr-1 text-sm text-text-primary">
            <span>{clubDateShort(date)}</span>
            {/* The date is beside it, so the face says "Put back"; the name carries the date. */}
            <Button variant="ghost" size="sm" disabled={busy} aria-label={putBackLabel(date)} onClick={() => onPutBack(date)}>
              {PUT_BACK}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
