import { useId, useLayoutEffect, useMemo, useRef } from "react";
import { SendingNote } from "@/components/bookings/SheetParts";
import { useSendingGuard } from "@/components/bookings/useSendingGuard";
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
  /** An answer is on its way to the club (the page's Back refuses to close meanwhile). */
  onBusyChange?: (busy: boolean) => void;
  /**
   * R5 §3.5 — opened from a card's own Decline: the sheet opens on the decline question ("Decline
   * for good? / Keep the invite", focus on the safe answer). Nothing is sent until it is answered.
   */
  startWith?: "decline";
};

/**
 * R4 (I4-1's rule, the integration leftover) — the sheet stays open while an answer is on its way.
 * Accept moves money; a Cancel, ×, Escape, scrim or Back pressed on a slow reply used to close the
 * sheet in silence while the share was taken a moment later. Every way out asks the guard first,
 * and while the answer is in flight the sheet says it is waiting, again on each refused close.
 */
export function AcceptSheet(props: AcceptSheetProps) {
  const { invite, open, onOpenChange, onReread, session = 0, onBusyChange, startWith } = props;
  const guard = useSendingGuard(onOpenChange, onBusyChange);
  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent data-sheet="accept-invite">
        {invite ? (
          <SheetInner
            key={`${invite.participant_id}:${session}`} invite={invite} onReread={onReread}
            onBusy={guard.setSending} refused={guard.refused} startWith={startWith}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type InnerProps = {
  invite: Invite; onReread: () => Promise<unknown>; onBusy: (busy: boolean) => void; refused: number; startWith?: "decline";
};

function SheetInner(props: InnerProps) {
  const { invite, onReread, onBusy, refused, startWith } = props;
  const reasonId = useId();
  const { booking_id: bookingId, participant_id: participantId, open_link: openLink } = invite;
  const port = useMemo(
    () => seatPort({ booking_id: bookingId, participant_id: participantId, open_link: openLink }, onReread),
    [bookingId, participantId, openLink, onReread],
  );
  const flow = useAcceptFlow(invite, port);
  const sending = flow.acceptAction.pending || flow.declineAction.pending;
  useLayoutEffect(() => { onBusy(sending); }, [sending, onBusy]);
  // Torn down mid-answer (a sign-out): nothing is waiting on this sheet any more.
  useLayoutEffect(() => () => onBusy(false), [onBusy]);
  // R5 §3.5 — a card's Decline opens straight onto the question; asked once per opening (the
  // sheet's inner part is keyed by the opening, so a reopen asks again).
  const asked = useRef(false);
  useLayoutEffect(() => {
    if (asked.current || startWith !== "decline" || !flow.canDecline) return;
    asked.current = true;
    flow.decline();
  }, [startWith, flow]);
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
        <SendingNote text={sending ? INVITES_COPY.sending : null} refused={refused} />
        <AcceptActions flow={flow} reasonId={reasonId} dismiss={dismiss} />
      </DialogFooter>
    </>
  );
}
