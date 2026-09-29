import type {
  AddPlayersAnswer, BookWithPlayersAnswer, BulkWithPlayersAnswer,
} from "@/lib/playersApi";
import type { SelectedSlot } from "./types";

/**
 * What a booking made WITH players came back with, per booking: the open seats' invite links
 * (shown ONCE — the server keeps only their hash), and `players_error` when the court was booked
 * but the players could not be added in the gap. The result view draws one block per booking.
 */

export type ShareableLink = { seat: number; invitePath: string };

export type BookingPlayers = {
  bookingId: string;
  /** The slot this booking is, when it can be matched — for naming it in a batch. */
  slot: SelectedSlot | null;
  links: ShareableLink[];
  error: string | null;
};

export type PlayersOutcome = { bookings: BookingPlayers[] };

/** Open link seats only: no member, no guest, and a path to share. */
function linksOf(answer: AddPlayersAnswer | null | undefined): ShareableLink[] {
  return (answer?.participants ?? [])
    .filter((p) => p.user_id === null && p.guest_name === null && typeof p.invite_path === "string" && p.invite_path !== "")
    .map((p) => ({ seat: p.seat, invitePath: p.invite_path as string }))
    .sort((a, b) => a.seat - b.seat);
}

export function fromSingleWithPlayers(answer: BookWithPlayersAnswer, slot: SelectedSlot): PlayersOutcome {
  return {
    bookings: [{
      bookingId: answer.booking_id,
      slot,
      links: linksOf(answer.players),
      error: answer.players_error ?? null,
    }],
  };
}

export function fromBulkWithPlayers(answer: BulkWithPlayersAnswer, sent: readonly SelectedSlot[]): PlayersOutcome {
  const slotOf = (bookingId: string) => {
    const row = (answer.results ?? []).find((r) => r.booking_id === bookingId);
    return row ? sent[row.index] ?? null : null;
  };
  return {
    bookings: (answer.players ?? []).map((p) => ({
      bookingId: p.booking_id,
      slot: slotOf(p.booking_id),
      links: linksOf(p.players),
      error: p.players_error ?? null,
    })),
  };
}

/** The full link a partner opens: this app's origin plus the server's path (`/j/{token}`). */
export function inviteUrl(invitePath: string, origin: string = window.location.origin): string {
  return `${origin}${invitePath}`;
}
