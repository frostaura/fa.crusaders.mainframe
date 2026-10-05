import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { useToast } from "@/components/toastContext";
import { Button } from "@/components/ui/button";
import { ContextBar } from "@/components/ui/context-bar";
import { useMediaQuery } from "@/components/ui/use-media-query";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Section } from "@/components/ui/page-shell";
import { useBalance } from "@/lib/useBalance";
import { Minutes } from "@/components/Minutes";
import { minutesSpoken } from "@/lib/minutes";
import { playersEndpoints, type BookingDetail, type DetailPlayer } from "@/lib/playersApi";
import { UnsureOutcome } from "@/lib/lostReply";
import { DETAIL_CANCELLED, DETAIL_COPY, DETAIL_NO_SHOW, DETAIL_PLAYER, PLAYERS_LOST, PLAYERS_UNSURE, playersRefusal, playersWhen } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { isCancelled, isNoShow, keepAmounts, mySeat } from "./detailModel";
import { leaveOrProve } from "./detailReadBack";
import type { Notice } from "./useOrganiserHands";

/**
 * A partner's own corner of the page: their share, what they have paid, and their hand —
 * review the share (the invites lane's accept sheet, by link), pull out, or decline. Accepting
 * is never done here: one accept sheet in the product, with the figure the partner is shown.
 */
type Props = { detail: BookingDetail; reload: () => void; say: (notice: Notice) => void };

type Leave = "withdraw" | "decline";

/** Where the organiser's Invite moves inline (BookingDetail's `LG_UP`): the same switch for the invitee's answer. */
const LG_UP = "(min-width: 1024px)";

export function PlayerPanel({ detail, reload, say }: Props) {
  const seat = mySeat(detail);
  const [asking, setAsking] = useState<Leave | null>(null);
  // R5 F5 — the invitee's answer (review the share, decline) is docked in thumb reach on a phone,
  // like the organiser's Invite; inline from lg. One place each, chosen in JS (a CSS-hidden twin
  // is still a second button to a screen reader).
  const wide = useMediaQuery(LG_UP);
  if (!seat || detail.viewer.role !== "player") return null;
  if (isCancelled(detail)) return <CancelledShare seat={seat} />;
  if (isNoShow(detail)) return <NoShowShare seat={seat} />;
  const { permissions } = detail;
  const review = permissions.can_accept ? (
    <Button asChild><Link to={`/invites/${seat.participant_id}`}>{DETAIL_PLAYER.review}</Link></Button>
  ) : null;
  const decline = permissions.can_decline ? (
    <Button variant="outline" onClick={() => setAsking("decline")}>{DETAIL_PLAYER.decline}</Button>
  ) : null;
  const docked = !wide && (review !== null || decline !== null);
  return (
    <Section title={DETAIL_PLAYER.title}>
      <ShareFigures seat={seat} />
      <div className="flex flex-wrap items-center gap-3">
        {docked ? null : review}
        {docked ? null : decline}
        {permissions.can_withdraw ? (
          <Button variant="danger-soft" onClick={() => setAsking("withdraw")}>{DETAIL_PLAYER.withdraw}</Button>
        ) : null}
      </div>
      {docked ? (
        <ContextBar position="bottom" until="lg" label={DETAIL_COPY.answerLabel} actions={decline} primary={review} />
      ) : null}
      <WithdrawLine detail={detail} seat={seat} />
      {asking ? (
        <LeaveDialog kind={asking} detail={detail} seat={seat} onClose={() => setAsking(null)} reload={reload} say={say} />
      ) : null}
    </Section>
  );
}

/** R1 F2.10 — a cancelled game asks nothing more: what they paid stands, or there is nothing to pay. */
function CancelledShare({ seat }: { seat: DetailPlayer }) {
  return (
    <Section title={DETAIL_PLAYER.title}>
      <p className="text-sm text-text-secondary" data-cancelled-share="">
        {seat.paid_minutes > 0 ? keepAmounts(DETAIL_CANCELLED.partnerPaid(minutesSpoken(seat.paid_minutes))) : DETAIL_CANCELLED.partnerNothing}
      </p>
    </Section>
  );
}

/**
 * R5 M5-3 — nobody checked in: the share came down with the no-show penalty and the rest came
 * back. Nothing is asked any more — no "Still to pay", no "all paid up", no Review.
 */
function NoShowShare({ seat }: { seat: DetailPlayer }) {
  const back = seat.returned_minutes ?? 0;
  const paidIn = seat.paid_minutes + back;
  let words: string = DETAIL_NO_SHOW.partnerNothing;
  if (back > 0) words = DETAIL_NO_SHOW.partnerBack(minutesSpoken(paidIn), minutesSpoken(back), minutesSpoken(seat.paid_minutes));
  else if (paidIn > 0) words = DETAIL_NO_SHOW.partnerPaid(minutesSpoken(paidIn));
  return (
    <Section title={DETAIL_PLAYER.title}>
      <p className="text-sm text-text-secondary" data-no-show-share="">{keepAmounts(words)}</p>
    </Section>
  );
}

