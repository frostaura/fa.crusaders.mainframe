import type { PickedPlayer } from "@/components/players/PlayerPicker";
import { UnsureOutcome, outcomeUnknown, writeOrReadBack, type Landed } from "@/lib/lostReply";
import {
  playersEndpoints, type AddPlayersAnswer, type BookingDetail, type SeatAnswer, type SplitChange, type SplitChangeAnswer,
} from "@/lib/playersApi";

/**
 * R3 I-2 and the lost-reply audit — the booking page's writes, each read back off the booking
 * (or, for the member's own seat, off `GET /me/invites/{pid}`) when its reply is lost. The
 * reviewer removed a player behind a 504: the DELETE landed and refunded, the dialog said
 * "Couldn't remove that player" and the list still showed them as Paid.
 */

const detailOf = (bookingId: string) => playersEndpoints.detail(bookingId);

/** Remove: gone from the players, or marked removed. */
export function removeOrProve(bookingId: string, participantId: string): Promise<Landed<SeatAnswer>> {
  return writeOrReadBack(
    () => playersEndpoints.remove(bookingId, participantId),
    async () => {
      const seat = (await detailOf(bookingId)).players.find((p) => p.participant_id === participantId);
      return !seat || seat.status === "removed" ? { participant_id: participantId, status: "removed" } : null;
    },
  );
}

type Seat = BookingDetail["players"][number];

/**
 * One seat's write (the admin's remove, accept, settle, collect): read the booking back and
 * let `landed` judge the seat as it now stands (undefined when it is gone) against the seat
 * as it was. Returns what `landed` returns, as the write's answer.
 */
export function seatWriteOrProve<T>(
  bookingId: string,
  before: Seat,
  write: () => Promise<T>,
  landed: (was: Seat, now: Seat | undefined) => T | null,
): Promise<Landed<T>> {
  return writeOrReadBack(write, async () => {
    const now = (await detailOf(bookingId)).players.find((p) => p.participant_id === before.participant_id);
    return landed(before, now);
  });
}

/** Is `p` the seat this add would have made — a new seat for this member, guest or open link? */
function madeBy(pick: PickedPlayer | { kind: "member"; userId: string }, before: ReadonlySet<string>) {
  return (p: BookingDetail["players"][number]) => {
    if (!p.participant_id || before.has(p.participant_id) || p.status === "removed") return false;
    if (pick.kind === "member") return p.user_id === pick.userId;
    if (pick.kind === "guest") return p.kind === "guest" && p.name === pick.name;
    return p.kind === "open_link";
  };
}

/**
 * Add: a seat that was not there before, for the one picked. An open seat found this way has
 * no link to show — its token was in the lost reply — so the answer carries no `invite_path`
 * and the page offers to make one.
 */
export function addOrProve(detail: BookingDetail, pick: PickedPlayer | { kind: "member"; userId: string }, add: () => Promise<AddPlayersAnswer>): Promise<Landed<AddPlayersAnswer>> {
  const before = new Set(detail.players.map((p) => p.participant_id).filter((id): id is string => Boolean(id)));
  return writeOrReadBack(add, async () => {
    const now = await detailOf(detail.booking_id);
    const seat = now.players.find(madeBy(pick, before));
    if (!seat?.participant_id) return null;
    return {
      booking_id: detail.booking_id,
      participants: [{
        participant_id: seat.participant_id, seat: seat.seat, user_id: seat.user_id,
        guest_name: seat.kind === "guest" ? seat.name : null, status: seat.status, share_credits: seat.share_credits,
        invite_token: null, invite_path: null,
      }],
    };
  });
}

/** Change split: the booking's mode and every seat's share as the preview said they would be. */
export function splitOrProve(
  bookingId: string,
  body: SplitChange,
  expected: readonly { seat: number; share_credits: number }[],
  write: () => Promise<SplitChangeAnswer>,
): Promise<Landed<SplitChangeAnswer>> {
  return writeOrReadBack(write, async () => {
    const now = await detailOf(bookingId);
    if (now.split_mode !== body.mode) return null;
    const live = now.players.filter((p) => p.participant_id && p.status !== "removed");
    // The partners' seats: the organiser's own figure is what is left over, however it is shown.
    const matches = expected.filter((e) => e.seat !== 1).every((e) => live.find((p) => p.seat === e.seat)?.share_credits === e.share_credits);
    if (!matches) return null;
    return {
      booking_id: bookingId, split_mode: now.split_mode,
      shares: live.map((p) => ({
        participant_id: p.participant_id ?? "", seat: p.seat, share_credits: p.share_credits, weight: p.weight, needs_consent: p.needs_consent,
      })),
    };
  });
}

/**
 * The member's own seat, left (withdraw, decline): read off their seat, which they may read in
 * any state (review round 1, B4). Off the game (withdrawn, declined, removed) is landed.
 */
export function leaveOrProve(participantId: string, write: () => Promise<SeatAnswer>): Promise<Landed<SeatAnswer>> {
  return writeOrReadBack(write, async () => {
    const seat = await playersEndpoints.mySeat(participantId);
    return seat.status === "withdrawn" || seat.status === "declined" || seat.status === "removed"
      ? { participant_id: participantId, status: seat.status }
      : null;
  });
}

/**
 * A write with nothing to read back (a reminder, a new link): an unknown outcome is said as
 * unknown, never as "couldn't".
 */
export async function orNotKnown<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (outcomeUnknown(error)) throw new UnsureOutcome(error, false);
    throw error;
  }
}
