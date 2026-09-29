import type { LedgerRow } from "./api";
import { LEDGER_TYPE_LABEL } from "./creditAdjustment";

/**
 * The club ledger's "done by" and category — review round 1, F3.8.
 *
 * <p>
 * The Transactions page and a member's ledger said what moved and between whom, never who
 * moved it: a desk top-up and a member's own card top-up read the same. Round 1's contract
 * (§6) adds `actor_name` — the admin who made a desk movement or booked on behalf, null for the
 * member's own and the system's. Until a server sends it, the older `actorName` stands in, and
 * only where the actor is somebody other than the member.
 * </p>
 */
export type LedgerRowWithActor = LedgerRow & { actor_name?: string | null };

export const LEDGER_COPY = {
  actorHeader: "Done by",
  categoryHeader: "Category",
  detailsHeader: "Details",
  openRow: (what: string) => `Details — ${what}`,
  themselves: "The member",
  system: "The club's system",
  detailTitle: "Movement",
  when: "When",
  amount: "Amount",
  fromTo: "From → to",
  booking: "Booking",
  openBooking: "Open the booking",
  comment: "Comment",
  close: "Close",
} as const;

/** Who did it: the admin's name, "The member", or "The club's system". */
export function ledgerDoneBy(row: LedgerRowWithActor): string {
  if ("actor_name" in row) {
    if (row.actor_name) return row.actor_name;
    return row.actorUserId && row.actorUserId === row.subjectUserId ? LEDGER_COPY.themselves : LEDGER_COPY.system;
  }
  if (row.actorUserId && row.actorUserId === row.subjectUserId) return LEDGER_COPY.themselves;
  return row.actorName?.trim() || LEDGER_COPY.system;
}

/** What kind of movement it was, in the Transactions filter's own words. */
export function ledgerCategory(row: LedgerRow): string {
  return LEDGER_TYPE_LABEL[row.type] ?? row.type;
}
