import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { LedgerRow } from "../lib/api";
import { cn, formatSignedCredits } from "../lib/utils";
import { clubDayAndClock, clubInstant } from "../lib/clubClock";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { ArrowRight, CaretDown, CaretUp, CaretUpDown } from "./ui/icons";
import { ScrollArea } from "./ScrollArea";

type Column = "time" | "from" | "to" | "amount" | "comment";
type SortDir = "asc" | "desc";

/**
 * What the movement WAS reads before what it cost, and the money sits in the right-most column
 * where a ledger keeps it. On a phone this leaves two columns — the movement (with its time
 * under it) and the amount (with its counterparty under it) — instead of five squeezed ones.
 */
const DEFAULT_COLUMNS: Column[] = ["time", "from", "to", "comment", "amount"];

type LedgerTableProps = {
  rows: LedgerRow[];
  columns?: Column[];
  emptyText?: string;
  /** When true, the table fills its parent and scrolls internally with a sticky header. */
  fill?: boolean;
  /**
   * Names the scrolling region for assistive tech. Required, not defaulted: two ledgers exist —
   * a member's wallet and the club's whole book — and "Ledger" would be a lie on one of them.
   */
  label: string;
};

type Sort = { key: Column; dir: SortDir };

function sortValue(row: LedgerRow, key: Column): string | number {
  switch (key) {
    case "time": return new Date(row.at).getTime();
    case "from": return row.from;
    case "to": return row.to;
    case "amount": return row.signedAmountCredits;
    case "comment": return row.comment ?? "";
  }
}

function sortRows(rows: LedgerRow[], sort: Sort): LedgerRow[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
  });
}

/** Time and money sort newest / largest first; words sort A→Z. */
function nextSort(current: Sort, key: Column): Sort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "time" || key === "amount" ? "desc" : "asc" };
}

/**
 * The ledger, on the `ui/table` parts (P3).
 *
 * <p>
 * <b>Inside `ScrollArea`, not the primitive `Table`'s own scroller.</b> The primitive wraps its
 * table in an `overflow-x-auto` box; nested inside `ScrollArea` that inner box would take the
 * sideways scroll and the outer one — which owns the edge fades, the keyboard stop and the
 * "scrolls sideways" sentence — would never know there was more. So the parts are used and the
 * scroller is ScrollArea's, and the header is sticky against it.
 * </p>
 *
 * <p>
 * <b>Money reads by sign, twice.</b> Credit in is the success ink with a "+", credit out is the
 * primary ink with a real U+2212 minus — never the warning ink: spending your own credit on a
 * court is the product working, not something to look at. The sign is the non-colour cue.
 * </p>
 */
export function LedgerTable(props: LedgerTableProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { rows, columns = DEFAULT_COLUMNS, emptyText = "No movements yet.", fill = false, label } = props;
  const [sort, setSort] = useState<Sort>({ key: "time", dir: "desc" });
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const headerFor = (column: Column) => (
    <SortHeader {...HEADER[column]} k={column} sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} />
  );

  if (rows.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-text-secondary sm:px-6">{emptyText}</p>;
  }

  return (
    // ScrollArea, not a bare overflow-auto div: the ledger is wider than a phone, and a
    // container that silently cuts off the Amount column reads as a missing column rather
    // than as one swipe away. It also makes the region keyboard-reachable.
    <ScrollArea label={label} className={cn(fill && "min-h-0 flex-1")}>
      <table data-slot="table" className="w-full border-collapse text-sm">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => <Fragment key={column}>{headerFor(column)}</Fragment>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r) => <LedgerLine key={r.id} row={r} columns={columns} />)}
        </TableBody>
      </table>
    </ScrollArea>
  );
}

function LedgerLine({ row, columns }: { row: LedgerRow; columns: Column[] }) {
  return (
    <TableRow>
      {columns.map((column) => <Fragment key={column}>{CELL[column](row)}</Fragment>)}
    </TableRow>
  );
}