/**
 * R14 J14-9 — "went up" only when the seat had agreed to something smaller; a seat the club
 * accepted without asking (nothing agreed) is being asked for the first time.
 */
function consentAsk(seat: DetailPlayer): string {
  const share = minutesSpoken(seat.share_minutes);
  return seat.consented_minutes > 0 ? DETAIL_PLAYER.askedAgain(share) : DETAIL_PLAYER.askedFirst(share);
}

function ShareFigures({ seat }: { seat: DetailPlayer }) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-2 rounded-xl border border-border bg-bg-surface p-4 text-sm">
        <Figure term={DETAIL_PLAYER.share} value={seat.share_minutes} />
        <Figure term={DETAIL_PLAYER.paid} value={seat.paid_minutes} />
        <Figure term={DETAIL_PLAYER.toPay} value={seat.unpaid_minutes} strong />
      </dl>
      {seat.needs_consent ? <Alert tone="warning" live="polite">{keepAmounts(consentAsk(seat))}</Alert> : null}
      {seat.status === "accepted" && seat.unpaid_minutes <= 0 && !seat.needs_consent ? (
        <p className="text-sm text-success-strong">{DETAIL_PLAYER.paidAll}</p>
      ) : null}
    </div>
  );
}

/**
 * R5 V5-7 — the term and its figure share a row while they fit; the figure wraps under the term as
 * a whole when they do not (390 / 200 %), never "1 h / 30 min" split across two lines.
 */
function Figure({ term, value, strong = false }: { term: string; value: number; strong?: boolean }) {
  const pair = "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5";
  return (
    <div className={strong ? `${pair} border-t border-border pt-2 font-semibold text-text-primary` : `${pair} text-text-secondary`}>
      <dt className="min-w-0 break-words">{term}</dt>
      <dd className="ml-auto whitespace-nowrap"><Minutes value={value} /></dd>
    </div>
  );
}

/** When pulling out closes — said before it does, and after. */
function WithdrawLine({ detail, seat }: { detail: BookingDetail; seat: DetailPlayer }) {
  if (seat.status !== "accepted" || detail.status !== "booked") return null;
  const when = playersWhen(detail.permissions.withdraw_closes_at);
  return (
    <p className="text-sm text-text-secondary">
      {detail.permissions.can_withdraw ? DETAIL_PLAYER.withdrawUntil(when) : DETAIL_PLAYER.withdrawClosed(when)}
    </p>
  );
}

/** R12 X12-4 — the pull-out's words carry the figure the seat paid; a decline moves nothing. */
function leaveCopy(kind: Leave, paid: number) {
  if (kind === "withdraw") {
    return {
      title: DETAIL_PLAYER.withdrawTitle, body: keepAmounts(DETAIL_PLAYER.withdrawBody(paid)), confirm: DETAIL_PLAYER.withdrawConfirm,
      keep: DETAIL_PLAYER.withdrawKeep, done: DETAIL_PLAYER.withdrawn(paid), action: DETAIL_PLAYER.withdrawAction,
      unsure: PLAYERS_UNSURE.withdraw,
    };
  }
  return {
    title: DETAIL_PLAYER.declineTitle, body: DETAIL_PLAYER.declineBody, confirm: DETAIL_PLAYER.declineConfirm,
    keep: DETAIL_PLAYER.declineKeep, done: DETAIL_PLAYER.declined, action: DETAIL_PLAYER.declineAction,
    unsure: PLAYERS_UNSURE.decline,
  };
}

type LeaveProps = Props & { kind: Leave; seat: DetailPlayer; onClose: () => void };

function LeaveDialog(props: LeaveProps) {
  const { kind, detail, seat, onClose, reload } = props;
  const copy = leaveCopy(kind, seat.paid_minutes);
  const { refresh } = useBalance();
  const toast = useToast();
  const navigate = useNavigate();
  // R3 lost-reply audit — a lost reply is read back off the member's own seat.
  const leave = useAsyncAction(
    () => leaveOrProve(seat.participant_id ?? "", () =>
      (kind === "withdraw" ? playersEndpoints.withdraw : playersEndpoints.decline)(detail.booking_id, seat.participant_id ?? "")),
    {
      // R1 F2.9 — off the game, this page is a 404 to them: re-reading it put "Booking not found"
      // beside the success. Back to Bookings instead, with the outcome said there.
      success: ({ proven }) => {
        onClose();
        toast.push({ tone: "success", text: proven ? PLAYERS_LOST(copy.done) : copy.done });
        void refresh();
        navigate("/bookings", { replace: true });
      },
      failure: (error) => { if (error instanceof UnsureOutcome) { reload(); void refresh(); } },
    },
  );
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !leave.pending) onClose(); }}>
      <DialogContent data-dialog={`${kind}-seat`}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {leave.error ? (
          <DialogBody>
            <Alert tone="danger">{playersRefusal(leave.error, { action: copy.action, unsure: copy.unsure })}</Alert>
          </DialogBody>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{copy.keep}</Button>
          <Button variant="danger" pending={leave.pending} onClick={() => void leave.run()}>{copy.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
