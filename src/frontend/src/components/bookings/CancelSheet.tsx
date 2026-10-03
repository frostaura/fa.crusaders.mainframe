import { useState } from "react";
import { Alert } from "@/components/Alert";
import { useToast } from "@/components/toastContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, type CancellationQuote } from "@/lib/api";
import { cancellationOutcome, describeBookingError, provesStaleGrid } from "@/lib/bookingErrors";
import { NotSent, UnsureOutcome, refuseWhenOffline, type Reread } from "@/lib/bookingOutcome";
import { describeFailure } from "@/lib/errors";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { CANCEL_SHEET, RESULTS_LABEL, SPLIT_CANCEL } from "@/lib/bookingsCopy";
import { BulkResults } from "./BulkResults";
import { MoneyRows, SendingNote, SlotList, type MoneyRow, type SlotLine } from "./SheetParts";
import {
  bookingFace, cancelBookings, netOf, newCancelKey, quoteNote, totalsOf, useCancelQuotes,
  type CancelRun, type QuoteMap,
} from "./cancelFlow";
import type { GridBooking } from "./types";
import { useLateLanding, useSendingGuard } from "./useSendingGuard";

/**
 * Cancelling one booking or several (R7) — the money stated in figures BEFORE the member commits,
 * read from the server's cancellation quote the moment the sheet opens.
 *
 * <p>
 * <b>Destructive, so no celebration.</b> The confirm is the danger button; on success a single
 * cancellation closes the sheet and says what moved in a toast ("35 min back to your balance,
 * 15 min kept as the late-cancellation penalty") — never a tick, which would congratulate a
 * member on losing a penalty. The way out names what it keeps: "Keep booking".
 * </p>
 *
 * <p>
 * <b>An admin cancelling for a member keeps the club's rules.</b> The member is named in every
 * sentence ("Thandi has already checked in…") so a wrong cell on a crowded grid is caught here,
 * and the penalty can be waived only with a reason, which is recorded with the waiver. A batch
 * touching other members' bookings goes through the admin bulk route with one reason for all of
 * them, which is also the sentence each member is emailed.
 * </p>
 */
export type CancelledOutcome = {
  cancelledIds: string[];
  /** True when every cancelled booking was the viewer's own — their wallet moved; re-read it. */
  ownMoneyMoved: boolean;
};

export type CancelSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookings: GridBooking[];
  isAdmin: boolean;
  onCancelled?: (outcome: CancelledOutcome) => void;
  /** A refusal proved the grid stale (booking gone, already started) — reload it behind the sheet. */
  onStale?: () => void;
  /** Re-reads the day and returns it — an unanswered cancel is checked against it (F1.1). */
  reread?: Reread;
  /** Where focus goes on close when the control that opened it has gone (R3 X-6). */
  onCloseAutoFocus?: (event: Event) => void;
  /** R4 I4-1 — told while the cancel is in flight, so the page's own ways out (system Back) wait too. */
  onBusyChange?: (busy: boolean) => void;
};

type FlowProps = CancelSheetProps & { onClose: () => void; onBusy: (busy: boolean) => void; refused: number };

