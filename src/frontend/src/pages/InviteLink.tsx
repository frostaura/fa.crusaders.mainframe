import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useParams } from "react-router-dom";
import { InviteGone, InvitePanel, InvitePanelSkeleton } from "@/components/players/invites/InvitePanel";
import { InviteSignedOut } from "@/components/players/invites/InviteSignedOut";
import { codeOf } from "@/components/players/invites/inviteFacts";
import { useInviteSnapshot } from "@/components/players/invites/useInviteSnapshot";
import { useClosedGame, type ClosedGame } from "@/components/players/invites/useInviteFate";
import type { AcceptPort } from "@/components/players/invites/useAcceptFlow";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playersEndpoints } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { minutesSpoken } from "@/lib/minutes";
import { clearPendingInvite, pendingInvite, savePendingInvite } from "@/lib/playersPending";

/**
 * `/j/:token` — a shared invite link (WhatsApp, a message). Opening it reads the seat the token
 * names; the answers it can refuse with are each a sentence page with a way back.
 *
 * <p>
 * <b>Signed out (R1 F2.3 / F2.4)</b>, the page says an invite is waiting and offers "Sign in" and
 * "Join the club", both keeping the link (`InviteSignedOut`). That arm is reached once the route
 * lets an anonymous visitor through; behind a plain `RequireAuth` a signed-out member is carried
 * through `/login` and back here instead.
 * </p>
 *
 * <p>
 * <b>The link is remembered until it is answered</b> (R1 F2.5): a member short of minutes who goes
 * to buy a package finds it again on Invites and the Bookings badge. An answer or a refusal forgets it.
 * </p>
 */
const OPEN_REFUSAL: Record<string, string> = {
  invite_not_found: INVITES_COPY.linkNotFound,
  invite_closed: INVITES_COPY.linkClosed,
  already_in_booking: INVITES_COPY.linkAlreadyIn,
  player_previously_removed: INVITES_COPY.linkRemoved,
};

export default function InviteLinkPage() {
  const { token = "" } = useParams();
  const auth = useAuth();
  if (auth.status === "anonymous") return <InviteSignedOut token={token} />;
  if (auth.status !== "authenticated") return <InvitePanelSkeleton loading error={null} onRetry={() => undefined} />;
  return <InviteLinkFor key={`${auth.userId}:${token}`} token={token} userId={auth.userId} />;
}

/** Answering forgets the link: there is nothing left to come back to. */
function forgetting<T>(token: string, answer: () => Promise<T>): Promise<T> {
  return answer().then((value) => {
    clearPendingInvite(token);
    return value;
  });
}

function InviteLinkFor({ token, userId }: { token: string; userId: string }) {
  // Whether THIS account opened the link before (R1 F2.7) — read once, before this visit saves it.
  const [openedBefore] = useState(() => openedBy(token, userId));
  const read = useCallback(() => playersEndpoints.invite(token), [token]);
  const snapshot = useInviteSnapshot(read);
  const { reread } = snapshot;
  const port = useMemo<AcceptPort>(() => ({
    accept: (expected) => forgetting(token, () => playersEndpoints.acceptLink(token, expected)),
    decline: () => forgetting(token, () => playersEndpoints.declineLink(token)),
    reread,
  }), [token, reread]);

  const code = codeOf(snapshot.error);
  const refused = code !== null && code in OPEN_REFUSAL;
  const errorBooking = snapshot.error instanceof ApiError ? snapshot.error.detail("booking_id") : null;
  const closedGame = useClosedGame(code === "invite_closed" && typeof errorBooking === "string" ? errorBooking : null);
  const opened = snapshot.invite !== null;
  useEffect(() => {
    if (refused) clearPendingInvite(token);
    else if (opened) savePendingInvite(token, userId);
  }, [refused, opened, token, userId]);

  const notOpen = notOpenPage(code, closedGame, errorBooking, openedBefore);
  if (notOpen) return notOpen;
  if (!snapshot.invite) {
    return <InvitePanelSkeleton loading={snapshot.loading} error={snapshot.error} onRetry={snapshot.retry} />;
  }
  return <InvitePanel invite={snapshot.invite} port={port} />;
}

function openedBy(token: string, userId: string): boolean {
  const pending = pendingInvite(userId);
  return pending?.userId === userId && pending?.token === token;
}

/**
 * The page for a link that is not open, or null when it is: its cancelled game still being read,
 * that game's cancellation, or the refusal's sentence.
 */
function notOpenPage(code: string | null, closedGame: ClosedGame, errorBooking: string | number | null, openedBefore: boolean): ReactElement | null {
  if (code === "invite_closed" && closedGame.kind === "reading") {
    return <InvitePanelSkeleton loading error={null} onRetry={() => undefined} />;
  }
  if (closedGame.kind === "cancelled") {
    const sentence = closedGame.back > 0
      ? INVITES_COPY.linkCancelledBack(minutesSpoken(closedGame.back)) : INVITES_COPY.linkCancelledNothing;
    return <InviteGone title={INVITES_COPY.fateCancelledTitle} sentence={sentence} bookingId={closedGame.bookingId} />;
  }
  if (!code || !(code in OPEN_REFUSAL)) return null;
  const mine = code === "invite_not_found" && openedBefore;
  return (
    <InviteGone
      title={INVITES_COPY.refusedTitle}
      sentence={mine ? INVITES_COPY.linkNoLongerOpen : OPEN_REFUSAL[code]}
      bookingId={code === "already_in_booking" && typeof errorBooking === "string" ? errorBooking : null}
      otherAccount={code === "invite_not_found" && !openedBefore}
    />
  );
}
