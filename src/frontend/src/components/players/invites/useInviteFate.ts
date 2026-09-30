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
