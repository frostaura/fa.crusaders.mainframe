import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { revealOnFocus } from "../lib/revealInScroller";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { StateBlock } from "./ui/state-block";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { CaretDown, CaretUp, CaretUpDown, MagnifyingGlass, Tray } from "./ui/icons";

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
type Sort = { key: string | undefined; dir: SortDir };

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
  /** When set, caps the scroll-area height (e.g. "60vh", 480). The header stays sticky inside. */
  maxHeight?: string | number;
  /**
   * The table's name (F3.21/F3.22): names the table, and makes its scroller a focusable region
   * so a table wider than a phone can be scrolled from the keyboard.
   */
  label?: string;
  /**
   * Let the headers wrap at their words (R6 L6-14): a wide table of short figures whose one-line
   * uppercase headers ("PENALTIES (NET)", "SHARES BETWEEN PLAYERS") made it 440 px wider than a
   * 1280 screen's column; wrapped, the figures decide the widths.
   */
  wrapHeaders?: boolean;
};

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

function valueOf<T>(column: DataColumn<T>, row: T): string | number {
  if (column.sortValue) return column.sortValue(row);
  const v = column.cell(row);
  if (typeof v === "number" || typeof v === "string") return v;
  return String(v ?? "");
}

function sortRows<T>(rows: T[], columns: DataColumn<T>[], sort: Sort): T[] {
  const column = columns.find((c) => c.key === sort.key);
  if (!column) return rows;
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = valueOf(column, a);
    const bv = valueOf(column, b);
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
  });
}

/**
 * A sortable, optionally searchable table on the `ui/table` parts (P3).
 *
 * <p>
 * One rounded, bordered surface that scrolls both ways inside itself, so a wide admin table
 * never widens a 360 px page; the header is sticky against it, figures are tabular, and each
 * sortable header says its direction in `aria-sort` as well as with a caret. The search box is
 * a real labelled field (its placeholder is its name as well as its hint — a placeholder alone
 * is no label), and a filter that matches nothing says so differently from a table that is
 * genuinely empty.
 * </p>
 */
export function DataTable<T>(props: DataTableProps<T>) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { rows, columns, rowKey, search, defaultSort, emptyTitle = "No results", emptyHint, loading, maxHeight } = props;
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>({ key: defaultSort?.key, dir: defaultSort?.dir ?? "asc" });

  const filtered = useMemo(() => {
    if (!search || !q.trim()) return rows;
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => search.fields(r).toLowerCase().includes(needle));
  }, [rows, search, q]);
  const sorted = useMemo(() => sortRows(filtered, columns, sort), [filtered, columns, sort]);
  const scroller = useRef<HTMLDivElement>(null);
  const onSort = (key: string) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
    : { key, dir: "asc" }));
  const filtering = q.trim().length > 0;

  return (
    <div className="flex flex-col gap-3">
      {search && <SearchField value={q} onChange={setQ} placeholder={search.placeholder ?? "Filter…"} />}
      {sorted.length === 0 && loading ? (
        <TableSkeleton />
      ) : sorted.length === 0 ? (
        <StateBlock
          empty
          emptyIcon={filtering ? MagnifyingGlass : Tray}
          emptyTitle={filtering ? "No matches for that search." : emptyTitle}
          emptyHint={filtering ? "Try clearing the search." : emptyHint}
          className="rounded-xl border border-dashed border-border bg-bg-surface"
        />
      ) : (
        <SidewaysCue label={props.label} scroller={scroller} rows={sorted.length}>
        <div
          ref={scroller}
          data-slot="table-container"
          {...(props.label ? { role: "region", "aria-label": props.label, tabIndex: 0 } : {})}
          // R16 L16-1 — the frame scrolls, so it clips: the head's sort buttons sat on its top edge
          // and lost the top of their rings. Every ring inside it is drawn inside its control.
          className="relative w-full overflow-auto rounded-xl border border-border bg-bg-surface shadow-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong [&_:focus-visible]:-outline-offset-2"
          style={maxHeight !== undefined ? { maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight } : undefined}
        >
          <table data-slot="table" aria-label={props.label} className="w-full border-collapse text-sm">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((c) => <HeaderCell key={c.key} column={c} sort={sort} onSort={onSort} wrap={props.wrapHeaders === true} />)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow key={rowKey(row)}>
                  {columns.map((c) => (
                    <TableCell key={c.key} className={cn("py-3 tabular-nums", ALIGN[c.align ?? "left"])}>{c.cell(row)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </table>
        </div>
        </SidewaysCue>
      )}
    </div>
  );
}

/**
 * R8 L8-13: a table wider than its box says so. The Reports daily table hid its last column
 * (No-shows) past the right edge at 1280 with nothing to show it was one swipe away. A fade on
 * the side that has more — the same affordance as `ScrollArea`'s — and a sentence for a screen
 * reader, present only while there is more to reach.
 */
function SidewaysCue({ label, scroller, rows, children }: {
  label?: string; scroller: React.RefObject<HTMLDivElement | null>; rows: number; children: ReactNode;
}) {
  const more = useSidewaysMore(scroller, rows);
  const fade = "pointer-events-none absolute inset-y-px w-6 transition-opacity duration-fast to-transparent from-bg-surface";
  return (
    <div className="relative">
      {children}
      <div aria-hidden data-scroll-cue="left" className={cn(fade, "left-px rounded-l-xl bg-gradient-to-r", more.left ? "opacity-100" : "opacity-0")} />
      <div aria-hidden data-scroll-cue="right" className={cn(fade, "right-px rounded-r-xl bg-gradient-to-l", more.right ? "opacity-100" : "opacity-0")} />
      {more.left || more.right ? <p className="sr-only">{`${label ?? "This table"} scrolls sideways — there is more to see.`}</p> : null}
    </div>
  );
}

function useSidewaysMore(scroller: React.RefObject<HTMLDivElement | null>, rows: number) {
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      setMore((was) => {
        const now = { left: el.scrollLeft > 1, right: max - el.scrollLeft > 1 };
        return was.left === now.left && was.right === now.right ? was : now;
      });
    };
    // A ResizeObserver reports once on observe, which is the first measure; the frame covers a
    // browser without one.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    const frame = requestAnimationFrame(measure);
    el.addEventListener("scroll", measure, { passive: true });
    return () => { observer?.disconnect(); cancelAnimationFrame(frame); el.removeEventListener("scroll", measure); };
  }, [scroller, rows]);
  return more;
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (next: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <MagnifyingGlass size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-9"
      />
    </div>
  );
}

