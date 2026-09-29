import { endpoints } from "@/lib/api";
import { playersEndpoints } from "@/lib/playersApi";
import { shareRowSentence } from "@/lib/walletCopy";
import { summariseBooking } from "@/components/wallet/useShareBookings";

/**
 * D4 — a share that moved while the member was not the one moving it, said with the names in it:
 * "Sam paid you 20.00 cr for their share of Court 1" on the organiser's side, "20.00 cr of your
 * share of Court 1 came back from Olivia" on a partner's.
 *
 * <p>
 * The stream's frame carries the amount and the reason and nothing about the booking, so the row
 * is found in the member's newest ledger entries (a `ShareTransfer` of exactly that amount) and
 * its booking read for the court and the people. Null when either read fails or nothing matches —
 * the caller then says the reason's plain sentence, which is true whoever caused it.
 * </p>
 */
export async function namedShareMovement(amount: number, me: string | null): Promise<string | null> {
  const wallet = await endpoints.wallet(5, 0);
  const row = wallet.entries.find((e) =>
    e.type === "ShareTransfer" && e.relatedBookingId && Math.abs(e.signedAmountCredits - amount) < 0.005);
  if (!row?.relatedBookingId) return null;
  const booking = summariseBooking(await playersEndpoints.detail(row.relatedBookingId));
  const side = booking.organiserId === me ? "organiser" : "partner";
  const other = side === "organiser"
    ? booking.partners.find((p) => p.userId === row.actorUserId)?.name ?? null
    : booking.organiserName;
  return shareRowSentence({ side, signed: row.signedAmountCredits, place: booking, other });
}
