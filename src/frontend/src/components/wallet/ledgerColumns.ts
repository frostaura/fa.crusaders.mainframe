/**
 * The ledger's columns and the classes each cell wears — the phone fold lives here, once, for
 * the plain rows of `LedgerTable` and the share lines of `ShareGroupRows` alike.
 */

export type Column = "time" | "from" | "to" | "amount" | "comment" | "category" | "actor";

/** Each column's cell classes — the phone fold lives here, once. */
export const CELL_CLASS = {
  time: "hidden whitespace-nowrap align-top text-xs tabular-nums text-text-secondary sm:table-cell",
  from: "hidden max-w-44 truncate align-top sm:table-cell",
  to: "hidden align-top sm:table-cell",
  comment: "break-words align-top text-sm text-text-primary sm:max-w-xs sm:truncate sm:text-text-secondary",
  amount: "whitespace-nowrap text-right align-top font-semibold tabular-nums",
  // F3.8 — admin ledgers only: what kind of movement, and who made it.
  category: "hidden align-top text-text-secondary sm:table-cell",
  actor: "hidden max-w-40 truncate align-top text-text-secondary sm:table-cell",
} as const;

/** Credit in is the success ink; credit out the primary ink, never the warning one. */
export function amountInk(signed: number): string {
  return signed >= 0 ? "text-success-strong" : "text-text-primary";
}
