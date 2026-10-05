import { endpoints } from "@/lib/api";
import { playersEndpoints } from "@/lib/playersApi";
import { shareMovementPlain, shareRowSentence } from "@/lib/shareMovementCopy";
import type { BalanceDelta } from "@/lib/liveBalance";
import { summariseBooking } from "@/components/wallet/useShareBookings";

/**
 * D4 — a share that moved while the member was not the one moving it, said with the names in it:
 * "Sam paid you 20 min for their share of Court 1" on the organiser's side, "20 min of your
 * share of Court 1 came back from Olivia" on a partner's.
 *
 * <p>
 * The stream's frame carries the amount and the reason and nothing about the booking, so the row
 * is found in the member's newest ledger entries (a `ShareTransfer` of exactly that amount) and
 * its booking read for the court and the people. Null when either read fails or nothing matches —
 * the caller then says the reason's plain sentence, which is true whoever caused it.
 * </p>
 */
export async function namedShareMovement(
  amount: number, me: string | null,
  cause?: { shareCause?: string; shareKeptMinutes?: number; checkedInBy?: string; cancelledBy?: "club" | "member"; actorName?: string },
): Promise<string | null> {
  const wallet = await endpoints.wallet(5, 0);
  const row = wallet.entries.find((e) =>
    e.type === "ShareTransfer" && e.relatedBookingId && e.signedAmountMinutes === amount);
  if (!row?.relatedBookingId) return null;
  const booking = summariseBooking(await playersEndpoints.detail(row.relatedBookingId));
  const side = booking.organiserId === me ? "organiser" : "partner";
  // R12 X12-3 — a partner who withdrew is no longer on the booking: the ledger row still names
  // them (the side the minutes went to, or came from), so the toast keeps their name.
  const fromRow = row.signedAmountMinutes < 0 ? row.to : row.from;
  const other = side === "organiser"
    ? booking.partners.find((p) => p.userId === row.actorUserId)?.name ?? (fromRow?.trim() || null)
    : booking.organiserName;
  // R11 E11-1 — the frame's cause, said as the inbox says it.
  return shareRowSentence({
    side, signed: row.signedAmountMinutes, place: booking, other, cause: cause?.shareCause, kept: cause?.shareKeptMinutes, by: cause?.checkedInBy,
    // R13 X13-3 — a partner told the club cancelled, when it did. R14 — and who acted, by name.
    cancelledBy: cause?.cancelledBy, actor: cause?.actorName,
  });
}

/**
 * The chip's share toast, named where the ledger and the booking can be read, else the frame's own
 * plain sentence (R11 E11-1, R13 J13-4, R14 X14-2). Loaded by the chip on the first share frame, so
 * these words stay out of the entry chunk (R14 entry budget).
 */
export async function shareToast(delta: BalanceDelta, me: string | null): Promise<string> {
  // R14 X14-2 — who acted (`actor_name`) and the other member on the share row.
  const shares = (delta.parts ?? []).filter((p) => p.reason === "share_transfer");
  const other = shares[0]?.counterparty_name ?? null;
  const plain = shareMovementPlain(delta.amount, delta.shareCause, delta.shareKeptMinutes, delta.checkedInBy, {
    cancelledBy: delta.cancelledBy, place: delta.place, actor: delta.actorName, other, others: shares.map((p) => p.counterparty_name),
  });
  try {
    return (await namedShareMovement(delta.amount, me, delta)) ?? plain;
  } catch {
    return plain;
  }
}

