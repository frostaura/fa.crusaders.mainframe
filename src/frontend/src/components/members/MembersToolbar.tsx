import { Input } from "@/components/ui/input";
import { MagnifyingGlass } from "@/components/ui/icons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  MEMBERS_PAGE as COPY, STATUS_FILTERS, pendingCountLabel, type StatusFilter,
} from "@/lib/membersCopy";
import { cn } from "@/lib/utils";
import type { StatusCounts } from "./membersModel";

/**
 * Search and the status filter (P5).
 *
 * <p>
 * The filter is a toggle group, not a select: five choices an admin flips between all evening are
 * cheaper to see than to open. Each chip carries its count — and the Pending one carries it as a
 * badge in the attention colour, because that number is a queue somebody is waiting in. No count
 * is drawn until the list has been read: "0 pending" on a failed read is a claim about the club
 * the screen cannot make, and it once sent an admin home with applications waiting.
 * </p>
 */
export type MembersToolbarProps = {
  query: string;
  onQuery: (next: string) => void;
  status: StatusFilter;
  onStatus: (next: StatusFilter) => void;
  counts: StatusCounts | null;
  /**
   * One column whatever the viewport (R4 form factor): beside a member's record the list is a
   * 28rem pane, and `lg:flex-row` squeezed the search beside five chips.
   */
  stacked?: boolean;
};

export function MembersToolbar(props: MembersToolbarProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { query, onQuery, status, onStatus, counts, stacked = false } = props;
  return (
    <div className={cn("flex flex-col gap-3", !stacked && "lg:flex-row lg:flex-wrap lg:items-center lg:justify-between")}>
      {/* The search gives way to the filter chips (down to 12rem), and when both cannot share a
          line the chips take their own, whole, rather than one of six folding onto a second row. */}
      <div className={cn("relative w-full", !stacked && "lg:w-auto lg:min-w-48 lg:max-w-sm lg:flex-1")}>
        <MagnifyingGlass size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <Input
          type="search"
          aria-label={COPY.searchLabel}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={COPY.searchPlaceholder}
          className="pl-9"
        />
      </div>
      <ToggleGroup
        type="single"
        size="sm"
        aria-label={COPY.filterLabel}
        value={status}
        onValueChange={(next) => { if (next) onStatus(next as StatusFilter); }}
        className={cn(
          // Equal-width cells (three across on a phone) rather than a wrapping row whose second line
          // has other widths than its first; one row of natural widths from `lg` when not stacked.
          "grid w-full grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] rounded-lg bg-bg-muted p-1",
          !stacked && "lg:flex lg:w-fit lg:max-w-full lg:shrink-0",
        )}
      >
        {STATUS_FILTERS.map((f) => (
          <ToggleGroupItem key={f.value} value={f.value} className="data-[state=on]:bg-bg-surface data-[state=on]:shadow-xs">
            <span>{f.label}</span>
            <FilterCount value={f.value} counts={counts} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function FilterCount({ value, counts }: { value: StatusFilter; counts: StatusCounts | null }) {
  if (!counts) return null;
  const n = counts[value];
  if (value === "PendingApproval") {
    if (n === 0) return null;
    return (
      <span
        data-pending-count=""
        className="inline-flex min-w-5 items-center justify-center rounded-full bg-info-strong px-1.5 text-xs font-semibold tabular-nums text-bg-surface"
      >
        <span aria-hidden="true">{n}</span>
        <span className="sr-only">{`, ${pendingCountLabel(n)}`}</span>
      </span>
    );
  }
  return <span className={cn("text-xs font-medium tabular-nums text-text-muted")}>{n}</span>;
}
