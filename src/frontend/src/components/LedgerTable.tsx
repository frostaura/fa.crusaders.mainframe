import { Fragment, useMemo, useState } from "react";
import type { LedgerRow } from "../lib/api";
import { cn } from "../lib/utils";
import { clubDayAndClock } from "../lib/clubClock";
import { ledgerCategory, ledgerDoneBy, LEDGER_COPY } from "../lib/ledgerCopy";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Button } from "./ui/button";
import { CaretDown, CaretRight, CaretUp, CaretUpDown } from "./ui/icons";
import { ScrollArea } from "./ScrollArea";
import { CELL } from "./wallet/ledgerCells";
import type { Column } from "./wallet/ledgerColumns";
import { groupShareRows, shareBookingIds } from "./wallet/shareGroups";
import { ShareGroupRows } from "./wallet/ShareGroupRows";
import { useShareBookings } from "./wallet/useShareBookings";

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
  /**
   * D11 — gather a booking's `ShareTransfer` rows under one line, on the member's OWN wallet.
   * Off for the club's book and an admin's view of a member: the sentences say "your share".
   */
  groupShares?: boolean;
  /** F3.8: when given, every row opens its detail — a "Details" button per row, and the row. */
  onOpen?: (row: LedgerRow) => void;
};

type Sort = { key: Column; dir: SortDir };

function sortValue(row: LedgerRow, key: Column): string | number {
  switch (key) {
    case "time": return new Date(row.at).getTime();
    case "from": return row.from;
    case "to": return row.to;
    case "amount": return row.signedAmountCredits;
    case "comment": return row.comment ?? "";
    case "category": return ledgerCategory(row);
    case "actor": return ledgerDoneBy(row);
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
  const { rows, columns = DEFAULT_COLUMNS, emptyText = "No movements yet.", fill = false, label, groupShares = false } = props;
  const { onOpen } = props;
  const [sort, setSort] = useState<Sort>({ key: "time", dir: "desc" });
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const items = useMemo(() => (groupShares ? groupShareRows(sorted) : sorted.map((row) => ({ kind: "row" as const, row }))), [groupShares, sorted]);
  const bookings = useShareBookings(groupShares ? shareBookingIds(rows) : []);
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
            {onOpen ? <TableHead className="sticky top-0 z-sticky"><span className="sr-only">{LEDGER_COPY.detailsHeader}</span></TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (item.kind === "row"
            ? <LedgerLine key={item.row.id} row={item.row} columns={columns} onOpen={onOpen} />
            : <ShareGroupRows key={`shares-${item.bookingId}`} group={item} columns={columns} booking={bookings[item.bookingId]} />))}
        </TableBody>
      </table>
    </ScrollArea>
  );
}

function LedgerLine({ row, columns, onOpen }: { row: LedgerRow; columns: Column[]; onOpen?: (row: LedgerRow) => void }) {
  return (
    <TableRow
      // The whole row is a pointer target; the button in the last cell is the keyboard's and
      // the screen reader's way in, so the row itself needs no role or tab stop.
      data-interactive={onOpen ? "" : undefined}
      onClick={onOpen ? () => onOpen(row) : undefined}
      className={onOpen ? "cursor-pointer" : undefined}
    >
      {columns.map((column) => <Fragment key={column}>{CELL[column](row)}</Fragment>)}
      {onOpen ? (
        <TableCell className="w-0 align-top">
          <Button
            variant="ghost"
            size="sm"
            // Named by kind and time, not by amount: the amount is its own cell's name, and
            // repeating it here made "+160.00 cr" match two cells in the row.
            aria-label={LEDGER_COPY.openRow(`${ledgerCategory(row)}, ${clubDayAndClock(row.at)}`)}
            onClick={(e) => { e.stopPropagation(); onOpen(row); }}
            icon={<CaretRight aria-hidden="true" />}
          >
            <span className="sr-only sm:not-sr-only">{LEDGER_COPY.detailsHeader}</span>
          </Button>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

type HeaderLook = { label: string; align?: "left" | "right"; hideOnMobile?: boolean };

const HEADER: Record<Column, HeaderLook> = {
  time: { label: "Time", hideOnMobile: true },
  from: { label: "From", hideOnMobile: true },
  to: { label: "To", hideOnMobile: true },
  comment: { label: "Comment" },
  category: { label: LEDGER_COPY.categoryHeader, hideOnMobile: true },
  actor: { label: LEDGER_COPY.actorHeader, hideOnMobile: true },
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
