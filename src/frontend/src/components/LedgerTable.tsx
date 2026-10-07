import { Fragment, cloneElement, isValidElement, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { LedgerRow } from "../lib/api";
import { cn } from "../lib/utils";
import { clubDayAndClock } from "../lib/clubClock";
import { ledgerCategory, ledgerDoneBy, LEDGER_COPY } from "../lib/ledgerCopy";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Button } from "./ui/button";
import { CaretDown, CaretRight, CaretUp, CaretUpDown } from "./ui/icons";
import { ScrollArea } from "./ScrollArea";
import { CELL } from "./wallet/ledgerCells";
import { EARLY, HEAD_SHOW, PIN_AMOUNT, PIN_BESIDE_DETAILS, PIN_CELL, PIN_HEAD, PIN_RIGHT_EDGE, type Column } from "./wallet/ledgerColumns";
import { groupShareRows } from "./wallet/shareGroups";
import { ShareGroupRows } from "./wallet/ShareGroupRows";
import type { ShareBookings } from "./wallet/useShareBookings";
import { TABLE_KEEP_WHOLE } from "@/components/ui/table-keep-whole";

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
  /** With `groupShares`: each booking's summary, from the same wallet read as the rows (`share_bookings`). */
  shareBookings?: ShareBookings;
  /** F3.8: when given, every row opens its detail — a "Details" button per row, and the row. */
  onOpen?: (row: LedgerRow) => void;
  /**
   * The row whose detail stands beside the table (R4 form factor): marked `aria-current`, and
   * ↑/↓ from inside the table open the row above or below it, so an admin walks the book.
   */
  selectedId?: string | null;
  /**
   * Columns folded out of the full form until the TABLE'S box is 84rem (review round 2, F3-9; R4
   * form factor; R5 F5-1). The club's book has seven columns and a Details button; beside the admin
   * rail and the movement panel the Amount went off the right edge. The comment is the column
   * that can go — every row's Details sheet carries it whole. In the compact form it stays: there
   * it is the movement + time.
   */
  wideOnly?: Column[];
};

/**
 * Fold a cell out of the full form until the table's own box (`@container/ledger`) is 84rem —
 * appended after its own classes, and `!` on the way back, so a cell's own fold cannot win either way.
 *
 * <p>
 * <b>Never `hidden` in the compact form</b> (R4 form factor, SPEC §4.1, MED): it was `hidden` +
 * `sm:hidden 2xl:table-cell`, which hid the comment on a PHONE too — where the comment cell is
 * the movement with its time under it, the one cell meant to stay. And a box, not the viewport.
 * </p>
 *
 * <p>
 * <b>84rem, measured</b> (R5 F5-1): with the comment drawn, the club's seven columns and Details
 * need about 80rem; at 64rem they were drawn into a 70rem box (1440 with the movement panel open)
 * and the Amount went past the edge.
 * </p>
 */
const WIDE_ONLY = "@[36rem]/ledger:hidden @[84rem]/ledger:!table-cell";

/**
 * Named rather than written inline as `isValidElement<{ className?: string }>`: lizard reads an
 * object-literal type argument as the start of a body and swallows the rest of the file into
 * this function (it scored CCN 45 over 182 lines).
 */
type ClassNamed = { className?: string };

/**
 * On a phone the comment cell is the row's left half — the movement with its time under it —
 * so it takes the width the amount does not need (`w-full` below `sm`). Left to the table's own
 * sharing it measured 110px beside a 186px amount at 390, "Share of a / split booking" over
 * three lines beside empty space (R4 form factor).
 */
const PHONE_LEAD = "w-full @[36rem]/ledger:w-auto";
/**
 * The counterparty under a phone's amount may wrap: the cell is `nowrap` for the figure, and the
 * longest name in a 1,700-row book set the whole column's width (186px of a 356px row).
 */
const PHONE_MONEY = "[&>span]:whitespace-normal [&>span]:break-words";

/** The Amount's pin while the table scrolls sideways: beside a pinned Details column, or at the edge. */
function amountPin(details: boolean): string {
  return cn(PIN_AMOUNT, details ? PIN_BESIDE_DETAILS : PIN_RIGHT_EDGE);
}

/** How a table lays its cells out: Details drawn after the Amount; the comment folded out (EARLY). */
type Fold = { details: boolean; early: boolean };

function narrowed(cell: ReactNode, column: Column, wide: boolean, fold: Fold): ReactNode {
  if (!isValidElement<ClassNamed>(cell)) return cell;
  const lead = column === "comment" ? PHONE_LEAD : column === "amount" ? cn(PHONE_MONEY, amountPin(fold.details), PIN_CELL) : null;
  const early = fold.early ? EARLY[column] : undefined;
  if (!wide && !lead && !early) return cell;
  return cloneElement(cell, { className: cn(cell.props.className, lead, early, wide && WIDE_ONLY) });
}

