import { useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { seatPort } from "@/components/players/invites/useAcceptFlow";
import { InviteGone, InvitePanel, InvitePanelSkeleton } from "@/components/players/invites/InvitePanel";
import { useInviteSnapshot } from "@/components/players/invites/useInviteSnapshot";
import { playersEndpoints } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";

/**
 * `/invites/:participantId` — the invite mail's link (never a token: a token in an outbox row
 * would be a credential stored in clear). The seat is found in the member's own open invites
 * and opened as a page, so the address lands on the actionable invite itself. Not there any more
 * — answered, withdrawn, lapsed — and the page says so, with the way to Invites and Bookings.
 */
export default function InviteDeepLinkPage() {
  const { participantId = "" } = useParams();
  return <DeepLinkFor key={participantId} participantId={participantId} />;
}

function DeepLinkFor({ participantId }: { participantId: string }) {
  const read = useCallback(async () => {
    const { items } = await playersEndpoints.myInvites();
    return (items ?? []).find((i) => i.participant_id === participantId) ?? null;
  }, [participantId]);
  const snapshot = useInviteSnapshot(read);
  const { invite, reread } = snapshot;
  const bookingId = invite?.booking_id;
  const openLink = invite?.open_link ?? false;
  const port = useMemo(
    () => seatPort({ booking_id: bookingId ?? "", participant_id: participantId, open_link: openLink }, reread),
    [bookingId, participantId, openLink, reread],
  );

  if (snapshot.gone) {
    return <InviteGone title={INVITES_COPY.deepLinkGone} sentence={INVITES_COPY.deepLinkGoneHint} otherAccount />;
  }
  if (!invite) return <InvitePanelSkeleton loading={snapshot.loading} error={snapshot.error} onRetry={snapshot.retry} />;
  return <InvitePanel invite={invite} port={port} />;
}
