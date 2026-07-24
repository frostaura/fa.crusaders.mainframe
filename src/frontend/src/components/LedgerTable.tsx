import { useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpDown } from "lucide-react";
import type { LedgerRow } from "../lib/api";
import { cn } from "../lib/utils";

type Column = "time" | "from" | "to" | "amount" | "comment";
type SortDir = "asc" | "desc";

const DEFAULT_COLUMNS: Column[] = ["time", "from", "to", "amount", "comment"];

export function LedgerTable({
  rows,
  columns = DEFAULT_COLUMNS,
  emptyText = "No movements yet.",
  /** When true, the table fills its parent and scrolls internally with a sticky header. */
  fill = false,
}: {
  rows: LedgerRow[];
  columns?: Column[];
  emptyText?: string;
  fill?: boolean;
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
        case "amount": return r.signedAmountZar;
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
    <div className={cn("overflow-auto", fill && "flex-1 min-h-0")}>
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-text-muted bg-bg-muted sticky top-0 z-10 [&>tr>th]:border-b [&>tr>th]:border-border">
          <tr>
            {columns.includes("time") && <SortHeader label="Time" k="time" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />}
            {columns.includes("from") && <SortHeader label="From" k="from" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />}
            {columns.includes("to") && <SortHeader label="To" k="to" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />}
            {columns.includes("amount") && <SortHeader label="Amount" k="amount" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />}
            {columns.includes("comment") && <SortHeader label="Comment" k="comment" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={r.id} className="hover:bg-bg-muted/30">
              {columns.includes("time") && (
                <td className="px-4 py-2 align-top whitespace-nowrap font-mono text-xs text-text-secondary">
                  {new Date(r.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
                </td>
              )}
              {columns.includes("from") && (
                <td className="px-4 py-2 align-top text-text-primary truncate max-w-[180px]" title={r.from}>{r.from}</td>
              )}
              {columns.includes("to") && (
                <td className="px-4 py-2 align-top">
                  <span className="inline-flex items-center gap-1 text-text-primary truncate max-w-[180px]" title={r.to}>
                    <ArrowRight size={12} className="text-text-muted shrink-0" /> {r.to}
                  </span>
                </td>
              )}
              {columns.includes("amount") && (
                <td className={cn(
                  "px-4 py-2 align-top text-right font-mono whitespace-nowrap",
                  r.signedAmountZar >= 0 ? "text-success-strong" : "text-warning-strong",
                )}>
                  {r.signedAmountZar >= 0 ? "+" : "−"}R{r.amountZar.toFixed(2)}
                </td>
              )}
              {columns.includes("comment") && (
                <td className="px-4 py-2 align-top text-xs text-text-secondary max-w-[280px] truncate" title={r.comment}>
                  {r.comment}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label, k, sortKey, sortDir, onSort, align = "left",
}: {
  label: string; k: Column; sortKey: Column; sortDir: SortDir; onSort: (k: Column) => void; align?: "left" | "right";
}) {
  const active = sortKey === k;
  const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={cn("font-medium px-4 py-2", align === "right" ? "text-right" : "text-left")}>
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