/**
 * The Details column: exactly one 44px button wide, with no padding, so the Amount can be pinned
 * `right-touch` beside it — and pinned itself at the right edge while the table scrolls.
 */
const DETAILS_CELL = "w-touch px-0 [[data-scrolls]_&]:sticky [[data-scrolls]_&]:right-0";

/**
 * A row's controls scroll clear of the sticky column heads (R5 X5-2, WCAG 2.4.11): the heads are
 * 2.75rem tall and stick under the page's top bar, whose own height the shell's scroll-padding
 * covers. Without it, Tab and ↑/↓ brought a row to rest under the heads.
 */
const CLEAR_HEADS = "scroll-mt-14";

/**
 * The column heads stick to the PAGE's scroller (R5 V5-6), under its top bar (whose height the
 * bar publishes); inside a sideways scroller they stick at its own top, which is its edge.
 */
const HEAD_TOP = { top: "var(--context-bar-top-height, 0px)" } as const;
const STICKY_HEAD = "sticky z-sticky [[data-scrolls]_&]:!top-0";

type Sort = { key: Column; dir: SortDir };

function sortValue(row: LedgerRow, key: Column): string | number {
  switch (key) {
    case "time": return new Date(row.at).getTime();
    case "from": return row.from;
    case "to": return row.to;
    case "amount": return row.signedAmountMinutes;
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

const NO_BOOKINGS: ShareBookings = {};

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
 * <b>Minutes read by sign, twice.</b> Minutes in wear the success ink with a "+", minutes out the
 * primary ink with a real U+2212 minus — never the warning ink: spending your own minutes on a
 * court is the product working, not something to look at. The sign is the non-colour cue.
 * </p>
 */
/**
 * R13 J13-3 — the club SAID this member can no longer read the booking (its summary is null, not
 * absent): taken off it, pulled out, declined. Absent means not summarised, which proves nothing.
 */
function isGone(bookings: ShareBookings, bookingId: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(bookings, bookingId)) return false;
  // R14 E14-7 — or it is known only by its place (`share_places`): still gone, now named.
  return bookings[bookingId] === null || bookings[bookingId]?.gone === true;
}

export function LedgerTable(props: LedgerTableProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { rows, columns = DEFAULT_COLUMNS, emptyText = "No movements yet.", fill = false, label, groupShares = false } = props;
  const { onOpen, wideOnly = [], selectedId = null } = props;
  const [sort, setSort] = useState<Sort>({ key: "time", dir: "desc" });
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const items = useMemo(() => (groupShares ? groupShareRows(sorted) : sorted.map((row) => ({ kind: "row" as const, row }))), [groupShares, sorted]);
  const bookings = props.shareBookings ?? NO_BOOKINGS;
  const fold: Fold = { details: Boolean(onOpen), early: wideOnly.includes("comment") };
  const headerFor = (column: Column) => (
    <SortHeader {...HEADER[column]} wideOnly={wideOnly.includes(column)} fold={fold} k={column} sort={sort} onSort={(k) => setSort((s) => nextSort(s, k))} />
  );

  if (rows.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-text-secondary sm:px-6">{emptyText}</p>;
  }

  return (
    // ScrollArea, not a bare overflow-auto div: the ledger is wider than a phone, and a
    // container that silently cuts off the Amount column reads as a missing column rather
    // than as one swipe away. It also makes the region keyboard-reachable.
    // The box the wide-only columns ask about (`@container/ledger`).
    <div
      data-ledger-box=""
      className={cn("@container/ledger min-w-0", fill && "flex min-h-0 flex-1 flex-col")}
      onKeyDown={onOpen && selectedId ? (event) => walkRows(event, items, selectedId, onOpen) : undefined}
    >
      {/* A scroller only while the table is wider than its box (R5 V5-6): otherwise the heads
          stick to the page. `fill` keeps its own scroller, which is what its heads stick to. */}
      <ScrollArea label={label} onlyWhenWider={!fill} className={cn(fill && "min-h-0 flex-1")}>
        {/* Named as well as its scroller (A11Y F3.22): a table reached by a screen reader's table
            navigation announces its own name, not the region's. */}
        <table data-slot="table" aria-label={label} className={cn("w-full border-collapse text-sm [&_td]:align-middle", TABLE_KEEP_WHOLE)}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => <Fragment key={column}>{headerFor(column)}</Fragment>)}
              {onOpen ? <TableHead style={HEAD_TOP} className={cn(STICKY_HEAD, DETAILS_CELL, PIN_HEAD)}><span className="sr-only">{LEDGER_COPY.detailsHeader}</span></TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (item.kind === "row"
              ? <LedgerLine key={item.row.id} row={item.row} columns={columns} onOpen={onOpen} wideOnly={wideOnly} fold={fold} selected={item.row.id === selectedId} />
              : <ShareGroupRows key={`shares-${item.bookingId}`} group={item} columns={columns} booking={bookings[item.bookingId] ?? null} gone={isGone(bookings, item.bookingId)} />))}
          </TableBody>
        </table>
      </ScrollArea>
    </div>
  );
}

