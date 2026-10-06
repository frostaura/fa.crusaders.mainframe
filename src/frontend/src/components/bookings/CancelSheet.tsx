import { useContext, useEffect, useState } from "react";
import { UNSAFE_LocationContext, matchPath } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { useToast } from "@/components/toastContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { focusFirstComplaint } from "@/components/members/saleFocus";
import { ApiError, type CancellationQuote } from "@/lib/api";
import { ADMIN_CANCEL } from "@/lib/adminCancelCopy";
import { ALREADY_CHECKED_IN_TEXT, cancellationOutcome, describeBookingError, endsCancel, provesStaleGrid } from "@/lib/bookingErrors";
import { NotSent, UnsureOutcome, refuseWhenOffline, type Reread } from "@/lib/bookingOutcome";
import { describeFailure } from "@/lib/errors";
import { playersEndpoints, type BookingDetail } from "@/lib/playersApi";
import { firstName } from "@/lib/playersNames";
import { standingShares } from "@/lib/standingShares";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { CANCEL_SHEET, RESULTS_LABEL, SPLIT_CANCEL, refusalReason } from "@/lib/bookingsCopy";
import { CANCEL_ENDED, type CancelFrom } from "@/lib/cancelSheetCopy";
import { BulkResults } from "./BulkResults";
import { MoneyRows, SendingNote, SlotList, type MoneyRow, type SlotLine } from "./SheetParts";
import { useRefusalInView } from "./useRefusalInView";
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
function failureSentence(error: unknown, from: CancelFrom): string {
  const said = error instanceof ApiError || error instanceof UnsureOutcome || error instanceof NotSent
    ? describeBookingError(error, CANCEL_SHEET.fallback, { action: "cancel" })
    : describeFailure(error, { action: CANCEL_SHEET.failedAction });
  // R19 L19-5 — a stale-screen refusal ends "The schedule behind this is up to date now."; what is
  // reloaded behind the sheet (`onStale`) is the page it was opened from, which may not be one.
  return said.replace(CANCEL_ENDED.behind.schedule, CANCEL_ENDED.behind[from]);
}

/**
 * Where the sheet was opened, read off the route (R19 L19-5): a booking's own page
 * (`/bookings/:id`, the member's and the desk's panel alike), a member's bookings at the desk, or
 * the schedule — the one place a bare render (no router) can only be.
 */
function useCancelFrom(): CancelFrom {
  // The context, not `useLocation` (which throws without a router) — ConfirmButton's way.
  const located = useContext(UNSAFE_LocationContext) as { location?: { pathname?: string } } | null;
  return cancelFromPath(located?.location?.pathname ?? "");
}

function cancelFromPath(path: string): CancelFrom {
  if (matchPath("/admin/members/:userId/bookings", path)) return "memberBookings";
  if (matchPath("/bookings/:bookingId", path) && !matchPath("/bookings/invites", path)) return "booking";
  return "schedule";
}

