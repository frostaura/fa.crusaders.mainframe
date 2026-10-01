import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playersEndpoints, type Invite } from "@/lib/playersApi";
import { clearPendingInvite, invitePathOf, pendingInvite } from "@/lib/playersPending";

/**
 * R1 F2.3 / F2.5 — the invite link this member opened and has not answered, read again so it can
 * be offered beside their other invites: an open seat is nobody's until it is accepted, so the
 * club's own list (`/me/invites`) cannot hold it — a member who left to buy minutes, or who joined the
 * club in between, would otherwise never find it again.
 *
 * <p>
 * Null while there is none, while it is read, when it is already on `items` (an addressed invite
 * opened by its link), and when the club refuses it — a refusal forgets it for good.
 * </p>
 */
export type PendingLinkInvite = { token: string; path: string; invite: Invite };

type Read = { token: string; invite: Invite | null };

export function usePendingLinkInvite(items: readonly Invite[] | null): PendingLinkInvite | null {
  const auth = useAuth();
  const userId = auth.status === "authenticated" ? auth.userId : null;
  const token = userId ? pendingInvite(userId)?.token ?? null : null;
  const [read, setRead] = useState<Read | null>(null);

  useEffect(() => {
    if (!token) return undefined;
    let live = true;
    playersEndpoints.invite(token).then(
      (invite) => { if (live) setRead({ token, invite }); },
      (error: unknown) => {
        // The club's answer that it is gone (404/409) forgets it; a dropped connection does not.
        if (error instanceof ApiError && (error.status === 404 || error.status === 409)) clearPendingInvite(token);
        if (live) setRead({ token, invite: null });
      },
    );
    return () => { live = false; };
  }, [token]);

  if (!token || read?.token !== token || !read.invite) return null;
  const { invite } = read;
  if (items?.some((i) => i.participant_id === invite.participant_id)) return null;
  return { token, path: invitePathOf(token), invite };
}
