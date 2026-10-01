import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Envelope } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { ApiError } from "@/lib/api";
import { clubClock } from "@/lib/clubClock";
import { playersEndpoints, type InvitePreview } from "@/lib/playersApi";
import { clearPendingInvite, savePendingInvite } from "@/lib/playersPending";
import { INVITES_COPY, firstName, playersWhen } from "@/lib/playersCopy";
import { Minutes } from "@/components/Minutes";

/**
 * R1 F2.3 / F2.4 — an invite opened by somebody who is not signed in: a member on a new phone,
 * or a friend who is not a member yet.
 *
 * <p>
 * <b>What it can say.</b> A shared link (`/j/:token`) is read through the anonymous preview
 * (review round 1, B4): the organiser's first name, the court, when and the share — the invite
 * mail's own facts, because holding the token proves you were sent it. A link the club answers
 * `404` for is no longer open, and the page says so instead of inviting a sign-in that would find
 * nothing. The mail's seat link carries no token, so it says only that an invite is waiting.
 * Both keep the link: "Sign in" returns here through `/login`'s `from`; "Join the club" relies on
 * the pending invite this page saves, which Invites, the Bookings badge and the registration
 * screens resurface after the member is approved and signs in for the first time.
 * </p>
 */
export function InviteSignedOut({ token }: {
  /** The shared link's token — kept for a member who joins first. Absent for the mail's seat link. */
  token?: string;
}) {
  const location = useLocation();
  const preview = useInvitePreview(token);
  const gone = preview.kind === "gone";
  useEffect(() => {
    if (!token) return;
    if (gone) clearPendingInvite(token);
    else savePendingInvite(token, null);
  }, [token, gone]);
  const from = { pathname: location.pathname, search: location.search };
  return (
    <PageShell width="narrow">
      <PageHeader
        title={gone ? INVITES_COPY.signedOutGoneTitle : INVITES_COPY.signedOutTitle}
        description={gone ? INVITES_COPY.signedOutGoneBody : preview.kind === "open" ? INVITES_COPY.signedOutBodyShown : INVITES_COPY.signedOutBody}
      />
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-bg-surface p-4 shadow-xs sm:p-6" data-invite-signed-out="">
        <span aria-hidden="true" className="inline-flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
          <Envelope size={24} weight="bold" />
        </span>
        {preview.kind === "open" ? <PreviewFacts preview={preview.facts} /> : null}
        <Button asChild variant={gone ? "outline" : "primary"}>
          <Link to="/login" state={{ from }}>{INVITES_COPY.signedOutSignIn}</Link>
        </Button>
        {token && !gone ? (
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

function PreviewFacts({ preview }: { preview: InvitePreview }) {
  const when = `${playersWhen(preview.starts_at, preview.timezone)}–${clubClock(preview.ends_at, preview.timezone)}`;
  return (
    <div className="flex flex-col gap-1" data-invite-preview="">
      <p className="break-words text-base font-semibold text-text-primary">
        {INVITES_COPY.previewInvited(firstName(preview.organiser_first_name))}
      </p>
      <p className="break-words text-sm text-text-secondary">{`${preview.court_name ?? INVITES_COPY.court} · ${when}`}</p>
      <p className="text-sm font-semibold tabular-nums text-text-primary">
        {INVITES_COPY.yourShare} <Minutes value={preview.share_minutes} />
      </p>
    </div>
  );
}

type PreviewState =
  | { kind: "none" }
  | { kind: "open"; facts: InvitePreview }
  | { kind: "gone" };

/**
 * The anonymous preview of a shared link, or `none` while it is read, for the seat link (no
 * token), and when the read fails for any reason other than the club's `404` — a dropped
 * connection keeps the plain "an invite is waiting".
 */
function useInvitePreview(token: string | undefined): PreviewState {
  const [read, setRead] = useState<{ token: string; state: PreviewState } | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    let live = true;
    playersEndpoints.invitePreview(token).then(
      (facts) => { if (live) setRead({ token, state: { kind: "open", facts } }); },
      (error: unknown) => {
        const gone = error instanceof ApiError && error.status === 404;
        if (live) setRead({ token, state: gone ? { kind: "gone" } : { kind: "none" } });
      },
    );
    return () => { live = false; };
  }, [token]);
  return token && read?.token === token ? read.state : { kind: "none" };
}
