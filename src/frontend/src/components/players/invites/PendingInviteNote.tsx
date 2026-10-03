import { useState } from "react";
import { Alert } from "@/components/Alert";
import { pendingInvite } from "@/lib/playersPending";
// R7 P5-7 — shell copy (`bellCopy`), not `playersCopy`: this note is in every member's first load.
import { PENDING_INVITE_NOTE } from "@/lib/bellCopy";

/**
 * R1 F2.3 — on the way into the club (register, the "check your inbox" screen, the confirmed
 * email), a friend who arrived by an invite link is told it is kept: after approval and the first
 * sign-in, Invites and the Bookings badge offer it again. Nothing when no link is waiting — only a
 * signed-out one counts, since nobody here is signed in yet.
 */
export function PendingInviteNote({ stage }: { stage: "join" | "verified" }) {
  // Read once: the note describes the visit, and storage is not a thing to subscribe to.
  const [waiting] = useState(() => pendingInvite(null) !== null);
  if (!waiting) return null;
  return (
    <Alert tone="info" live="off" data-pending-invite="">
      {stage === "join" ? PENDING_INVITE_NOTE.join : PENDING_INVITE_NOTE.verified}
    </Alert>
  );
}