export function CancelSheet(props: CancelSheetProps) {
  const { open, onOpenChange, onCloseAutoFocus, onBusyChange } = props;
  // R4 I4-1 — Keep, the ×, Escape and the scrim all wait while the cancel is on its way.
  const guard = useSendingGuard(onOpenChange, onBusyChange);
  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent data-sheet="cancel" onCloseAutoFocus={onCloseAutoFocus}>
        {props.bookings.length > 0 ? (
          <CancelFlowView {...props} onBusy={guard.setSending} refused={guard.refused} onClose={() => guard.onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The toast push when a provider is above us; null in a bare render. */
function useOptionalPush() {
  try {
    return useToast().push;
  } catch {
    return null;
  }
}

/** Its own words — never the booking's "Nothing was booked" under a failed cancel (F1.2). */
function failureSentence(error: unknown): string {
  return error instanceof ApiError || error instanceof UnsureOutcome || error instanceof NotSent
    ? describeBookingError(error, CANCEL_SHEET.fallback, { action: "cancel" })
    : describeFailure(error, { action: CANCEL_SHEET.failedAction });
}

function useCancelFlow(props: FlowProps) {
  const { bookings, isAdmin, onClose, onBusy } = props;
  const late = useLateLanding(props.open);
  const quotes = useCancelQuotes(bookings);
  const [waive, setWaive] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonShown, setReasonShown] = useState(false);
  const [run, setRun] = useState<CancelRun | null>(null);
  const [key] = useState(newCancelKey);
  const push = useOptionalPush();

  const single = bookings.length === 1;
  const forOthers = isAdmin && bookings.some((b) => !b.mine);
  // R4 A4-4: an admin cancelling somebody else's booking always says why — the member is told,
  // and it goes on the club's change record (the API refuses it without, 400 reason_required).
  const reasonNeeded = forOthers;

  const action = useAsyncAction(
    // R3 I-4: offline, nothing is sent — and the sheet says so.
    async () => {
      refuseWhenOffline();
      return cancelBookings({
        bookings, isAdmin, waive: forOthers && waive, reason, idempotencyKey: key, reread: props.reread,
        quotes: quotes.state.status === "ready" ? quotes.state.quotes : null,
      });
    },
    {
      success: (result) => {
        onBusy(false); // answered: the Done / close that follows is not a way out mid-flight
        const own = bookings.every((b) => b.mine);
        props.onCancelled?.({ cancelledIds: result.cancelledIds, ownMoneyMoved: own });
        // Gone before the answer came (a forced route): the batch's rows have nowhere to show.
        if (!result.single) late.sayIfGone("success", () => CANCEL_SHEET.landedLate(result.cancelledIds.length));
        if (!result.single) {
          setRun(result);
          return;
        }
        const [b] = bookings;
        const who = b.mine ? null : b.memberFirstName ?? "the member";
        push?.({ tone: "success", text: cancellationOutcome(result.single.refunded, result.single.penalty, who, result.single.split) });
        onClose();
      },
      failure: (error) => {
        if (provesStaleGrid(error)) props.onStale?.();
        late.sayIfGone("danger", () => failureSentence(error));
      },
    },
  );

  const confirm = () => {
    if (reasonNeeded && reason.trim() === "") {
      setReasonShown(true);
      return;
    }
    // Told at once, not in an effect: a press on the × a frame later is refused too.
    onBusy(true);
    void action.run().finally(() => onBusy(false));
  };

  return {
    quotes, waive, setWaive, reason, setReason, reasonNeeded, forOthers, single,
    reasonMissing: reasonShown && reasonNeeded && reason.trim() === "",
    action, run, confirm,
  };
}

type CancelFlow = ReturnType<typeof useCancelFlow>;

function CancelFlowView(props: FlowProps) {
  const flow = useCancelFlow(props);
  const count = props.bookings.length;
  const busy = flow.action.pending;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{CANCEL_SHEET.title(count)}</DialogTitle>
        <DialogDescription>{CANCEL_SHEET.description(count)}</DialogDescription>
      </DialogHeader>
      <DialogBody className="pb-4">
        <div className="flex flex-col gap-4">
          {flow.run ? <CancelResult run={flow.run} count={count} /> : <CancelBody flow={flow} bookings={props.bookings} />}
        </div>
      </DialogBody>
      <DialogFooter>
        <SendingNote text={busy ? CANCEL_SHEET.sending : null} refused={props.refused} />
        {flow.run ? (
          <Button onClick={props.onClose}>{CANCEL_SHEET.done}</Button>
        ) : (
          <>
            {/* R4 I4-1 — no way out while the cancel is on its way; the note says why. */}
            {busy ? null : <Button variant="outline" onClick={props.onClose}>{CANCEL_SHEET.keep(count)}</Button>}
            <Button variant="danger" pending={flow.action.pending} onClick={flow.confirm}>
              {CANCEL_SHEET.confirm(count)}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

/* ─────────────────────────────── before ─────────────────────────────── */

function lineFor(b: GridBooking, detail: string | undefined, loading: boolean): SlotLine {
  const f = bookingFace(b);
  return {
    key: b.bookingId,
    courtName: b.mine || !b.memberFirstName ? b.courtName : `${b.courtName} · ${b.memberFirstName}`,
    day: f.day, time: f.time, minutes: f.minutes,
    price: b.amountChargedMinutes,
    detail,
    detailLoading: loading,
  };
}

function CancelBody({ flow, bookings }: { flow: CancelFlow; bookings: GridBooking[] }) {
  const quotes = flow.quotes.state.status === "ready" ? flow.quotes.state.quotes : null;
  const failed = flow.action.status === "error" ? flow.action.error : null;
  return (
    <>
      {flow.single
        ? <SingleCancel flow={flow} booking={bookings[0]} quotes={quotes} />
        : <ManyCancel flow={flow} bookings={bookings} quotes={quotes} />}
      <WaiveAndReason flow={flow} bookings={bookings} quotes={quotes} />
      {failed ? <Alert tone="danger">{failureSentence(failed)}</Alert> : null}
      <p className="text-sm text-text-secondary">{CANCEL_SHEET.finalLine}</p>
    </>
  );
}

function consequence(quote: CancellationQuote, waived: boolean, subject: string | null) {
  if (quote.checkedIn) return { tone: "danger" as const, text: CANCEL_SHEET.checkedIn(subject) };
  if (quote.penaltyMinutes > 0 && !waived) return { tone: "warning" as const, text: CANCEL_SHEET.late(quote.penaltyPct) };
  return { tone: "success" as const, text: CANCEL_SHEET.free(subject) };
}

function singleMoney(quote: CancellationQuote | null, waived: boolean, subject: string | null): MoneyRow[] {
  const net = quote ? netOf(quote, waived) : null;
  const rows: MoneyRow[] = [{ term: CANCEL_SHEET.paid, value: quote?.amountChargedMinutes ?? null }];
  if (quote && quote.penaltyMinutes > 0 && !quote.checkedIn) {
    rows.push(waived
      ? { term: CANCEL_SHEET.penaltyWaived, value: 0 }
      : { term: CANCEL_SHEET.penalty(quote.penaltyPct), value: quote.penaltyMinutes, debit: true });
  }
  // F1.13 — each partner's share goes back to them; the organiser keeps the rest.
  for (const p of net?.partners ?? []) rows.push({ term: SPLIT_CANCEL.partnerBack(p.name), value: p.minutes });
  const split = Boolean(net?.partners.length);
  const term = split && !subject ? SPLIT_CANCEL.youKeep : CANCEL_SHEET.goesBack(subject);
  rows.push({ term, value: net?.back ?? null, total: true });
  return rows;
}

function SingleCancel({ flow, booking, quotes }: { flow: CancelFlow; booking: GridBooking; quotes: QuoteMap | null }) {
  const quote = quotes ? quotes.get(booking.bookingId) ?? null : null;
  const loading = flow.quotes.state.status === "loading";
  const waived = flow.forOthers && flow.waive;
  const subject = booking.mine ? null : booking.memberFirstName ?? "This member";
  const said = quote ? consequence(quote, waived, subject) : null;
  return (
    <>
      <SlotList lines={[lineFor(booking, undefined, false)]} label={CANCEL_SHEET.title(1)} refusedWord="" />
      {loading ? <span role="status" className="sr-only">{CANCEL_SHEET.quoteReading}</span> : null}
      {!loading && !quote ? <QuoteFailed retry={flow.quotes.retry} /> : null}
      {said ? <Alert tone={said.tone} live="polite">{said.text}</Alert> : null}
      {loading || quote ? <MoneyRows rows={singleMoney(quote, waived, subject)} label={CANCEL_SHEET.totalBack} /> : null}
      <SplitNote quote={quote} waived={waived} />
    </>
  );
}

/** F1.13 — why "Back to you" is less than was paid on a split booking. */
function SplitNote({ quote, waived }: { quote: CancellationQuote | null; waived: boolean }) {
  if (!quote || netOf(quote, waived).partners.length === 0) return null;
  return <p className="-mt-2 px-1 text-xs text-text-secondary">{SPLIT_CANCEL.note}</p>;
}

function QuoteFailed({ retry }: { retry: () => void }) {
  return (
    <div className="grid justify-items-start gap-3">
      <Alert tone="warning" className="w-full">{CANCEL_SHEET.quoteFailed}</Alert>
      <Button variant="outline" onClick={retry}>{CANCEL_SHEET.retry}</Button>
    </div>
  );
}

function ManyCancel({ flow, bookings, quotes }: { flow: CancelFlow; bookings: GridBooking[]; quotes: QuoteMap | null }) {
  const loading = quotes === null;
  const waived = flow.forOthers && flow.waive;
  const totals = totalsOf(bookings, quotes, waived);
  const rows: MoneyRow[] = [{ term: CANCEL_SHEET.totalBack, value: loading ? null : totals.back, total: true }];
  if (totals.penalty > 0) rows.unshift({ term: CANCEL_SHEET.penalty(penaltyPctOf(quotes)), value: totals.penalty, debit: true });
  return (
    <>
      <SlotList
        lines={bookings.map((b) => lineFor(b, quoteNote(loading ? undefined : quotes.get(b.bookingId) ?? null, waived) || undefined, loading))}
        label={CANCEL_SHEET.title(bookings.length)}
        refusedWord=""
      />
      {loading ? <span role="status" className="sr-only">{CANCEL_SHEET.quoteReading}</span> : null}
      <MoneyRows rows={rows} label={CANCEL_SHEET.totalBack} />
    </>
  );
}

function penaltyPctOf(quotes: QuoteMap | null): number {
  for (const q of quotes?.values() ?? []) if (q && q.penaltyMinutes > 0) return q.penaltyPct;
  return 0;
}

/** The admin's waiver and the reason that goes with it — only where there is a penalty to waive. */
function WaiveAndReason({ flow, bookings, quotes }: { flow: CancelFlow; bookings: GridBooking[]; quotes: QuoteMap | null }) {
  if (!flow.forOthers) return null;
  const totals = totalsOf(bookings, quotes, false);
  const canWaive = totals.anyPenalty;
  return (
    <div className="grid gap-4">
      {canWaive ? (
        <label className="flex min-h-touch items-start gap-3 rounded-xl border border-border bg-bg-surface p-4">
          <Checkbox checked={flow.waive} onCheckedChange={(v) => flow.setWaive(v === true)} className="mt-0.5" />
          <span className="grid gap-0.5 text-sm">
            <span className="font-semibold text-text-primary">
              {flow.single ? CANCEL_SHEET.waive(totals.penalty) : CANCEL_SHEET.waiveMany}
            </span>
            <span className="text-text-secondary">{CANCEL_SHEET.waiveHint}</span>
          </span>
        </label>
      ) : null}
      {flow.reasonNeeded ? (
        <Field invalid={flow.reasonMissing}>
          <FieldLabel>{CANCEL_SHEET.reasonLabel}</FieldLabel>
          <Textarea
            rows={2}
            maxLength={512}
            value={flow.reason}
            placeholder={CANCEL_SHEET.reasonPlaceholder}
            onChange={(e) => flow.setReason(e.target.value)}
          />
          <FieldDescription>{flow.single ? CANCEL_SHEET.reasonHint : CANCEL_SHEET.reasonHintMany}</FieldDescription>
          {flow.reasonMissing ? <FieldError>{CANCEL_SHEET.reasonMissing}</FieldError> : null}
        </Field>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────── after (several) ─────────────────────────────── */

function CancelResult({ run, count }: { run: CancelRun; count: number }) {
  const done = run.cancelledIds.length;
  return (
    <>
      <p role="status" className="text-base font-semibold text-text-primary">
        {done === 0 ? CANCEL_SHEET.noneCancelledTitle : CANCEL_SHEET.cancelledTitle(done, count)}
      </p>
      <BulkResults rows={run.rows} label={RESULTS_LABEL.cancel} />
    </>
  );
}
