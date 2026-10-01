/**
 * The ledger's columns and the classes each cell wears — the phone fold lives here, once, for
 * the plain rows of `LedgerTable` and the share lines of `ShareGroupRows` alike.
 */

export type Column = "time" | "from" | "to" | "amount" | "comment" | "category" | "actor";

/**
 * Each column's cell classes — the fold lives here, once.
 *
 * <p>
 * <b>By the table's own box, never the viewport</b> (R5 F5-1/V5-1, HIGH). Every fold is a
 * container query on `@container/ledger` (LedgerTable's wrapper), in rem: `sm:` (640 CSS px of
 * VIEWPORT) drew all seven columns into a 70rem box beside the admin rail and an open movement
 * panel, and the Amount went off the right edge at 1440 and 1920. The columns arrive in the order
 * a reader needs them as the box widens — the movement and its amount always; then its time;
 * then its kind; then who it was between; then who made it — and rem means 200 % text keeps the
 * compact two-column form for longer, which is what large text needs.
 * </p>
 *
 * <ul>
 *   <li>below 16rem — ONE column (a phone at 200 % text): the amount rides in the movement's own cell,
 *   under its words, so the row never needs a sideways scroll to show its money ({@link STACKED_ONLY});</li>
 *   <li>below 36rem — two columns: the movement (time under it) and the amount (counterparty under it);</li>
 *   <li>36rem — Time; 44rem — Category; 60rem — From and To; 68rem — Done by;</li>
 *   <li>a book that folds its comment out (the club's, `wideOnly`) has that 20rem for the others:
 *   From and To at 52rem, Done by at 60rem ({@link EARLY}).</li>
 * </ul>
 *
 * <p>
 * Measured (R5, Chromium, the club's longest names): a member's wallet with Time, From, To and
 * the comment needs 57.8rem; the club's book with every column but the comment 57.6rem, and
 * without Done by about 46rem.
 * </p>
 */
export const CELL_CLASS = {
  time: "hidden whitespace-nowrap align-top text-xs tabular-nums text-text-secondary @[36rem]/ledger:table-cell",
  from: "hidden max-w-44 truncate align-top @[60rem]/ledger:table-cell",
  to: "hidden align-top @[60rem]/ledger:table-cell",
  comment: "break-words align-top text-sm text-text-primary @[36rem]/ledger:max-w-xs @[36rem]/ledger:truncate @[36rem]/ledger:text-text-secondary",
  amount: "hidden whitespace-nowrap text-right align-top font-semibold tabular-nums @[16rem]/ledger:table-cell",
  // F3.8 — admin ledgers only: what kind of movement, and who made it.
  category: "hidden align-top text-text-secondary @[44rem]/ledger:table-cell",
  actor: "hidden max-w-40 truncate align-top text-text-secondary @[68rem]/ledger:table-cell",
} as const;

/** The same folds for the column heads (`hidden` until the box has room; written whole for the scanner). */
export const HEAD_SHOW: Record<Column, string> = {
  time: "hidden @[36rem]/ledger:table-cell",
  from: "hidden @[60rem]/ledger:table-cell",
  to: "hidden @[60rem]/ledger:table-cell",
  comment: "",
  amount: "hidden @[16rem]/ledger:table-cell",
  category: "hidden @[44rem]/ledger:table-cell",
  actor: "hidden @[68rem]/ledger:table-cell",
};

/**
 * What only the compact (two-column) form shows: the time under the movement and the movement
 * count under a share line's amount — gone once the Time column is drawn.
 */
export const COMPACT_ONLY = "@[36rem]/ledger:hidden";

/**
 * What only the one-column form shows: the amount (and its counterparty) inside the movement's
 * cell. Measured (R5): the two-column form needs 14.3–15.9rem — at 390 with 200 % text the box is
 * 10.1rem, and a pinned Amount column sat over half the words.
 */
export const STACKED_ONLY = "@[16rem]/ledger:hidden";

/** The counterparty under the amount: shown until the From and To columns are drawn. */
export const UNTIL_PARTIES = "@[60rem]/ledger:hidden";

/** The earlier folds of a book without its comment column: appended to the cell and its head. */
export const EARLY: Partial<Record<Column, string>> = {
  from: "@[52rem]/ledger:table-cell",
  to: "@[52rem]/ledger:table-cell",
  actor: "@[60rem]/ledger:table-cell",
  // The counterparty under the amount goes with the earlier From and To.
  amount: "@[52rem]/ledger:[&>span]:hidden",
};

/**
 * The Amount, PINNED to the right edge while the table scrolls sideways (R5 F5-1, HIGH) — the
 * one figure a ledger exists for is never what a sideways scroll hides. Only while the region
 * scrolls (`data-scrolls`, set by ScrollArea `onlyWhenWider`): a table that fits pins nothing.
 * `right-touch` when a Details column (44px, no padding) is pinned beside it.
 */
export const PIN_AMOUNT = "[[data-scrolls]_&]:sticky [[data-scrolls]_&]:border-l [[data-scrolls]_&]:border-border";
/** A pinned BODY cell: over the cells scrolling under it, painted like its row (the picked one too). */
export const PIN_CELL = "[[data-scrolls]_&]:z-raised [[data-scrolls]_&]:bg-bg-surface [[data-scrolls]_[aria-current=true]>&]:bg-accent-soft";
/** A pinned HEAD: above the heads and the pinned cells alike. */
export const PIN_HEAD = "[[data-scrolls]_&]:z-sticky-corner [[data-scrolls]_&]:bg-bg-muted";
export const PIN_RIGHT_EDGE = "[[data-scrolls]_&]:right-0";
export const PIN_BESIDE_DETAILS = "[[data-scrolls]_&]:right-touch";

/** Credit in is the success ink; credit out the primary ink, never the warning one. */
export function amountInk(signed: number): string {
  return signed >= 0 ? "text-success-strong" : "text-text-primary";
}
