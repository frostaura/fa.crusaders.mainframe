import { useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { InviteGone, InvitePanel, InvitePanelSkeleton } from "@/components/players/invites/InvitePanel";
import { codeOf } from "@/components/players/invites/inviteFacts";
import { useInviteSnapshot } from "@/components/players/invites/useInviteSnapshot";
import type { AcceptPort } from "@/components/players/invites/useAcceptFlow";
import { ApiError } from "@/lib/api";
import { playersEndpoints } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";

/**
 * `/j/:token` — a shared invite link (WhatsApp, a message). Opening it reads the seat the token
 * names; the answers it can refuse with are each a sentence page with a way back. A signed-out
 * member has already been carried through /login and back here by RequireAuth.
 */
const OPEN_REFUSAL: Record<string, string> = {
  invite_not_found: INVITES_COPY.linkNotFound,
  invite_closed: INVITES_COPY.linkClosed,
  already_in_booking: INVITES_COPY.linkAlreadyIn,
  player_previously_removed: INVITES_COPY.linkRemoved,
};

export default function InviteLinkPage() {
  const { token = "" } = useParams();
  return <InviteLinkFor key={token} token={token} />;
}

function InviteLinkFor({ token }: { token: string }) {
  const read = useCallback(() => playersEndpoints.invite(token), [token]);
  const snapshot = useInviteSnapshot(read);
  const { reread } = snapshot;
  const port = useMemo<AcceptPort>(() => ({
    accept: (expected) => playersEndpoints.acceptLink(token, expected),
    decline: () => playersEndpoints.declineLink(token),
    reread,
  }), [token, reread]);

  const code = codeOf(snapshot.error);
  if (code && code in OPEN_REFUSAL) {
    const bookingId = snapshot.error instanceof ApiError ? snapshot.error.detail("booking_id") : null;
    return (
      <InviteGone
        title={INVITES_COPY.refusedTitle}
        sentence={OPEN_REFUSAL[code]}
        bookingId={code === "already_in_booking" && typeof bookingId === "string" ? bookingId : null}
      />
    );
  }
  if (!snapshot.invite) {
    return <InvitePanelSkeleton loading={snapshot.loading} error={snapshot.error} onRetry={snapshot.retry} />;
  }
  return <InvitePanel invite={snapshot.invite} port={port} />;
}
