import type { LedgerRow } from "./api";
import { ledgerTypeLabel } from "./deskLedger";
import { formatMoney } from "./utils";

/**
 * The club ledger's "done by" and category — review round 1, F3.8.
 *
 * <p>
 * The Transactions page and a member's ledger said what moved and between whom, never who
 * moved it: a package sold at the desk and a member's own card purchase read the same. Round 1's contract
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
  /**
   * R9 J9-3: the rand the club took for this row, where the server sends it (a desk package's
   * `ZarPaid`). 0 on a package given at no charge. Absent from older servers.
   */
  zar_paid?: number | null;
  /** R9 J9-3: the desk's code on a by-hand row (`package_free`, `top_up_cash`, `goodwill`, …); null otherwise. */
  reason_code?: string | null;
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
  /**
   * R9 J9-7: under the totals while shares can be among the rows. A share is two legs — out of the
   * partner's wallet, into the organiser's — and both are movements, so Minutes in and Minutes out
   * each carry it while the net does not move (Reports shows shares as the net zero they are).
   */
  sharesNote: "Minutes in and out each count a share between members once — out of one wallet, into another — so shares add nothing to the net.",
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

/**
 * What kind of movement it was, in the Transactions filter's own words — with the two facts the
 * label alone hid (review round 9). A share's two legs read alike ("Uma → Piet", +15 and −15), so
 * each says whose wallet it moved (J9-7); a desk package given at no charge is not "sold" (J9-3).
 * The Category column is drawn on admin ledgers only.
 */
export function ledgerCategory(row: LedgerRow): string {
  const label = ledgerTypeLabel(row.type);
  const owner = row.subjectName?.trim();
  if (row.type === "ShareTransfer" && owner) {
    return `${label}, ${row.signedAmountMinutes < 0 ? "out of" : "into"} ${owner}'s wallet`;
  }
  if (row.type === "AdminTopUp") return deskCategory(row as LedgerRowWithActor, label);
  if (row.type === "CancellationRefund") return refundCategory(row, label);
  return label;
}

/** R9 J9-3: an `AdminTopUp` for which the club took no rand (`package_free`, or a R0 sale). */
const DESK_GIFT = "Package given at the desk, at no charge";

/**
 * R10 J10-5: a desk sale says the rand the club took (`zar_paid`) — the book had it nowhere, so a
 * sale at a regular's round R100 and one at the shelf's R96 read alike. An older server sends none.
 */
function deskCategory(row: LedgerRowWithActor, label: string): string {
  if (row.reason_code === "package_free" || row.zar_paid === 0) return DESK_GIFT;
  return typeof row.zar_paid === "number" ? `${label}, ${formatMoney(row.zar_paid)} received` : label;
}

/**
 * R10 E10-5: one ledger type carries every refund the club makes — a cancellation's, an outage's,
 * a no-show's, a pay-for's — and the reversals of them (negative). Transactions called them all
 * "Cancellation refund", so an outage reversal of −15 read as a refund. The row's stored reason
 * (the server's own words) and its sign say which it was.
 */
export const LEDGER_CATEGORY = {
  outageRefund: "Outage refund — the court's box was offline",
  outageRefundReversed: "Outage refund reversed — checked in after all",
  payForRefund: "Pay-for refund — another member paid at the court",
  noShowRefund: "No-show refund",
  noShowRefundReversed: "No-show refund reversed — attendance arrived late",
  displacedRefund: "Refund — the court was already in use",
  reinstated: "Refund taken back — booking reinstated",
  refundReversed: "Refund reversed",
} as const;

/**
 * The server's stored reasons, by what they begin with or say: `NoShowWorker.RefundReason`,
 * `BookingService.RefundReversalReason`, the pay-for reassignment's refund, the displaced tail's
 * refund and its reinstatement. First match wins; the sign is checked by the caller.
 */
const REFUND_REASONS: ReadonlyArray<{ test: RegExp; positive: string; negative: string }> = [
  { test: /^Outage refund reversed/, positive: LEDGER_CATEGORY.outageRefund, negative: LEDGER_CATEGORY.outageRefundReversed },
  { test: /was offline — booking refunded/, positive: LEDGER_CATEGORY.outageRefund, negative: LEDGER_CATEGORY.outageRefundReversed },
  { test: /^Payer changed at court/, positive: LEDGER_CATEGORY.payForRefund, negative: LEDGER_CATEGORY.refundReversed },
  { test: /^No-show refund reversed/, positive: LEDGER_CATEGORY.noShowRefund, negative: LEDGER_CATEGORY.noShowRefundReversed },
  { test: /^No-show — booking refunded/, positive: LEDGER_CATEGORY.noShowRefund, negative: LEDGER_CATEGORY.noShowRefundReversed },
  { test: /^Booking reinstated/, positive: LEDGER_CATEGORY.displacedRefund, negative: LEDGER_CATEGORY.reinstated },
  { test: /the court was already in use/, positive: LEDGER_CATEGORY.displacedRefund, negative: LEDGER_CATEGORY.reinstated },
];

function refundCategory(row: LedgerRow, label: string): string {
  const back = row.signedAmountMinutes < 0;
  const known = REFUND_REASONS.find((r) => r.test.test(row.comment?.trim() ?? ""));
  if (known) return back ? known.negative : known.positive;
  return back ? LEDGER_CATEGORY.refundReversed : label;
}
