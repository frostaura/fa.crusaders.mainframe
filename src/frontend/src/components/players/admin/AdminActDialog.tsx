import { useId, useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Warning } from "@/components/ui/icons";
import { Textarea } from "@/components/ui/textarea";
import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";
import { DETAIL_ADMIN, firstName, playersRefusal, refusalCode } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { seatName, type AdminAct } from "../detail/detailModel";
import type { Notice } from "../detail/useOrganiserHands";
import { ACTS, overdraftSentence } from "./adminActs";

/**
 * One god-mode act on one seat, with its reason — required, because every one lands in the
 * change log — and, where money may take someone below zero, the explicit go-ahead.
 *
 * <p>
 * <b>Collect always asks.</b> It is the one path that may take a partner below zero or collect
 * from a lapsed seat, so the box is on the dialog from the start and the call sends
 * `allowNegativeBalance` on purpose. <b>Remove and settle ask when the server does</b>: after the
 * share deadline a return can take the organiser below zero, the server answers
 * `overdraft_not_authorised`, and the same box appears; ticking it resends with the flag.
 * </p>
 */
type Props = {
  detail: BookingDetail;
  player: DetailPlayer;
  act: AdminAct;
  onClose: () => void;
  onDone: (notice: Notice) => void;
};

function useActFlow(props: Props) {
  const { detail, player, act, onDone } = props;
  const spec = ACTS[act];
  const [reason, setReason] = useState("");
  const [authorised, setAuthorised] = useState(false);
  const [asked, setAsked] = useState(spec.alwaysOverdraft);
  const [tried, setTried] = useState(false);
  /** The server's `overdraft_not_authorised`, kept: its figures name the shortfall while the resend runs. */
  const [lastRefusal, setLastRefusal] = useState<unknown>(null);
  const name = seatName(player, detail.players);
  const run = useAsyncAction(
    () => spec.call({
      bookingId: detail.booking_id, participantId: player.participant_id ?? "", reason: reason.trim(), allowNegativeBalance: authorised,
    }),
    {
      success: (answer) => onDone({ tone: "success", text: spec.done(name, answer, firstName(detail.organiser.name)) }),
      failure: (error) => {
        if (!spec.mayOverdraft || refusalCode(error) !== "overdraft_not_authorised") return;
        setAsked(true);
        setLastRefusal(error);
      },
    },
  );
  const reasonMissing = tried && reason.trim() === "";
  const authMissing = tried && asked && !authorised;
  const confirm = () => {
    setTried(true);
    if (reason.trim() === "" || (asked && !authorised)) return;
    void run.run();
  };
  return { spec, name, reason, setReason, authorised, setAuthorised, asked, reasonMissing, authMissing, run, confirm, lastRefusal };
}

type Flow = ReturnType<typeof useActFlow>;

export function AdminActDialog(props: Props) {
  const flow = useActFlow(props);
  const { spec, name, run } = flow;
  const overdraftAsk = refusalCode(run.error) === "overdraft_not_authorised";
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !run.pending) props.onClose(); }}>
      <DialogContent data-dialog={`admin-${props.act}`}>
        <DialogHeader>
          <DialogTitle>{spec.title(name)}</DialogTitle>
          <DialogDescription>{`${spec.body} ${DETAIL_ADMIN.changeLog}`}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <ReasonField flow={flow} />
          {flow.asked ? <Overdraft flow={flow} {...props} /> : null}
          {run.error && !overdraftAsk ? <Alert tone="danger">{playersRefusal(run.error, { action: DETAIL_ADMIN.action })}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>{DETAIL_ADMIN.cancel}</Button>
          <Button variant={spec.tone === "danger" ? "danger" : "primary"} pending={run.pending} onClick={flow.confirm}>{spec.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReasonField({ flow }: { flow: Flow }) {
  return (
    <Field invalid={flow.reasonMissing}>
      <FieldLabel>{DETAIL_ADMIN.reasonLabel}</FieldLabel>
      <Textarea
        rows={2}
        maxLength={512}
        required
        value={flow.reason}
        placeholder={DETAIL_ADMIN.reasonPlaceholder}
        onChange={(e) => flow.setReason(e.target.value)}
      />
      <FieldDescription>{DETAIL_ADMIN.reasonHint}</FieldDescription>
      {flow.reasonMissing ? <FieldError>{DETAIL_ADMIN.reasonMissing}</FieldError> : null}
    </Field>
  );
}

/** The god-mode go-ahead: a warning that says who goes below zero, and a box the admin ticks. */
function Overdraft(props: Props & { flow: Flow }) {
  const { flow, detail, player, act } = props;
  const id = useId();
  const sentence = overdraftSentence(act, player, detail, flow.lastRefusal);
  return (
    <div data-god-mode="" className="flex flex-col gap-3 rounded-xl border border-warning-strong/30 bg-warning-soft p-4 text-warning-strong">
      <p className="flex items-start gap-3 text-sm">
        <Warning size={20} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="grid gap-0.5">
          <span className="font-semibold">{DETAIL_ADMIN.overdraftTitle}</span>
          {act === "collect" ? null : <span role="status">{DETAIL_ADMIN.overdraftAsked}</span>}
        </span>
      </p>
      <label htmlFor={id} className="flex min-h-touch items-start gap-3 rounded-lg bg-bg-surface p-3 text-sm text-text-primary">
        <Checkbox id={id} checked={flow.authorised} onCheckedChange={(v) => flow.setAuthorised(v === true)} className="mt-0.5" />
        <span className="font-semibold">{sentence}</span>
      </label>
      {flow.authMissing ? <p className="text-sm font-semibold">{DETAIL_ADMIN.overdraftMissing}</p> : null}
    </div>
  );
}
