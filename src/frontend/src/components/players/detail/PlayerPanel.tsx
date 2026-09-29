import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Section } from "@/components/ui/page-shell";
import { useBalance } from "@/lib/balance";
import { formatCredits } from "@/lib/utils";
import { playersEndpoints, type BookingDetail, type DetailPlayer } from "@/lib/playersApi";
import { DETAIL_PLAYER, playersRefusal, playersWhen } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { mySeat } from "./detailModel";
import type { Notice } from "./useOrganiserHands";

/**
 * A partner's own corner of the page: their share, what they have paid, and their hand —
 * review the share (the invites lane's accept sheet, by link), pull out, or decline. Accepting
 * is never done here: one accept sheet in the product, with the figure the partner is shown.
 */
type Props = { detail: BookingDetail; reload: () => void; say: (notice: Notice) => void };

type Leave = "withdraw" | "decline";

export function PlayerPanel({ detail, reload, say }: Props) {
  const seat = mySeat(detail);
  const [asking, setAsking] = useState<Leave | null>(null);
  if (!seat || detail.viewer.role !== "player") return null;
  const { permissions } = detail;
  return (
    <Section title={DETAIL_PLAYER.title}>
      <ShareFigures seat={seat} />
      <div className="flex flex-wrap items-center gap-3">
        {permissions.can_accept ? (
          <Button asChild><Link to={`/invites/${seat.participant_id}`}>{DETAIL_PLAYER.review}</Link></Button>
        ) : null}
        {permissions.can_decline ? (
          <Button variant="outline" onClick={() => setAsking("decline")}>{DETAIL_PLAYER.decline}</Button>
        ) : null}
        {permissions.can_withdraw ? (
          <Button variant="danger-soft" onClick={() => setAsking("withdraw")}>{DETAIL_PLAYER.withdraw}</Button>
        ) : null}
      </div>
      <WithdrawLine detail={detail} seat={seat} />
      {asking ? (
        <LeaveDialog kind={asking} detail={detail} seat={seat} onClose={() => setAsking(null)} reload={reload} say={say} />
      ) : null}
    </Section>
  );
}

function ShareFigures({ seat }: { seat: DetailPlayer }) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-2 rounded-xl border border-border bg-bg-surface p-4 text-sm">
        <Figure term={DETAIL_PLAYER.share} value={seat.share_credits} />
        <Figure term={DETAIL_PLAYER.paid} value={seat.paid_credits} />
        <Figure term={DETAIL_PLAYER.toPay} value={seat.unpaid_credits} strong />
      </dl>
      {seat.needs_consent ? <Alert tone="warning" live="polite">{DETAIL_PLAYER.askedAgain(formatCredits(seat.share_credits))}</Alert> : null}
      {seat.status === "accepted" && seat.unpaid_credits <= 0 && !seat.needs_consent ? (
        <p className="text-sm text-success-strong">{DETAIL_PLAYER.paidAll}</p>
      ) : null}
    </div>
  );
}

function Figure({ term, value, strong = false }: { term: string; value: number; strong?: boolean }) {
  return (
    <div className={strong ? "flex justify-between gap-4 border-t border-border pt-2 font-semibold text-text-primary" : "flex justify-between gap-4 text-text-secondary"}>
      <dt>{term}</dt>
      <dd className="tabular-nums">{formatCredits(value)}</dd>
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

const LEAVE = {
  withdraw: {
    title: DETAIL_PLAYER.withdrawTitle, body: DETAIL_PLAYER.withdrawBody, confirm: DETAIL_PLAYER.withdrawConfirm,
    keep: DETAIL_PLAYER.withdrawKeep, done: DETAIL_PLAYER.withdrawn, action: DETAIL_PLAYER.withdrawAction,
  },
  decline: {
    title: DETAIL_PLAYER.declineTitle, body: DETAIL_PLAYER.declineBody, confirm: DETAIL_PLAYER.declineConfirm,
    keep: DETAIL_PLAYER.declineKeep, done: DETAIL_PLAYER.declined, action: DETAIL_PLAYER.declineAction,
  },
} as const;

type LeaveProps = Props & { kind: Leave; seat: DetailPlayer; onClose: () => void };

function LeaveDialog(props: LeaveProps) {
  const { kind, detail, seat, onClose } = props;
  const copy = LEAVE[kind];
  const { refresh } = useBalance();
  const toast = useToast();
  const navigate = useNavigate();
  const leave = useAsyncAction(
    () => (kind === "withdraw" ? playersEndpoints.withdraw : playersEndpoints.decline)(detail.booking_id, seat.participant_id ?? ""),
    {
      // R1 F2.9 — off the game, this page is a 404 to them: re-reading it put "Booking not found"
      // beside the success. Back to Bookings instead, with the outcome said there.
      success: () => {
        onClose();
        toast.push({ tone: "success", text: copy.done });
        void refresh();
        navigate("/bookings", { replace: true });
      },
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
            <Alert tone="danger">{playersRefusal(leave.error, { action: copy.action })}</Alert>
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
