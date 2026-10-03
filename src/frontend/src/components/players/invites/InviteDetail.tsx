import { useId, useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { typography } from "@/lib/typography";
import { AcceptActions } from "./AcceptActions";
import { AcceptBody } from "./AcceptBody";
import { answerHeading } from "./inviteFacts";
import { seatPort, useAcceptFlow } from "./useAcceptFlow";

/**
 * One invite, answered in place — the detail pane of the Invites split view (R4 form factor,
 * SPEC 3.5). The same three parts the accept sheet and the deep-link panel compose (the flow, its
 * body and its actions), so the money it states and the guard on an answer in flight are theirs;
 * only the frame differs. On a phone the sheet is still the way in.
 *
 * <p>
 * `key` it by the invite: a different invite starts a clean flow.
 * </p>
 */
export function InviteDetail({ invite, onReread }: { invite: Invite; onReread: () => Promise<unknown> }) {
  const reasonId = useId();
  const headingId = useId();
  const { booking_id: bookingId, participant_id: participantId, open_link: openLink } = invite;
  const port = useMemo(
    () => seatPort({ booking_id: bookingId, participant_id: participantId, open_link: openLink }, onReread),
    [bookingId, participantId, openLink, onReread],
  );
  const flow = useAcceptFlow(invite, port);
  const heading = answerHeading(invite, INVITES_COPY.sheetTitle, flow.askingDecline);
  const dismiss = flow.outcome ? (
    <Button asChild variant="outline"><Link to="/bookings">{INVITES_COPY.toBookings}</Link></Button>
  ) : null;
  return (
    <Panel role="region" aria-labelledby={headingId} data-invite-detail={participantId} className="flex flex-col gap-4">
      <div>
        {/* The sheet's title, kept after an answer: the outcome is said once, by the body's status. */}
        <h2 id={headingId} className={typography({ variant: "h2" })}>{heading.title}</h2>
        <p className="mt-1 text-sm text-text-secondary">{heading.line}</p>
      </div>
      <AcceptBody flow={flow} reasonId={reasonId} />
      <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
        <AcceptActions flow={flow} reasonId={reasonId} dismiss={dismiss} />
      </div>
    </Panel>
  );
}
