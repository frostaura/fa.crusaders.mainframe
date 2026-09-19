import { Button, fieldClassName } from "./Button";

function formatDayOfWeek(ymdDate: string): string {
  const [y, m, d] = ymdDate.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(y, m - 1, d));
}

/**
 * The date picker, the refresh control and the day's name.
 *
 * <p>
 * Lifted out of `SchedulePage` for length rather than for reuse: the page carries the
 * schedule's whole state machine — two modals, four mutations and an optimistic grid — and
 * the complexity gate's 200-line limit is what stops that growing without anyone deciding to
 * let it. The strip has no state of its own, so moving it costs nothing.
 * </p>
 */
export function DayBar({ date, bounds, loading, onDate, onRefresh }: {
  date: string;
  bounds: { min?: string; max?: string };
  loading: boolean;
  onDate: (d: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="date"
        aria-label="Schedule date"
        value={date}
        min={bounds.min}
        max={bounds.max}
        onChange={(e) => onDate(e.target.value)}
        className={fieldClassName}
      />
      <Button variant="ghost" onClick={onRefresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Button>
      <span className="ml-auto text-sm font-medium text-text-secondary">{formatDayOfWeek(date)}</span>
    </div>
  );
}