function useCancelFlow(props: FlowProps) {
  const { bookings, isAdmin, onClose, onBusy } = props;
  const late = useLateLanding(props.open);
  const from = useCancelFrom();
  const quotes = useCancelQuotes(bookings);
  const [waive, setWaive] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonShown, setReasonShown] = useState(false);
  // R16 X16-3 — each refused press takes the keyboard to the field that says why (the Sell sheet's
  // rule): after the commit that marks it invalid, so it lands on a field carrying its complaint.
  const [refusals, setRefusals] = useState(0);
  useEffect(() => {
    if (refusals > 0) focusFirstComplaint("[data-sheet='cancel']");
  }, [refusals]);
  const [run, setRun] = useState<CancelRun | null>(null);
  const [key] = useState(newCancelKey);
  const push = useOptionalPush();

  const single = bookings.length === 1;
  const forOthers = isAdmin && bookings.some((b) => !b.mine);
  // R15 D15-5 — a member may not cancel a booking they have checked in to (the server answers 409
  // `already_checked_in`): refused up front off the quote, never sent. The member route refuses an
  // admin's OWN booking too; only the club's route (an admin, somebody else's booking) is not.
  const readyQuotes = quotes.state.status === "ready" ? quotes.state.quotes : null;
  const refused = (b: GridBooking) => !(isAdmin && !b.mine) && readyQuotes?.get(b.bookingId)?.checkedIn === true;
  const sendable = bookings.filter((b) => !refused(b));
  // R4 A4-4: an admin cancelling somebody else's booking always says why — the member is told,
  // and it goes on the club's change record (the API refuses it without, 400 reason_required).
  const reasonNeeded = forOthers;

  const action = useAsyncAction(
    // R3 I-4: offline, nothing is sent — and the sheet says so.
    async () => {
      refuseWhenOffline();
      return cancelBookings({
        bookings: sendable, isAdmin, waive: forOthers && waive, reason, idempotencyKey: key, reread: props.reread,
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
        push?.({ tone: "success", text: cancellationOutcome(result.single.refunded, result.single.penalty, who, result.single.split, result.single.answered) });
        onClose();
      },
      failure: (error) => {
        if (provesStaleGrid(error)) props.onStale?.();
        late.sayIfGone("danger", () => failureSentence(error, from));
      },
    },
  );

  const failed = action.status === "error" ? action.error : null;
  // R18 L18-10 — refused for good (already cancelled, played, a hold, gone): nothing to press again.
  const ended = endsCancel(failed);
  // R18 L18-2 — the refusal is scrolled into view and takes the keyboard (its button may be gone).
  useRefusalInView(failed, "[data-sheet='cancel']");

  const confirm = () => {
    if (sendable.length === 0 || ended) return;
    if (reasonNeeded && reason.trim() === "") {
      setReasonShown(true);
      setRefusals((n) => n + 1);
      return;
    }
    // Told at once, not in an effect: a press on the × a frame later is refused too.
    onBusy(true);
    void action.run().finally(() => onBusy(false));
  };

  return {
    quotes, waive, setWaive, reason, setReason, reasonNeeded, forOthers, single, refused, sendable: ended ? 0 : sendable.length, ended, from,
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
        {/* R19 L19-5 — refused for good, the sheet stops asking "Cancel this booking? Here's what
            goes back…": nothing goes back and nothing is being cancelled. It says what happened. */}
        <DialogTitle>{flow.ended ? CANCEL_ENDED.title : CANCEL_SHEET.title(count)}</DialogTitle>
        <DialogDescription>{flow.ended ? CANCEL_ENDED.description : CANCEL_SHEET.description(count)}</DialogDescription>
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
            {/* R4 I4-1 — no way out while the cancel is on its way; the note says why. R18 L18-10 —
                refused for good, the booking is not being kept by anyone's choice: Done. */}
            {busy ? null : (
              <Button variant={flow.ended ? "primary" : "outline"} onClick={props.onClose}>
                {flow.ended ? CANCEL_SHEET.done : CANCEL_SHEET.keep(count)}
              </Button>
            )}
            {/* R15 D15-5 — nothing this member may cancel (checked in): no Cancel to press. */}
            {flow.sendable === 0 ? null : (
              <Button variant="danger" pending={flow.action.pending} onClick={flow.confirm}>
                {CANCEL_SHEET.confirm(flow.sendable)}
              </Button>
            )}
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
  // R18 L18-10 — refused for good: the booking stays named, the quote's figures (a cancel that
  // will not happen), the waiver, the reason and "can't be undone" go; the refusal says the rest.
  if (flow.ended) {
    return (
      <>
        <SlotList lines={bookings.map((b) => lineFor(b, undefined, false))} label={CANCEL_ENDED.title} refusedWord="" />
        <RefusalAlert failed={failed} from={flow.from} />
      </>
    );
  }
  return (
    <>
      {flow.single
        ? <SingleCancel flow={flow} booking={bookings[0]} quotes={quotes} />
        : <ManyCancel flow={flow} bookings={bookings} quotes={quotes} />}
      <WaiveAndReason flow={flow} bookings={bookings} quotes={quotes} />
      <RefusalAlert failed={failed} from={flow.from} />
      <p className="text-sm text-text-secondary">{CANCEL_SHEET.finalLine}</p>
    </>
  );
}

/** The press's refusal, marked for {@link useRefusalInView} (R18 L18-2). */
function RefusalAlert({ failed, from }: { failed: unknown; from: CancelFrom }) {
  if (!failed) return null;
  return <Alert tone="danger" data-sheet-refusal="" tabIndex={-1}>{failureSentence(failed, from)}</Alert>;
}

function consequence(quote: CancellationQuote, waived: boolean, subject: string | null) {
  if (quote.checkedIn) return { tone: "danger" as const, text: CANCEL_SHEET.checkedIn(subject) };
  if (quote.penaltyMinutes > 0 && !waived) return { tone: "warning" as const, text: CANCEL_SHEET.late(quote.penaltyPct) };
  // R14 J14-6 — a split booking's partners get their shares back; "every minute" would be false.
  return { tone: "success" as const, text: CANCEL_SHEET.free(subject, partnerNames(quote, waived)) };
}

/** The partners whose shares go back on this cancel, by name (R14 J14-6 / J14-7). */
function partnerNames(quote: CancellationQuote, waived: boolean): string[] {
  return netOf(quote, waived).partners.map((p) => p.name);
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
  const said = quote && flow.refused(booking)
    ? { tone: "warning" as const, text: ALREADY_CHECKED_IN_TEXT }
    : quote ? consequence(quote, waived, subject) : null;
  const sharesWanted = Boolean(quote?.checkedIn) && flow.forOthers && !flow.refused(booking);
  return (
    <>
      <SlotList lines={[lineFor(booking, undefined, false)]} label={CANCEL_SHEET.title(1)} refusedWord="" />
      {loading ? <span role="status" className="sr-only">{CANCEL_SHEET.quoteReading}</span> : null}
      {!loading && !quote ? <QuoteFailed retry={flow.quotes.retry} /> : null}
      {said ? <Alert tone={said.tone} live="polite">{said.text}</Alert> : null}
      {loading || quote ? <MoneyRows rows={singleMoney(quote, waived, subject)} label={CANCEL_SHEET.totalBack} /> : null}
      <SplitNote quote={quote} waived={waived} subject={subject} />
      <SharesStand bookingId={booking.bookingId} wanted={sharesWanted} organiser={booking.memberFirstName} />
    </>
  );
}

/**
 * R16 J16-7 — who keeps a paid share when the club cancels a session somebody checked in to, by the
 * booking page panel's rule (standingShares). The quote lists no partner refunds then, so the
 * booking record says who stands: read only on such a cancel, null until read and on a failed read,
 * when the sheet claims nothing about the shares.
 */
function standingReadOf(bookingId: string, d: BookingDetail) {
  const organiser = d.organiser.name?.trim() ? firstName(d.organiser.name) : null;
  return { id: bookingId, shares: standingShares(d), organiser };
}

type StandingRead = ReturnType<typeof standingReadOf>;

function useStandingShares(bookingId: string, wanted: boolean): StandingRead | null {
  const [read, setRead] = useState<StandingRead | null>(null);
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    const keep = (d: BookingDetail) => {
      if (live) setRead(standingReadOf(bookingId, d));
    };
    playersEndpoints.detail(bookingId).then(keep, () => undefined);
    return () => { live = false; };
  }, [bookingId, wanted]);
  return wanted && read?.id === bookingId ? read : null;
}

function SharesStand({ bookingId, wanted, organiser }: { bookingId: string; wanted: boolean; organiser: string | null }) {
  const read = useStandingShares(bookingId, wanted);
  if (!read || read.shares.length === 0) return null;
  // Polite: a standing fact about this cancel, landing a beat after the quote's own alert.
  return <Alert tone="info" live="polite">{ADMIN_CANCEL.sharesStand(read.shares, read.organiser ?? organiser ?? ADMIN_CANCEL.nobody)}</Alert>;
}

/** F1.13 — why "Back to you" (or "Back to Thandi", R13 J13-5) is less than was paid on a split booking. */
function SplitNote({ quote, waived, subject }: { quote: CancellationQuote | null; waived: boolean; subject: string | null }) {
  const partners = quote ? partnerNames(quote, waived) : [];
  if (partners.length === 0) return null;
  return <p className="-mt-2 px-1 text-xs text-text-secondary">{SPLIT_CANCEL.note(subject, partners)}</p>;
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
        lines={bookings.map((b) => lineFor(b, (flow.refused(b) ? refusalReason("already_checked_in") : quoteNote(loading ? undefined : quotes.get(b.bookingId) ?? null, waived)) || undefined, loading))}
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
