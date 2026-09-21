import { Button, fieldClassName } from "./Button";
import { cn } from "../lib/utils";
import { weekdayName } from "../lib/gridCopy";

/**
 * The date picker, the refresh control, the day's name, and the two things the grid needs to
 * say before a member has picked anything: how much of their quota is gone, and which group's
 * rate they are booking at.
 *
 * <p>
 * <b>D3-B17 / D4 §2.7.</b> The weekday was `ml-auto` on a `flex` row with no wrap, so at 320 px
 * it measured 15 px past the right edge — clipped — and reading as a stray label at the far end
 * of the strip rather than as the date's own name. It sits beside the date now, and the row
 * wraps, which is the treatment `Layout.tsx:245` already applies to the header.
 * </p>
 *
 * <p>
 * <b>The weekday is the club's spelling, not the reader's.</b> It was
 * `Intl.DateTimeFormat(undefined, …)` — the browser's locale — one of the three clock
 * conventions D4 §2.4 counted on this journey.
 * </p>
 */
export function DayBar(props: {
  date: string;
  bounds: { min?: string; max?: string };
  loading: boolean;
  timezone?: string;
  onDate: (d: string) => void;
  onRefresh: () => void;
  /** Item 19's counter. Null until the member has booked something on this day. */
  quota?: { text: string; atLimit: boolean } | null;
  /** "You're booking as a league member." — item 3, and only when a group price applies. */
  rateLine?: string | null;
  /** Admin-only: whether multi-select exists at all on this grid. */
  selectable?: boolean;
  selecting?: boolean;
  onToggleSelect?: () => void;
}) {
  const { date, bounds, loading, onDate, onRefresh, quota, rateLine, selectable, selecting, onToggleSelect } = props;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input
          type="date"
          aria-label="Schedule date"
          value={date}
          min={bounds.min}
          max={bounds.max}
          onChange={(e) => onDate(e.target.value)}
          className={fieldClassName}
        />
        <span className="text-sm font-medium text-text-secondary">{weekdayName(date)}</span>
        <Button variant="ghost" onClick={onRefresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Button>
        {selectable && (
          <Button variant="outline" onClick={onToggleSelect} aria-pressed={selecting}>
            {selecting ? "Done" : "Select"}
          </Button>
        )}
        {quota && (
          // Approaching a limit is not a warning; only arriving at it is. This is the only
          // place the pill changes tone, and it is why a member should never meet the wall.
          <span className={cn(
            "ml-auto rounded-full px-3 py-1 text-xs font-medium",
            quota.atLimit ? "bg-warning-soft text-warning-strong" : "bg-bg-muted text-text-secondary",
          )}>
            {quota.text}
          </span>
        )}
      </div>
      {/* Naming the group makes the difference a MEMBERSHIP, which a member chose, rather than
          a discrimination, which happens to them. One quiet line, never a price comparison. */}
      {rateLine && <p className="text-xs text-text-secondary">{rateLine}</p>}
    </div>
  );
}
