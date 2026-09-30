import { useId, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { AcceptActions } from "./AcceptActions";
import { AcceptBody } from "./AcceptBody";
import { inviteHeading } from "./inviteFacts";
import { seatPort, useAcceptFlow } from "./useAcceptFlow";

/**
 * The accept sheet (Invites page, and the invite-mail deep link): the game, your share, your
 * balance after, the cap it counts against and the deadline — then Accept, Decline or Cancel.
 *
 * <p>
 * `invite` is the latest read of this seat; the page re-reads its list after every answer and
 * hands the fresh row back in, which is how a risen share reaches the sheet's figures and its
 * Accept label before the member taps again.
 * </p>
 */
export type AcceptSheetProps = {
  invite: Invite | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read the invites again. Never rejects. */
  onReread: () => Promise<unknown>;
  /** Bumped by the page each time the sheet opens, so a reopened sheet starts clean. */
  session?: number;
};

export function AcceptSheet(props: AcceptSheetProps) {
  const { invite, open, onOpenChange, onReread, session = 0 } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-sheet="accept-invite">
        {invite ? <SheetInner key={`${invite.participant_id}:${session}`} invite={invite} onReread={onReread} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SheetInner({ invite, onReread }: { invite: Invite; onReread: () => Promise<unknown> }) {
  const reasonId = useId();
  const { booking_id: bookingId, participant_id: participantId, open_link: openLink } = invite;
  const port = useMemo(
    () => seatPort({ booking_id: bookingId, participant_id: participantId, open_link: openLink }, onReread),
    [bookingId, participantId, openLink, onReread],
  );
  const flow = useAcceptFlow(invite, port);
  const dismiss = (
    <DialogClose asChild>
      <Button variant="outline">{flow.outcome ? INVITES_COPY.done : INVITES_COPY.cancel}</Button>
    </DialogClose>
  );
  const heading = inviteHeading(invite, INVITES_COPY.sheetTitle);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{heading.title}</DialogTitle>
        <DialogDescription>{heading.line}</DialogDescription>
      </DialogHeader>
      <DialogBody className="pb-4">
        <AcceptBody flow={flow} reasonId={reasonId} />
      </DialogBody>
      <DialogFooter>
        <AcceptActions flow={flow} reasonId={reasonId} dismiss={dismiss} />
      </DialogFooter>
    </>
  );
}
