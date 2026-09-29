import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Envelope } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { savePendingInvite } from "@/lib/playersPending";
import { INVITES_COPY } from "@/lib/playersCopy";

/**
 * R1 F2.3 / F2.4 — an invite opened by somebody who is not signed in: a member on a new phone,
 * or a friend who is not a member yet.
 *
 * <p>
 * <b>What it can say.</b> The club answers an invite only to a signed-in member (a forwarded link
 * reveals no game), so the page says an invite is waiting and offers the two ways in. Both keep
 * the link: "Sign in" returns here through `/login`'s `from`; "Join the club" relies on the
 * pending invite this page saves, which Invites, the Bookings badge and the registration screens
 * resurface after the member is approved and signs in for the first time.
 * </p>
 */
export function InviteSignedOut({ token }: {
  /** The shared link's token — kept for a member who joins first. Absent for the mail's seat link. */
  token?: string;
}) {
  const location = useLocation();
  useEffect(() => {
    if (token) savePendingInvite(token, null);
  }, [token]);
  const from = { pathname: location.pathname, search: location.search };
  return (
    <PageShell width="narrow">
      <PageHeader title={INVITES_COPY.signedOutTitle} description={INVITES_COPY.signedOutBody} />
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-bg-surface p-4 shadow-xs sm:p-6" data-invite-signed-out="">
        <span aria-hidden="true" className="inline-flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
          <Envelope size={24} weight="bold" />
        </span>
        <Button asChild>
          <Link to="/login" state={{ from }}>{INVITES_COPY.signedOutSignIn}</Link>
        </Button>
        {token ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-secondary">{INVITES_COPY.signedOutJoinHint}</p>
            <Button asChild variant="outline">
              <Link to="/register">{INVITES_COPY.signedOutJoin}</Link>
            </Button>
          </div>
        ) : null}
      </div>
    </PageShell>
  );
}
