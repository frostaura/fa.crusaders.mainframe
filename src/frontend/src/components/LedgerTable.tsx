import { useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpDown } from "lucide-react";
import type { LedgerRow } from "../lib/api";
import { cn, formatInstant, formatSignedCredits } from "../lib/utils";
import { ScrollArea } from "./ScrollArea";

type Column = "time" | "from" | "to" | "amount" | "comment";
type SortDir = "asc" | "desc";

const DEFAULT_COLUMNS: Column[] = ["time", "from", "to", "amount", "comment"];

export function LedgerTable({
  rows,
  columns = DEFAULT_COLUMNS,
  emptyText = "No movements yet.",
  /** When true, the table fills its parent and scrolls internally with a sticky header. */
  fill = false,
  /**
   * Names the scrolling region for assistive tech. Required, not defaulted: two ledgers exist —
   * a member's wallet and the club's whole book — and "Ledger" would be a lie on one of them.
   * A default here would also be a branch, and lizard charges the whole component for it.
   */
  label,
}: {
  rows: LedgerRow[];
  columns?: Column[];
  emptyText?: string;
  fill?: boolean;
  label: string;
}) {
  const [sortKey, setSortKey] = useState<Column>("time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const valueOf = (r: LedgerRow): string | number => {
      switch (sortKey) {
        case "time": return new Date(r.at).getTime();
        case "from": return r.from;
        case "to": return r.to;
        case "amount": return r.signedAmountCredits;
        case "comment": return r.comment ?? "";
      }
    };
    return [...rows].sort((a, b) => {
      const av = valueOf(a); const bv = valueOf(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [rows, sortKey, sortDir]);

  const onSort = (k: Column) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "time" || k === "amount" ? "desc" : "asc"); }
  };

  if (rows.length === 0) return <p className="text-sm text-text-secondary px-4 sm:px-6 py-3">{emptyText}</p>;

  return (
    // ScrollArea, not a bare overflow-auto div: the ledger is wider than a phone, and a
    // container that silently cuts off the Amount column reads as a missing column rather
    // than as one swipe away. It also makes the region keyboard-reachable, which a plain
    // scrolling div is not.
    <ScrollArea label={label} className={cn(fill && "flex-1 min-h-0")}>
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-text-muted bg-bg-muted sticky top-0 z-10 [&>tr>th]:border-b [&>tr>th]:border-border">
          <tr>
            {columns.includes("time") && <SortHeader label="Time" k="time" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />}
            {columns.includes("from") && <SortHeader label="From" k="from" sortKey={sortKey} sortDir={sortDir} onSort={onSort} hideOnMobile />}
            {columns.includes("to") && <SortHeader label="To" k="to" sortKey={sortKey} sortDir={sortDir} onSort={onSort} hideOnMobile />}
            {columns.includes("amount") && <SortHeader label="Amount" k="amount" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />}
            {columns.includes("comment") && <SortHeader label="Comment" k="comment" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={r.id} className="hover:bg-bg-muted/30">
              {columns.includes("time") && (
                <td className="px-2 sm:px-4 py-2 align-top whitespace-nowrap font-mono text-xs text-text-secondary">
                  {formatInstant(r.at)}
                </td>
              )}
              {columns.includes("from") && (
                <td className="hidden sm:table-cell px-4 py-2 align-top text-text-primary truncate max-w-[180px]" title={r.from}>{r.from}</td>
              )}
              {columns.includes("to") && (
                <td className="hidden sm:table-cell px-4 py-2 align-top">
                  <span className="inline-flex items-center gap-1 text-text-primary truncate max-w-[180px]" title={r.to}>
                    <ArrowRight size={12} className="text-text-muted shrink-0" /> {r.to}
                  </span>
                </td>
              )}
              {columns.includes("amount") && (
                <td className={cn(
                  "px-2 sm:px-4 py-2 align-top text-right font-mono tabular-nums whitespace-nowrap",
                  r.signedAmountCredits >= 0 ? "text-success-strong" : "text-warning-strong",
                )}>
                  {formatSignedCredits(r.signedAmountCredits)}
                  {/* On a phone the From/To columns are hidden, so the counterparty rides
                      under the amount rather than being lost. */}
                  <span className="block sm:hidden text-[10px] font-normal text-text-muted">
                    {r.signedAmountCredits >= 0 ? r.from : r.to}
                  </span>
                </td>
              )}
              {columns.includes("comment") && (
                // On a phone this wraps; from `sm` up it truncates with a tooltip.
                //
                // It used to be capped at 140px and ellipsised at every width, so at 375px
                // every row read "Booking Court 2 2…" / "No-show — booki…" — and the comment
                // is the only column that says what a movement WAS, and for a top-up the only
                // place the rand amount and the conversion rate appear at all. The container
                // offered 30px of sideways travel against a 287px cell, so the sentence
                // underneath ("scrolls sideways — there is more to see") was true of the table
                // and false of this column, and the escape hatch was a `title` tooltip a touch
                // device has no way to open. A promise the product could not keep.
                //
                // Wrapping costs row height on the one screen with the height to spare.
                <td className="px-2 sm:px-4 py-2 align-top text-xs text-text-secondary break-words sm:max-w-[280px] sm:truncate" title={r.comment}>
                  {r.comment}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function SortHeader({
  label, k, sortKey, sortDir, onSort, align = "left", hideOnMobile = false,
}: {
  label: string; k: Column; sortKey: Column; sortDir: SortDir; onSort: (k: Column) => void; align?: "left" | "right"; hideOnMobile?: boolean;
}) {
  const active = sortKey === k;
  const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={cn(
      "font-medium px-2 sm:px-4 py-2",
      align === "right" ? "text-right" : "text-left",
      hideOnMobile && "hidden sm:table-cell",
    )}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-text-primary",
          active && "text-text-primary",
          align === "right" && "ml-auto",
        )}
      >
        <span>{label}</span>
        <Icon size={12} className={cn(active ? "opacity-100" : "opacity-40")} />
      </button>
    </th>
  );
}
