import type { LedgerRow } from "@/lib/api";

/**
 * D11 — a member's `ShareTransfer` rows, gathered under one line per booking.
 *
 * <p>
 * <b>Why group at all.</b> A four-player split posts one row per partner payment on the
 * organiser's wallet (and a return is another row, and a raised share another), so a busy
 * organiser's ledger fills with "Share of a split booking" lines that only mean something
 * together: what the court ended up costing them. One line per booking says that — "+50.00 cr
 * from 2 partners" — and the rows it is made of are one tap away.
 * </p>
 *
 * <p>
 * <b>Pure, and within the page it is given.</b> Rows of one booking that are NOT next to each
 * other still gather (a partner paying on Monday and another on Wednesday, with a top-up
 * between); a booking whose shares straddle two pages of the ledger groups on each page
 * separately, because a line that reached into rows the member cannot see would be a sum
 * they cannot check. Every other row passes through untouched and in order; a group sits where
 * its first row sat.
 * </p>
 */

export type LedgerItem =
  | { kind: "row"; row: LedgerRow }
  | { kind: "shares"; bookingId: string; rows: LedgerRow[]; net: number };

/** True for a row that belongs under a booking's share line. */
export function isGroupableShare(row: LedgerRow): row is LedgerRow & { relatedBookingId: string } {
  return row.type === "ShareTransfer" && typeof row.relatedBookingId === "string" && row.relatedBookingId.length > 0;
}

/** Credits are two-place figures; summing floats must not print 49.999999. */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100;
}

export function groupShareRows(rows: readonly LedgerRow[]): LedgerItem[] {
  const items: LedgerItem[] = [];
  const groups = new Map<string, Extract<LedgerItem, { kind: "shares" }>>();
  for (const row of rows) {
    if (!isGroupableShare(row)) {
      items.push({ kind: "row", row });
      continue;
    }
    const existing = groups.get(row.relatedBookingId);
    if (existing) {
      existing.rows.push(row);
      existing.net = roundCredits(existing.net + row.signedAmountCredits);
      continue;
    }
    const group = { kind: "shares" as const, bookingId: row.relatedBookingId, rows: [row], net: roundCredits(row.signedAmountCredits) };
    groups.set(row.relatedBookingId, group);
    items.push(group);
  }
  return items;
}

/** Which side of the split this member was on, read off the rows' signs. */
export type ShareSide = "organiser" | "partner";

/**
 * The organiser RECEIVES shares (credit rows); a partner PAYS one (debit rows). A group that
 * has netted to zero — paid then returned in full — is read off its first row's sign, which is
 * the direction the money first went.
 */
export function shareSide(group: { rows: readonly LedgerRow[]; net: number }): ShareSide {
  if (group.net !== 0) return group.net > 0 ? "organiser" : "partner";
  const first = group.rows[group.rows.length - 1] ?? group.rows[0];
  return (first?.signedAmountCredits ?? 0) >= 0 ? "organiser" : "partner";
}

/** The distinct booking ids a page's share rows name, in first-seen order. */
export function shareBookingIds(rows: readonly LedgerRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) if (isGroupableShare(row)) seen.add(row.relatedBookingId);
  return [...seen];
}
