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
import { UnsureOutcome } from "@/lib/lostReply";
import { DETAIL_ADMIN, firstName, PLAYERS_LOST, PLAYERS_UNSURE, playersRefusal, refusalCode } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { seatName, type AdminAct } from "../detail/detailModel";
import { seatWriteOrProve } from "../detail/detailReadBack";
import type { Notice } from "../detail/useOrganiserHands";
import { useMenuReturnFocus } from "../../members/useMenuReturnFocus";
import { ACTS, overdraftSentence } from "./adminActs";
import { useComplaintFocus } from "./complaintFocus";

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
  /** Read the booking again — a lost reply that did not land, or could not be checked (R3). */
  onStale?: () => void;
};

function useActFlow(props: Props) {
  const { detail, player, act, onDone, onStale } = props;
  const spec = ACTS[act];
  const [reason, setReason] = useState("");
  const [authorised, setAuthorised] = useState(false);
  const [asked, setAsked] = useState(spec.alwaysOverdraft);
  const [tried, setTried] = useState(false);
  /** R16 X16-3 — confirms refused for a missing reason or go-ahead; each one moves the keyboard to it. */
  const [refused, setRefused] = useState(0);
  /** The server's `overdraft_not_authorised`, kept: its figures name the shortfall while the resend runs. */
  const [lastRefusal, setLastRefusal] = useState<unknown>(null);
  const name = seatName(player, detail.players);
  // R3 lost-reply audit — a lost reply is read back off the seat before anything is said.
  const run = useAsyncAction(
    () => seatWriteOrProve(detail.booking_id, player, () => spec.call({
      bookingId: detail.booking_id, participantId: player.participant_id ?? "", reason: reason.trim(), allowNegativeBalance: authorised,
    }), spec.landed),
    {
      success: ({ value, proven }) => {
        const text = spec.done(name, value, firstName(detail.organiser.name));
        onDone({ tone: "success", text: proven ? PLAYERS_LOST(text) : text });
      },
      failure: (error) => {
        if (error instanceof UnsureOutcome) onStale?.();
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
    if (reason.trim() === "" || (asked && !authorised)) {
      setRefused((n) => n + 1);
      return;
    }
    void run.run();
  };
  useComplaintFocus(refused, `[data-dialog='admin-${act}']`);
  return { spec, name, reason, setReason, authorised, setAuthorised, asked, reasonMissing, authMissing, run, confirm, lastRefusal };
}

type Flow = ReturnType<typeof useActFlow>;

export function AdminActDialog(props: Props) {
  const flow = useActFlow(props);
  const { spec, name, run } = flow;
  const overdraftAsk = refusalCode(run.error) === "overdraft_not_authorised";
  const backToSeat = useMenuReturnFocus(() => seatMenuOf(props.player));
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !run.pending) props.onClose(); }}>
      <DialogContent data-dialog={`admin-${props.act}`} onCloseAutoFocus={backToSeat}>
        <DialogHeader>
          <DialogTitle>{spec.title(name)}</DialogTitle>
          <DialogDescription>{`${actBody(props)} ${DETAIL_ADMIN.changeLog}`}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <ReasonField flow={flow} />
          {flow.asked ? <Overdraft flow={flow} {...props} /> : null}
          {run.error && !overdraftAsk ? (
            <Alert tone="danger">{playersRefusal(run.error, { action: DETAIL_ADMIN.action, unsure: PLAYERS_UNSURE.admin(name) })}</Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>{DETAIL_ADMIN.cancel}</Button>
          <Button variant={spec.tone === "danger" ? "danger" : "primary"} pending={run.pending} onClick={flow.confirm}>{spec.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * R7 J7-9 — the club's Remove names the money: what goes back to the player from whose balance,
 * and how much the organiser's cost rises. The static sentence stands where a figure is missing.
 */
function actBody({ act, player, detail }: Props): string {
  const spec = ACTS[act];
  if (act !== "remove" || typeof player.paid_minutes !== "number" || typeof player.share_minutes !== "number") return spec.body;
  return DETAIL_ADMIN.removeBodyFor({
    paid: player.paid_minutes, share: player.share_minutes, organiser: firstName(detail.organiser.name),
  });
}

/**
 * R7 X7-1 — where focus goes when an act's dialog closes. It was opened from the seat's Admin menu,
 * whose item unmounted with the menu, so the surface fell back to <main>: the seat's own Admin
 * button, or — once a remove has taken the seat away — another seat's, or the page's heading.
 */
function seatMenuOf(player: DetailPlayer): HTMLElement | null {
  const own = player.participant_id
    ? document.querySelector<HTMLElement>(`[data-admin-seat-menu="${CSS.escape(player.participant_id)}"]`)
    : null;
  return own ?? document.querySelector<HTMLElement>("[data-admin-seat-menu]") ?? headingOfPage();
}

function headingOfPage(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>("main h1");
  if (heading && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  return heading;
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
  const missingId = useId();
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
        <Checkbox
          id={id} checked={flow.authorised} onCheckedChange={(v) => flow.setAuthorised(v === true)} className="mt-0.5"
          aria-invalid={flow.authMissing || undefined} aria-describedby={flow.authMissing ? missingId : undefined}
        />
        <span className="font-semibold">{sentence}</span>
      </label>
      {flow.authMissing ? <p id={missingId} className="text-sm font-semibold">{DETAIL_ADMIN.overdraftMissing}</p> : null}
    </div>
  );
}
