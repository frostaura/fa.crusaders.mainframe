import { endpoints } from "@/lib/api";
import { playersEndpoints } from "@/lib/playersApi";
import { shareRowSentence } from "@/lib/walletCopy";
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
  amount: number, me: string | null, cause?: { shareCause?: string; shareKeptMinutes?: number; checkedInBy?: string },
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
  });
}
