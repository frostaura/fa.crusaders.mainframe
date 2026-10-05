import { useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { seatPort } from "@/components/players/invites/useAcceptFlow";
import { InviteGone, InvitePanel, InvitePanelSkeleton } from "@/components/players/invites/InvitePanel";
import { InviteSignedOut } from "@/components/players/invites/InviteSignedOut";
import { useInviteFate, type InviteFate } from "@/components/players/invites/useInviteFate";
import { useInviteSnapshot } from "@/components/players/invites/useInviteSnapshot";
import { useAuth } from "@/lib/useAuth";
import { playersEndpoints } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { goneSeatWords } from "@/components/players/detail/goneSeatWords";

/**
 * `/invites/:participantId` — the invite mail's link (never a token: a token in an outbox row
 * would be a credential stored in clear). The seat is found in the member's own open invites
 * and opened as a page, so the address lands on the actionable invite itself.
 *
 * <p>
 * <b>Not there any more (R1 F2.7 / F2.8)</b>, the page says what became of it — "You're in", the
 * game was cancelled, or they are no longer on it — with the way to the booking, and never asks
 * the member who was sent it to sign out. Only when nothing can be found does it fall back to
 * "no longer waiting — perhaps it was sent to another account" (D5).
 * </p>
 *
 * <p>
 * <b>Signed out</b>, it says an invite is waiting and offers sign-in, which returns here — the arm
 * is reached once the route lets an anonymous visitor through.
 * </p>
 */
export default function InviteDeepLinkPage() {
  const { participantId = "" } = useParams();
  const auth = useAuth();
  if (auth.status === "anonymous") return <InviteSignedOut />;
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
  const fate = useInviteFate(participantId, snapshot.gone);

  if (snapshot.gone) return <Fate fate={fate} />;
  if (!invite) return <InvitePanelSkeleton loading={snapshot.loading} error={snapshot.error} onRetry={snapshot.retry} />;
  return <InvitePanel invite={invite} port={port} />;
}

const FATE_WORDS = {
  in: { title: INVITES_COPY.fateInTitle, sentence: INVITES_COPY.fateInBody },
  cancelled: { title: INVITES_COPY.fateCancelledTitle, sentence: INVITES_COPY.fateCancelledBody },
} as const;

function Fate({ fate }: { fate: InviteFate }) {
  if (fate.kind === "reading") return <InvitePanelSkeleton loading error={null} onRetry={() => undefined} />;
  if (fate.kind === "unknown") {
    return <InviteGone title={INVITES_COPY.deepLinkGone} sentence={INVITES_COPY.deepLinkGoneHint} otherAccount />;
  }
  if (fate.kind === "gone") {
    // R16 J15-1 — which way it left the game, from the seat's own status and `removed_by`. Off the
    // game, the booking is a 404 to them: no link to it, only the ways back.
    const said = goneSeatWords(fate.seat);
    return <InviteGone title={said.title} sentence={said.body} bookingId={null} />;
  }
  const words = FATE_WORDS[fate.kind];
  return <InviteGone title={words.title} sentence={words.sentence} bookingId={fate.bookingId} />;
}
