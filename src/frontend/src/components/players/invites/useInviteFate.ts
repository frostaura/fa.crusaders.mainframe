import { useEffect, useState } from "react";
import { playersEndpoints, type MySeat } from "@/lib/playersApi";

/**
 * R1 F2.7 / F2.8 — what became of an invite the mail's link names, once it is no longer on the
 * member's open list: they said yes (and paid), the game was cancelled, or they are off it.
 *
 * <p>
 * <b>Asked, not inferred.</b> `GET /me/invites/{participantId}` (review round 1, B4) answers the
 * caller's OWN seat in any state with the booking's status: cancelled says so; accepted is
 * "you're in"; declined, withdrawn, removed, lapsed — or a seat still marked invited whose window
 * has closed — is "no longer on this game". The route answers only the seat's own member, so none
 * of these ever suggests signing out. A 404 (another account's seat, or none) falls back to the
 * old, honest "no longer waiting — perhaps another account". This replaced reading the inbox for
 * the notice that linked here and the booking behind it, which guessed wrong whenever the notice
 * had scrolled past the newest fifty.
 * </p>
 */
export type InviteFate =
  | { kind: "reading" }
  | { kind: "unknown" }
  | { kind: "in"; bookingId: string }
  | { kind: "cancelled"; bookingId: string }
  | { kind: "gone"; bookingId: string };

/** What the seat's own record says became of it. */
export function fateOf(seat: MySeat): InviteFate {
  const bookingId = seat.booking_id;
  if (seat.booking_status === "cancelled") return { kind: "cancelled", bookingId };
  if (seat.status === "accepted" && !seat.lapsed) return { kind: "in", bookingId };
  return { kind: "gone", bookingId };
}

async function readFate(participantId: string): Promise<InviteFate> {
  try {
    return fateOf(await playersEndpoints.mySeat(participantId));
  } catch {
    // 404 (not this account's seat) and a failed read alike: say only what is certain.
    return { kind: "unknown" };
  }
}

export function useInviteFate(participantId: string, enabled: boolean): InviteFate {
  const [fate, setFate] = useState<{ id: string; fate: InviteFate } | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    readFate(participantId).then(
      (found) => { if (live) setFate({ id: participantId, fate: found }); },
      () => { if (live) setFate({ id: participantId, fate: { kind: "unknown" } }); },
    );
    return () => { live = false; };
  }, [participantId, enabled]);
  return fate?.id === participantId ? fate.fate : { kind: "reading" };
}

/**
 * R2 F2-6 — a shared link answered `409 invite_closed` with its booking: when the caller is on
 * that game (they claimed the seat) and it was cancelled, the page says so and what came back,
 * instead of "can't be opened". Read from the booking itself — a claimer is a player of it; for
 * anybody else the read is a 404 and the page keeps its general sentence.
 */
export type ClosedGame =
  | { kind: "reading" }
  | { kind: "other" }
  | { kind: "cancelled"; bookingId: string; back: number };

async function readClosedGame(bookingId: string): Promise<ClosedGame> {
  try {
    const d = await playersEndpoints.detail(bookingId);
    const mine = d.players.find((p) => p.participant_id !== null && p.participant_id === d.viewer.participant_id);
    if (d.status !== "cancelled" || d.viewer.role !== "player" || !mine) return { kind: "other" };
    // What they had paid came back with the cancellation — the share they said yes to, when
    // nothing is still counted as paid (a check-in keeps it: then it is `paid_credits`).
    const back = mine.status === "accepted" && mine.paid_credits <= 0 ? mine.consented_credits : 0;
    return { kind: "cancelled", bookingId, back };
  } catch {
    return { kind: "other" };
  }
}

export function useClosedGame(bookingId: string | null): ClosedGame {
  const [held, setHeld] = useState<{ id: string; game: ClosedGame } | null>(null);
  useEffect(() => {
    if (!bookingId) return undefined;
    let live = true;
    void readClosedGame(bookingId).then((game) => { if (live) setHeld({ id: bookingId, game }); });
    return () => { live = false; };
  }, [bookingId]);
  if (!bookingId) return { kind: "other" };
  return held?.id === bookingId ? held.game : { kind: "reading" };
}
