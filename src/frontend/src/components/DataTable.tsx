import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Inbox, Search } from "lucide-react";
import { cn } from "../lib/utils";
import { Input } from "./Button";

export type DataColumn<T> = {
  key: string;
  header: string;
  /** Width in px. Optional — without it the column auto-sizes. */
  width?: number;
  align?: "left" | "right" | "center";
  /** Default true. Set false to disable sort affordance for this column. */
  sortable?: boolean;
  /** Cell renderer. */
  cell: (row: T) => ReactNode;
  /** Used for sorting. Defaults to whatever the cell renderer returns when it's a primitive. */
  sortValue?: (row: T) => string | number;
};

type SortDir = "asc" | "desc";

type DataTableProps<T> = {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  /** If provided, renders a search input above the table that filters by these fields. */
  search?: {
    placeholder?: string;
    fields: (row: T) => string;
  };
  defaultSort?: { key: string; dir?: SortDir };
  emptyTitle?: string;
  emptyHint?: string;
  loading?: boolean;
  /** When set, caps the scroll-area height (e.g. "60vh", 480, "calc(100vh-300px)"). Header stays sticky inside. */
  maxHeight?: string | number;
};

export function DataTable<T>({
  rows, columns, rowKey, search, defaultSort,
  emptyTitle = "No results", emptyHint, loading, maxHeight,
}: DataTableProps<T>) {
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSort?.key);
  const [sortDir, setSortDir] = useState<SortDir>(defaultSort?.dir ?? "asc");

  const filtered = useMemo(() => {
    if (!search || !q.trim()) return rows;
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => search.fields(r).toLowerCase().includes(needle));
  }, [rows, search, q]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    const valueOf = (r: T): string | number => {
      if (col.sortValue) return col.sortValue(r);
      const v = col.cell(r);
      if (typeof v === "number" || typeof v === "string") return v;
      return String(v ?? "");
    };
    return [...filtered].sort((a, b) => {
      const av = valueOf(a); const bv = valueOf(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [filtered, sortKey, sortDir, columns]);

  const onSort = (k: string) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("asc"); }
  };

  const hasFilter = q.trim().length > 0;

  return (
    <div className="space-y-3">
      {search && (
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={search.placeholder ?? "Filter…"}
            className="pl-9"
          />
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyState loading={!!loading} hasFilter={hasFilter} title={emptyTitle} hint={emptyHint} />
      ) : (
        <div
          className="overflow-auto rounded-lg border border-border"
          style={maxHeight !== undefined ? { maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight } : undefined}
        >
          <table className="w-full text-sm">
            <thead className="bg-bg-muted text-xs uppercase tracking-wide text-text-muted sticky top-0 z-10 [&>tr>th]:border-b [&>tr>th]:border-border">
              <tr>
                {columns.map((c) => {
                  const sortable = c.sortable !== false;
                  const active = sortKey === c.key;
                  const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
                  const align = c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left";
                  return (
                    <th
                      key={c.key}
                      style={c.width ? { width: c.width } : undefined}
                      className={cn("px-4 py-3 font-medium", align)}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => onSort(c.key)}
                          className={cn(
                            "inline-flex items-center gap-1 hover:text-text-primary",
                            active && "text-text-primary",
                            c.align === "right" && "ml-auto",
                          )}
                        >
                          <span>{c.header}</span>
                          <Icon size={12} className={cn(active ? "opacity-100" : "opacity-40")} />
                        </button>
                      ) : (
                        <span>{c.header}</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-bg-surface">
              {sorted.map((row) => (
                <tr key={rowKey(row)} className="hover:bg-bg-muted/30">
                  {columns.map((c) => {
                    const align = c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left";
                    return (
                      <td key={c.key} className={cn("px-4 py-3 align-middle", align)}>
                        {c.cell(row)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmptyState({ loading, hasFilter, title, hint }: { loading: boolean; hasFilter: boolean; title: string; hint?: string }) {
  return (
    <div className="border border-dashed border-border rounded-lg py-12 flex flex-col items-center justify-center gap-2 text-center bg-bg-surface">
      <Inbox size={26} className="text-text-muted" />
      <p className="text-sm text-text-secondary">
        {loading ? "Loading…" : hasFilter ? "No matches for that search." : title}
      </p>
      {!loading && hint && <p className="text-xs text-text-muted">{hasFilter ? "Try clearing the search." : hint}</p>}
    </div>
  );
}
