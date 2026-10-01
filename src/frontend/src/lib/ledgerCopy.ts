import type { LedgerRow } from "./api";
import { ledgerTypeLabel } from "./creditAdjustment";

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
export type LedgerRowWithActor = LedgerRow & {
  actor_name?: string | null;
  /** C5 — on a share transfer, the other member of the pair. Null on every other row. */
  counterparty_name?: string | null;
  counterparty_user_id?: string | null;
};

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
  /** The footer's way out. Not "Close": the sheet's own × is named that, and two controls with
   *  one name are two guesses for a screen-reader user (A11Y F3-20). */
  close: "Done",
  /** R4 form factor: the movement beside the club's book, not over it. */
  panelLabel: "The movement",
  closePanel: "Close the movement",
  panelEmptyTitle: "Pick a movement",
  panelEmptyHint: "Its details open here — who made it, what it was for, and the booking it belongs to. ↑ and ↓ walk the rows.",
} as const;

/**
 * Who did it: the admin's name, the member's own name for their own movement, or "The club's
 * system". Review round 3, A-13: a member's own charge or share read "The member" beside a
 * twin row naming the person — on a club-wide list "the member" is nobody in particular.
 */
export function ledgerDoneBy(row: LedgerRowWithActor): string {
  // C5 (review round 2, F3-6): a share is moved by one of the two members. The organiser's row
  // said "The club's system" because its actor — the partner who paid — is not its owner.
  if (!row.actor_name && row.counterparty_name && row.actorUserId && row.actorUserId === row.counterparty_user_id) {
    return row.counterparty_name;
  }
  if ("actor_name" in row) {
    if (row.actor_name) return row.actor_name;
    return row.actorUserId && row.actorUserId === row.subjectUserId ? ownName(row) : LEDGER_COPY.system;
  }
  if (row.actorUserId && row.actorUserId === row.subjectUserId) return ownName(row);
  return row.actorName?.trim() || LEDGER_COPY.system;
}

function ownName(row: LedgerRowWithActor): string {
  return row.subjectName?.trim() || LEDGER_COPY.themselves;
}

/** What kind of movement it was, in the Transactions filter's own words. */
export function ledgerCategory(row: LedgerRow): string {
  return ledgerTypeLabel(row.type);
}
