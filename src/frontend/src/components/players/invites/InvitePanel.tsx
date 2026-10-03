import { useId } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { TextLink } from "@/components/ui/text-link";
import { SignOut } from "@/components/ui/icons";
import { useProfileOrNull } from "@/components/onboarding/useOnboarding";
import { useAuth } from "@/lib/useAuth";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY, signedInAsLine } from "@/lib/playersCopy";
import { AcceptActions } from "./AcceptActions";
import { AcceptBody } from "./AcceptBody";
import { inviteHeading } from "./inviteFacts";
import { useAcceptFlow, type AcceptPort } from "./useAcceptFlow";

/**
 * An invite as a page — the shared link and the invite mail's deep link both land here. The body
 * and the actions are the accept sheet's own, so the page and the sheet cannot disagree.
 */
export function InvitePanel({ invite, port }: { invite: Invite; port: AcceptPort }) {
  const reasonId = useId();
  const flow = useAcceptFlow(invite, port);
  const dismiss = (
    <Button asChild variant="outline">
      <Link to="/bookings">{INVITES_COPY.toBookings}</Link>
    </Button>
  );
  const heading = inviteHeading(invite, INVITES_COPY.linkTitle);
  return (
    <PageShell width="narrow">
      <PageHeader
        title={panelTitle(flow.outcome?.kind, heading.title)}
        description={heading.line}
        back={{ to: "/bookings/invites", label: INVITES_COPY.title }}
      />
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-bg-surface p-4 shadow-xs sm:p-6">
        <AcceptBody flow={flow} reasonId={reasonId} headed />
        <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
          <AcceptActions flow={flow} reasonId={reasonId} dismiss={dismiss} />
        </div>
      </div>
    </PageShell>
  );
}

/**
 * D6 — the heading follows the answer. It went on saying "You're invited" above "You're in",
 * which is a question the member had already answered.
 */
function panelTitle(outcome: "accepted" | "declined" | undefined, asked: string): string {
  if (outcome === "accepted") return INVITES_COPY.acceptedTitle;
  if (outcome === "declined") return INVITES_COPY.declinedTitle;
  return asked;
}

/** The page while the invite is read — the panel's own shape. */
export function InvitePanelSkeleton({ loading, error, onRetry }: { loading: boolean; error: unknown; onRetry: () => void }) {
  return (
    <PageShell width="narrow">
      <PageHeader title={INVITES_COPY.pageTitle} back={{ to: "/bookings/invites", label: INVITES_COPY.title }} />
      <StateBlock
        loading={loading}
        error={error}
        action={INVITES_COPY.readLinkAction}
        onRetry={onRetry}
        skeleton={(
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-bg-surface p-4 sm:p-6">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-11 w-full" />
          </div>
        )}
      />
    </PageShell>
  );
}

/**
 * An invite that cannot be opened: why, in a sentence, and the way back — to the booking itself
 * when the refusal named it (`already_in_booking`), and always to Invites and Bookings.
 */
export function InviteGone({ title, sentence, bookingId, otherAccount = false }: {
  title: string; sentence: string; bookingId?: string | null;
  /** D5 — the invite may be another member's; say who is signed in and offer to switch. */
  otherAccount?: boolean;
}) {
  return (
    <PageShell width="narrow">
      <PageHeader title={title} back={{ to: "/bookings", label: INVITES_COPY.back }} />
      <div className="flex flex-col items-start gap-3" data-invite-gone="">
        <Alert tone="info" live="polite" className="w-full">{sentence}</Alert>
        {otherAccount ? <OtherAccount /> : null}
        {bookingId ? <TextLink to={`/bookings/${bookingId}`} variant="standalone">{INVITES_COPY.seeBooking}</TextLink> : null}
        <TextLink to="/bookings/invites" variant="standalone">{INVITES_COPY.toInvites}</TextLink>
        <TextLink to="/bookings" variant="standalone">{INVITES_COPY.toBookings}</TextLink>
      </div>
    </PageShell>
  );
}

/**
 * D5 — "whose is it?" is the one thing the club rightly will not answer (a 404 either way), so
 * the page says who IS signed in and offers the way to open it as somebody else. Signing out
 * from here returns the next person to sign in to this same invite.
 */
function OtherAccount() {
  const auth = useAuth();
  const profile = useProfileOrNull();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const name = profile?.full_name?.trim().split(/\s+/)[0] || profile?.email || null;
  const signOut = () => {
    const returnTo = `${pathname}${search}`;
    void auth.logout({ returnTo });
    navigate("/login", { replace: true });
  };
  return (
    <div className="flex w-full flex-col items-start gap-2" data-other-account="">
      {name ? <p className="text-sm text-text-secondary">{signedInAsLine(name)}</p> : null}
      <Button type="button" variant="outline" onClick={signOut} icon={<SignOut weight="bold" />}>
        {INVITES_COPY.signOutToOpen}
      </Button>
    </div>
  );
}