type HeaderCellProps<T> = { column: DataColumn<T>; sort: Sort; onSort: (key: string) => void; wrap: boolean };

function HeaderCell<T>({ column: c, sort, onSort, wrap }: HeaderCellProps<T>) {
  const sortable = c.sortable !== false;
  const active = sort.key === c.key;
  const Icon = !active ? CaretUpDown : sort.dir === "asc" ? CaretUp : CaretDown;
  const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  return (
    <TableHead
      style={c.width ? { width: c.width } : undefined}
      aria-sort={sortable ? ariaSort : undefined}
      className={cn("sticky top-0 z-sticky", ALIGN[c.align ?? "left"], wrap && "h-auto whitespace-normal py-1 align-bottom")}
    >
      {sortable ? (
        <button
          type="button"
          onClick={() => onSort(c.key)}
          // X-8: the cell is sticky, and Chromium does not scroll a sticky box into view on focus.
          onFocus={revealOnFocus}
          className={cn(
            "no-lift -mx-1 inline-flex min-h-touch items-center gap-1 rounded-md px-1 uppercase tracking-overline",
            "transition-colors duration-fast ease-standard hover:text-text-primary motion-reduce:transition-none",
            active && "text-text-primary",
            // R7 L7-17: a wrapping header puts its caret on a line of its own UNDER the label, in
            // every column. A flex-wrapped caret sat beside one header and under the next,
            // depending on whose words filled the column; glued beside the last word it cost every
            // column 18px and the daily table no longer fit 1280 (L6-14). Under, the carets of a
            // bottom-aligned header row share one line.
            wrap && ["flex-col justify-end gap-0.5", c.align === "right" ? "items-end" : c.align === "center" ? "items-center" : "items-start"],
          )}
        >
          <span>{c.header}</span>
          <Icon size={14} weight="bold" aria-hidden="true" className={active ? "" : "text-text-muted"} />
        </button>
      ) : (
        <span>{c.header}</span>
      )}
    </TableHead>
  );
}

/** The table's shape while its first read is out — never "Loading…" on its own (R12). */
function TableSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4">
      <span role="status" className="sr-only">Reading…</span>
      {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-6 w-full" />)}
    </div>
  );
}