/**
 * One renderer per column, so the order is the caller's `columns` and nothing else.
 *
 * <p>
 * <b>Time — the club's day, in the club's format.</b> This column used to go through the
 * reader-locale helper in `lib/utils` — the READER's locale and zone — and one member journey
 * read `23:15` on the grid, `Mon, Sep 21, 11:15 PM` in the toast and `9/21/26, 8:31 PM` here.
 * `lib/clubClock` is `en-GB`, 24-hour, in the club's zone; the `title` carries the long form.
 * On a phone the column folds away and the time rides under the comment instead.
 * </p>
 */
const CELL: Record<Column, (r: LedgerRow) => ReactNode> = {
  time: (r) => (
    <TableCell className="hidden whitespace-nowrap align-top text-xs tabular-nums text-text-secondary sm:table-cell" title={clubInstant(r.at)}>
      {clubDayAndClock(r.at)}
    </TableCell>
  ),
  from: (r) => (
    <TableCell className="hidden max-w-44 truncate align-top sm:table-cell" title={r.from}>{r.from}</TableCell>
  ),
  to: (r) => (
    <TableCell className="hidden align-top sm:table-cell">
      <span className="inline-flex max-w-44 items-center gap-1.5" title={r.to}>
        <ArrowRight size={14} weight="bold" aria-hidden="true" className="shrink-0 text-text-muted" />
        <span className="truncate">{r.to}</span>
      </span>
    </TableCell>
  ),
  // Wraps on a phone — it is the only column that says what a movement WAS, and for a top-up
  // the only place the rand amount and the rate appear — and truncates with a tooltip from
  // `sm`, where there is room for a column. Primary ink on a phone, where it leads the row.
  comment: (r) => (
    <TableCell className="break-words align-top text-sm text-text-primary sm:max-w-xs sm:truncate sm:text-text-secondary" title={r.comment}>
      {r.comment}
      <time dateTime={r.at} className="mt-0.5 block text-xs tabular-nums text-text-muted sm:hidden">{clubDayAndClock(r.at)}</time>
    </TableCell>
  ),
  amount: (r) => {
    const credit = r.signedAmountCredits >= 0;
    return (
      <TableCell
        className={cn(
          "whitespace-nowrap text-right align-top font-semibold tabular-nums",
          credit ? "text-success-strong" : "text-text-primary",
        )}
      >
        {formatSignedCredits(r.signedAmountCredits)}
        {/* On a phone the From/To columns are hidden, so the counterparty rides under the
            amount rather than being lost — picked by sign, because the member is the other end. */}
        <span className="block text-xs font-normal text-text-muted sm:hidden">{credit ? r.from : r.to}</span>
      </TableCell>
    );
  },
};

type HeaderLook = { label: string; align?: "left" | "right"; hideOnMobile?: boolean };

const HEADER: Record<Column, HeaderLook> = {
  time: { label: "Time", hideOnMobile: true },
  from: { label: "From", hideOnMobile: true },
  to: { label: "To", hideOnMobile: true },
  comment: { label: "Comment" },
  amount: { label: "Amount", align: "right" },
};

type HeaderProps = {
  label: string;
  k: Column;
  sort: Sort;
  onSort: (k: Column) => void;
  align?: "left" | "right";
  hideOnMobile?: boolean;
};

/**
 * A sortable column head: the whole label is the button, `aria-sort` on the header says which
 * way the column runs (so it is not only the caret that says so), and the head is sticky
 * against the ScrollArea.
 */
function SortHeader(props: HeaderProps) {
  const { label, k, sort, onSort, align = "left", hideOnMobile = false } = props;
  const active = sort.key === k;
  const Icon = !active ? CaretUpDown : sort.dir === "asc" ? CaretUp : CaretDown;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn(
        "sticky top-0 z-sticky",
        align === "right" ? "text-right" : "text-left",
        hideOnMobile && "hidden sm:table-cell",
      )}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          "no-lift -mx-1 inline-flex min-h-touch items-center gap-1 rounded-md px-1 uppercase tracking-overline",
          "transition-colors duration-fast ease-standard hover:text-text-primary motion-reduce:transition-none",
          active && "text-text-primary",
        )}
      >
        <span>{label}</span>
        <Icon size={14} weight="bold" aria-hidden="true" className={active ? "" : "text-text-muted"} />
      </button>
    </TableHead>
  );
}
