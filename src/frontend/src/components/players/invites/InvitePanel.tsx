import { useId } from "react";
import { Link } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { TextLink } from "@/components/ui/text-link";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY, invitedLine } from "@/lib/playersCopy";
import { AcceptActions } from "./AcceptActions";
import { AcceptBody } from "./AcceptBody";
import { organiserName } from "./inviteFacts";
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
  return (
    <PageShell width="narrow">
      <PageHeader
        title={INVITES_COPY.linkTitle}
        description={invitedLine(organiserName(invite), invite.open_link)}
        back={{ to: "/bookings/invites", label: INVITES_COPY.title }}
      />
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-bg-surface p-4 shadow-xs sm:p-6">
        <AcceptBody flow={flow} reasonId={reasonId} />
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <AcceptActions flow={flow} reasonId={reasonId} dismiss={dismiss} />
        </div>
      </div>
    </PageShell>
  );
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
export function InviteGone({ title, sentence, bookingId }: { title: string; sentence: string; bookingId?: string | null }) {
  return (
    <PageShell width="narrow">
      <PageHeader title={title} back={{ to: "/bookings", label: INVITES_COPY.back }} />
      <div className="flex flex-col items-start gap-3" data-invite-gone="">
        <Alert tone="info" live="polite" className="w-full">{sentence}</Alert>
        {bookingId ? <TextLink to={`/bookings/${bookingId}`} variant="standalone">{INVITES_COPY.seeBooking}</TextLink> : null}
        <TextLink to="/bookings/invites" variant="standalone">{INVITES_COPY.toInvites}</TextLink>
        <TextLink to="/bookings" variant="standalone">{INVITES_COPY.toBookings}</TextLink>
      </div>
    </PageShell>
  );
}
