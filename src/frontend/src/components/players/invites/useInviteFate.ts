import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { playersEndpoints } from "@/lib/playersApi";

/**
 * R1 F2.7 / F2.8 — what became of an invite the mail's link names, once it is no longer on the
 * member's open list: they said yes (and paid), the game was cancelled, or they are off it.
 *
 * <p>
 * <b>Looking beyond the open list.</b> The link carries only the seat id, and the club lists only
 * open invites, so the member's own inbox is read for the notice that linked here — it names the
 * booking — and the booking is read as them: their seat accepted is "you're in"; the game
 * cancelled says so; a 404 means they are no longer on it (declined, pulled out, removed, lapsed).
 * The notice being in THIS member's inbox is what proves the invite was theirs, so none of these
 * ever suggests signing out. With no such notice the page falls back to the old, honest "no
 * longer waiting — perhaps another account".
 * </p>
 */
export type InviteFate =
  | { kind: "reading" }
  | { kind: "unknown" }
  | { kind: "in"; bookingId: string }
  | { kind: "cancelled"; bookingId: string }
  | { kind: "gone"; bookingId: string };

/** How many of the newest notices are searched for the one that linked here. */
const NOTICES = 50;

async function readFate(participantId: string): Promise<InviteFate> {
  const page = await playersEndpoints.notifications(null, NOTICES);
  const notice = (page.items ?? []).find((n) => n.link === `/invites/${participantId}` && n.booking_id);
  const bookingId = notice?.booking_id;
  if (!bookingId) return { kind: "unknown" };
  try {
    const detail = await playersEndpoints.detail(bookingId);
    if (detail.status === "cancelled") return { kind: "cancelled", bookingId };
    const seat = detail.players.find((p) => p.participant_id === participantId);
    return seat?.status === "accepted" ? { kind: "in", bookingId } : { kind: "unknown" };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: "gone", bookingId };
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