/**
 * ↑/↓ while a row's detail is open beside the table: open the next row in the order the table
 * shows (its sort), and move focus to that row's Details button so the keys keep walking.
 */
function walkRows(event: KeyboardEvent<HTMLElement>, items: ReadonlyArray<{ kind: string; row?: LedgerRow }>, selectedId: string, onOpen: (row: LedgerRow) => void) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if ((event.target as HTMLElement).closest("input, textarea, select, [role=combobox]")) return;
  const rows = items.flatMap((item) => (item.kind === "row" && item.row ? [item.row] : []));
  const at = rows.findIndex((row) => row.id === selectedId);
  if (at < 0) return;
  const next = rows[event.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)];
  event.preventDefault();
  onOpen(next);
  const box = event.currentTarget;
  requestAnimationFrame(() => {
    const button = box.querySelector<HTMLElement>(`[data-ledger-row="${CSS.escape(next.id)}"] button`);
    button?.focus();
    button?.scrollIntoView?.({ block: "nearest" });
  });
}

function LedgerLine(props: {
  row: LedgerRow; columns: Column[]; onOpen?: (row: LedgerRow) => void; wideOnly: Column[]; fold: Fold; selected?: boolean;
}) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { row, columns, onOpen, wideOnly, fold, selected = false } = props;
  return (
    <TableRow
      data-ledger-row={row.id}
      aria-current={selected || undefined}
      // The whole row is a pointer target; the button in the last cell is the keyboard's and
      // the screen reader's way in, so the row itself needs no role or tab stop.
      data-interactive={onOpen ? "" : undefined}
      onClick={onOpen ? () => onOpen(row) : undefined}
      className={cn(onOpen && "cursor-pointer", selected && "bg-accent-soft hover:bg-accent-soft")}
    >
      {columns.map((column) => <Fragment key={column}>{narrowed(CELL[column](row), column, wideOnly.includes(column), fold)}</Fragment>)}
      {onOpen ? (
        <TableCell className={cn(DETAILS_CELL, PIN_CELL)}>
          <Button
            variant="ghost"
            size="sm"
            // 44 × 44 at the least (A11Y F3-19: it measured 42 × 36 at 390), and an icon only: the
            // word cost 73px the row did not have beside the admin rail even at 1920 (F3-9,
            // measured) — the button's name is its aria-label either way.
            className={cn("min-h-touch min-w-touch", CLEAR_HEADS)}
            // Named by kind and time, not by amount: the amount is its own cell's name, and
            // repeating it here made "+2 h 40 min" match two cells in the row.
            aria-label={LEDGER_COPY.openRow(`${ledgerCategory(row)}, ${clubDayAndClock(row.at)}`)}
            onClick={(e) => { e.stopPropagation(); onOpen(row); }}
            icon={<CaretRight aria-hidden="true" />}
          >
            <span className="sr-only">{LEDGER_COPY.detailsHeader}</span>
          </Button>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

type HeaderLook = { label: string; align?: "left" | "right" };

const HEADER: Record<Column, HeaderLook> = {
  time: { label: "Time" },
  from: { label: "From" },
  to: { label: "To" },
  comment: { label: "Comment" },
  category: { label: LEDGER_COPY.categoryHeader },
  actor: { label: LEDGER_COPY.actorHeader },
  amount: { label: "Amount", align: "right" },
};

type HeaderProps = {
  label: string;
  wideOnly?: boolean;
  /** How the table folds: a Details column after the Amount (its pin sits beside it); the earlier folds. */
  fold: Fold;
  k: Column;
  sort: Sort;
  onSort: (k: Column) => void;
  align?: "left" | "right";
};

/**
 * A sortable column head: the whole label is the button, `aria-sort` on the header says which
 * way the column runs (so it is not only the caret that says so), and the head is sticky
 * against the page (or the ScrollArea, while it scrolls sideways).
 */
function SortHeader(props: HeaderProps) {
  const { label, k, sort, onSort, align = "left", wideOnly = false, fold } = props;
  const active = sort.key === k;
  const Icon = !active ? CaretUpDown : sort.dir === "asc" ? CaretUp : CaretDown;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      style={HEAD_TOP}
      className={cn(
        STICKY_HEAD,
        align === "right" ? "text-right" : "text-left",
        HEAD_SHOW[k],
        fold.early && k !== "amount" && EARLY[k],
        k === "amount" && cn(amountPin(fold.details), PIN_HEAD),
        wideOnly && WIDE_ONLY,
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
